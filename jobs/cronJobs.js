/**
 * jobs/cronJobs.js
 * Scheduled background tasks registered during server startup.
 *
 * Changes from original:
 *   - Added weekly prize-cycle rotation cron (every Monday at midnight UTC)
 */

const cron   = require('node-cron');
const logger = require('../logger');
const context = require('../context');
const GameSession = require('../models/GameSession');
const PrizeCycle  = require('../models/PrizeCycle');
const { refundToVirtualBalance } = require('../services/playerService');

/**
 * Register all cron jobs. Call this inside `server.listen()` callback.
 */
function registerCronJobs() {

    // ── Safety net: refund stuck games every 5 minutes ────────────────────────
    // (unchanged)
    cron.schedule('*/5 * * * *', async () => {
        try {
            const cutoffTime  = new Date(Date.now() - 15 * 60 * 1000);
            const stuckGames  = await GameSession.find({ status: 'active', startTime: { $lt: cutoffTime } });

            if (stuckGames.length > 0) {
                logger.warn(`⚠️ Safety Net: Found ${stuckGames.length} stuck games. Processing refunds...`);
            }

            for (const game of stuckGames) {
                logger.info(`🔄 Auto-refunding stuck session: ${game.roomId}`);
                for (const player of game.players) {
                    if (!player.walletAddress) continue;
                    const success = await refundToVirtualBalance(player.walletAddress, game.betAmount, `System Crash Recovery (Room ${game.roomId})`);
                    if (success) logger.info(`✅ Refunded ${player.walletAddress} for crashed game ${game.roomId}`);
                }
                game.status       = 'refunded';
                game.endTime      = new Date();
                game.refundReason = 'Safety Net - Game exceeded 15 minute timeout';
                await game.save();
                logger.info(`📝 Marked stuck session ${game.roomId} as refunded`);
            }
        } catch (error) {
            logger.error('❌ Safety Net Cron Error:', error);
        }
    });
    logger.info('🛡️ Safety Net cron job initialized (runs every 5 minutes)');

    // ── Subscription expiry: every hour ───────────────────────────────────────
    // (unchanged)
    cron.schedule('0 * * * *', async () => {
        try {
            const ss = context.subscriptionService;
            if (ss) {
                const expired = await ss.expireOldSubscriptions();
                if (expired > 0) logger.info(`Expired ${expired} subscriptions`);
            }
        } catch (error) {
            logger.error('Failed to expire subscriptions:', error);
        }
    });
    logger.info('📅 Subscription expiry cron job initialized (runs every hour)');

    // ── Tournament starts: every 5 minutes ───────────────────────────────────
    // (unchanged)
    cron.schedule('*/5 * * * *', async () => {
        try {
            const ts = context.tournamentService;
            if (ts) {
                const started = await ts.startScheduledTournaments();
                if (started?.length > 0) {
                    for (const t of started) logger.info(`Started tournament: ${t._id || t}`);
                }
            }
        } catch (error) {
            logger.error('Failed to check/start tournaments:', error);
        }
    });
    logger.info('🏆 Tournament start cron job initialized (runs every 5 minutes)');

    // ── Weekly prize-cycle rotation: every Monday at 00:00 UTC ───────────────
    // Automatically closes the active cycle and opens a fresh one.
    // Admins can still rotate manually at any time via POST /api/admin/cycles/rotate.
    //
    // NOTE: No prizes are auto-awarded here — that remains a deliberate admin
    //       action so the team can review standings first.
    cron.schedule('0 0 * * 1', async () => {
        try {
            const now   = new Date();
            const label = `Week of ${now.toDateString()}`;
            const { closed, opened } = await PrizeCycle.rotateWeekly(label, []);
            logger.info(`📅 Weekly cycle rotated — closed: ${closed?._id}, opened: ${opened._id} ("${label}")`);
        } catch (error) {
            logger.error('❌ Weekly cycle rotation failed:', error);
        }
    }, {
        timezone: 'UTC',
    });
    logger.info('🗓️ Weekly prize-cycle rotation initialized (every Monday 00:00 UTC)');
}

module.exports = { registerCronJobs };