/**
 * services/playerService.js
 * Player stats updates, refunds, active-room lookups, and forfeit handling.
 */

const logger = require('../logger');
const context = require('../context');
const User = require('../models/User');
const PrizeCycle = require('../models/PrizeCycle');
const CycleStat = require('../models/CycleStat');
const { fromAtomicUnits, formatUSDC } = require('../utils/usdcUtils');
const { getCleanActiveRooms, getGameRoom, deleteGameRoom, logGameRoomsState } = require('./roomManager');
const { acquireIdempotencyLock } = require('../utils/idempotency');
const { alertManager } = require('../config/alerts');
const { GAME_MODES } = require('../config/constants');

// ─── Virtual balance refund ───────────────────────────────────────────────────

async function refundToVirtualBalance(walletAddress, amount, reason) {
    try {
        const refundAmount = fromAtomicUnits(amount);
        const user = await User.findOneAndUpdate(
            { walletAddress },
            { $inc: { virtualBalance: refundAmount } },
            { new: true, upsert: true }
        );
        logger.info(`💰 REFUNDED ${formatUSDC(amount)} to ${walletAddress}. Reason: ${reason}`, { newBalance: user.virtualBalance });

        if (!global.refundMetrics) {
            global.refundMetrics = { total: 0, totalAmount: 0, byReason: {}, failed: 0 };
        }
        global.refundMetrics.total++;
        global.refundMetrics.totalAmount += refundAmount;
        global.refundMetrics.byReason[reason] = (global.refundMetrics.byReason[reason] || 0) + 1;
        return true;
    } catch (err) {
        logger.error(`❌ CRITICAL: Failed to refund ${walletAddress}:`, err);
        if (global.refundMetrics) global.refundMetrics.failed++;
        alertManager.sendAlert({
            severity: 'critical', category: 'refund_failed',
            message: `URGENT: Failed to refund ${fromAtomicUnits(amount)} USDC to ${walletAddress}`,
            details: { walletAddress, amount, reason, error: err.message },
        });
        return false;
    }
}

// ─── Player stats update ──────────────────────────────────────────────────────

async function updatePlayerStats(players, roomData) {
    logger.info('Updating stats for all players:', players);
    const { winner, gameMode } = roomData;

    if (gameMode !== GAME_MODES.RANKED && gameMode !== GAME_MODES.TOURNAMENT) {
        logger.info('Practice game — skipping leaderboard stat update');
        return;
    }

    // ── Subscription model: no immediate payout. Record win/loss only. ──────────
    // Prizes are distributed at end of the weekly cycle by the admin.
    const cycle = await PrizeCycle.getOrCreateActive();

    for (const player of players) {
        if (player.isBot || !player.username) continue;
        const isWinner = player.username === winner;

        await User.findOneAndUpdate(
            { walletAddress: player.username },
            {
                $inc: {
                    gamesPlayed:    1,
                    correctAnswers: player.score || 0,
                    wins:           isWinner ? 1 : 0,
                    losses:         isWinner ? 0 : 1,
                },
                $set: { lastActiveCycleId: cycle._id },
            },
            { upsert: true, new: true }
        );

        await CycleStat.findOneAndUpdate(
            { walletAddress: player.username, cycleId: cycle._id },
            {
                $inc: {
                    wins:        isWinner ? 1 : 0,
                    losses:      isWinner ? 0 : 1,
                    gamesPlayed: 1,
                },
            },
            { upsert: true }
        );
        logger.info(`Stats updated: ${player.username} | winner=${isWinner} | cycle=${cycle._id}`);
    }
}

// ─── Active room lookup (reconnect / orphan recovery) ────────────────────────

async function findPlayerActiveRoom(walletAddress) {
    try {
        const roomIds = await getCleanActiveRooms();
        logger.info(`[ROOM_SEARCH] Checking ${roomIds.length} active rooms for ${walletAddress}`);
        for (const roomId of roomIds) {
            const room = await getGameRoom(roomId);
            if (!room || room.isDeleted) continue;
            const player = room.players.find(p => p.username === walletAddress);
            if (player) {
                logger.info(`[ROOM_SEARCH] Found player ${walletAddress} in room ${roomId}`);
                return { roomId, room, player };
            }
        }
        logger.info(`[ROOM_SEARCH] No active room found for ${walletAddress}`);
        return null;
    } catch (error) {
        logger.error(`[ROOM_SEARCH] Error finding active room for ${walletAddress}:`, error);
        return null;
    }
}

// ─── Forfeit / disconnect win ─────────────────────────────────────────────────

async function handlePlayerLeftWin(roomId, remainingPlayer, disconnectedPlayer, betAmount, botOpponent, allPlayers) {
    const io = context.io;
    try {
        const room = await getGameRoom(roomId);

        io.to(roomId).emit('gameOverForfeit', {
            winner:              remainingPlayer.username,
            disconnectedPlayer:  disconnectedPlayer.username,
            betAmount,
            botOpponent,
            gameMode:    room?.gameMode    || null,
            tournamentId: room?.tournamentId || null,
            message: `${disconnectedPlayer.username} left the game. ${remainingPlayer.username} wins by forfeit!`,
        });

        // Tournament stats are updated inside processClaimedMatchResult after match validation
        if (room?.gameMode !== GAME_MODES.TOURNAMENT) {
            await updatePlayerStats(allPlayers, {
                winner:      remainingPlayer.username,
                botOpponent,
                betAmount,
                gameMode:    room?.gameMode,
            });
        }

        // Advance tournament bracket on forfeit
        if (room?.gameMode === GAME_MODES.TOURNAMENT && room.tournamentId && room.matchId && context.tournamentService) {
            const forfeitLockKey = `tournamentGameOver:${room.matchId}`;
            const lockAcquired = await acquireIdempotencyLock(forfeitLockKey, 60);
            if (!lockAcquired) {
                logger.info(`Tournament forfeit: duplicate processing blocked for match ${room.matchId}`);
            } else {
                const winnerUser = await User.findOne({ walletAddress: remainingPlayer.username });
                const loserUser  = await User.findOne({ walletAddress: disconnectedPlayer.username });
                if (winnerUser && loserUser) {
                    try {
                        const ts = context.tournamentService;
                        const { action, claimed } = await ts.processClaimedMatchResult(
                            room.tournamentId, room.matchId, roomId,
                            winnerUser._id, loserUser._id,
                            remainingPlayer.score || 0, disconnectedPlayer.score || 0
                        );
                        if (claimed) {
                            await updatePlayerStats(allPlayers, {
                                winner:      remainingPlayer.username,
                                botOpponent,
                                betAmount,
                                gameMode:    room.gameMode,
                            });
                            if (action === 'round_advanced')      io.emit('tournamentRoundAdvanced', { tournamentId: room.tournamentId });
                            if (action === 'tournament_complete') io.emit('tournamentComplete',      { tournamentId: room.tournamentId });
                        } else {
                            logger.warn(`[handlePlayerLeftWin] Match ${room.matchId} not claimed for room ${roomId} — skipping stats`);
                        }
                    } catch (e) {
                        logger.error('Failed to advance tournament after forfeit:', e);
                    }
                }
            }
        }

        await deleteGameRoom(roomId);
        await logGameRoomsState();
    } catch (error) {
        logger.error('Error processing player left win:', { error });
        io.to(roomId).emit('gameError', 'Error processing win after player left. Please contact support.');
        await deleteGameRoom(roomId);
        await logGameRoomsState();
    }
}

module.exports = {
    refundToVirtualBalance,
    updatePlayerStats,
    findPlayerActiveRoom,
    handlePlayerLeftWin,
};