/**
 * services/playerService.js
 * Player stats updates, refunds, active-room lookups, and forfeit handling.
 */

const mongoose = require('mongoose');
const logger = require('../logger');
const context = require('../context');
const User = require('../models/User');
const { fromAtomicUnits, calculateWinnings, formatUSDC } = require('../utils/usdcUtils');
const { getCleanActiveRooms, getGameRoom, deleteGameRoom, logGameRoomsState } = require('./roomManager');
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
    const { winner, botOpponent, betAmount } = roomData;
    const multiplier    = botOpponent ? 1.5 : 1.8;
    const winningAmount = calculateWinnings(betAmount, multiplier);

    const supportsTransactions =
        mongoose.connection.client.topology?.description?.type !== 'Single';

    if (supportsTransactions) {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            for (const player of players) {
                if (player.isBot || !player.username) continue;
                const isWinner  = player.username === winner;
                const updateObj = { $inc: { gamesPlayed: 1, correctAnswers: player.score || 0 } };
                if (isWinner) {
                    updateObj.$inc.wins = 1;
                    updateObj.$inc.totalWinnings = fromAtomicUnits(Number(winningAmount));
                }
                await User.findOneAndUpdate(
                    { walletAddress: player.username },
                    updateObj,
                    { upsert: true, new: true, session }
                );
                logger.info(`Updated ${player.username} (winner: ${isWinner})`);
            }
            await session.commitTransaction();
        } catch (error) {
            await session.abortTransaction();
            logger.error('Error updating player stats (transaction rolled back):', error);
            throw error;
        } finally {
            session.endSession();
        }
    } else {
        // Fallback for single-node MongoDB (no transactions)
        for (const player of players) {
            if (player.isBot || !player.username) continue;
            const isWinner  = player.username === winner;
            const updateObj = { $inc: { gamesPlayed: 1, correctAnswers: player.score || 0 } };
            if (isWinner) {
                updateObj.$inc.wins = 1;
                updateObj.$inc.totalWinnings = fromAtomicUnits(Number(winningAmount));
            }
            try {
                await User.findOneAndUpdate({ walletAddress: player.username }, updateObj, { upsert: true, new: true });
                logger.info(`Updated ${player.username} (winner: ${isWinner})`);
            } catch (err) {
                logger.error(`Error updating stats for ${player.username}:`, err);
            }
        }
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
            message: `${disconnectedPlayer.username} left the game. ${remainingPlayer.username} wins by forfeit!`,
        });

        await updatePlayerStats(allPlayers, {
            winner:      remainingPlayer.username,
            botOpponent,
            betAmount,
        });

        // Advance tournament bracket on forfeit
        if (room?.gameMode === GAME_MODES.TOURNAMENT && room.tournamentId && context.tournamentService) {
            const winnerUser = await User.findOne({ walletAddress: remainingPlayer.username });
            const loserUser  = await User.findOne({ walletAddress: disconnectedPlayer.username });
            if (winnerUser && loserUser) {
                try {
                    const ts = context.tournamentService;
                    await ts.updatePlayerScore(room.tournamentId, winnerUser._id, remainingPlayer.score || 0, 'win');
                    await ts.updatePlayerScore(room.tournamentId, loserUser._id,  disconnectedPlayer.score || 0, 'loss');
                    const { action } = await ts.processMatchResult(room.tournamentId, winnerUser._id, loserUser._id);
                    if (action === 'round_advanced')     io.emit('tournamentRoundAdvanced', { tournamentId: room.tournamentId });
                    if (action === 'tournament_complete') io.emit('tournamentComplete',      { tournamentId: room.tournamentId });
                } catch (e) {
                    logger.error('Failed to advance tournament after forfeit:', e);
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