/**
 * jobs/cronJobs.js
 * Scheduled background tasks registered during server startup.
 *
 * Changes from original:
 *   - Added weekly prize-cycle rotation cron (every Monday at midnight UTC)
 */

const cron = require("node-cron");
const logger = require("../logger");
const context = require("../context");
const GameSession = require("../models/GameSession");
const PrizeCycle = require("../models/PrizeCycle");
const PaymentQueue = require("../models/PaymentQueue");
const { refundToVirtualBalance } = require("../services/playerService");
const {
  trackFailedPayout,
  trackStuckPayment,
  trackLowTreasurySol,
  trackLowTreasuryUsdc,
} = require("../config/alerts");
const { isSubscriptionMode } = require("../config/constants");

// Thresholds — override via env vars if needed
const MIN_TREASURY_SOL = parseFloat(process.env.MIN_TREASURY_SOL) || 0.05; // lamports → SOL
const MIN_TREASURY_USDC = parseFloat(process.env.MIN_TREASURY_USDC) || 50; // USDC

/**
 * Register all cron jobs. Call this inside `server.listen()` callback.
 */
async function registerCronJobs(botDetector = null) {
  // ── Safety net: refund stuck games every 5 minutes ────────────────────────
  // (unchanged)
  cron.schedule("*/5 * * * *", async () => {
    try {
      const cutoffTime = new Date(Date.now() - 15 * 60 * 1000);
      const stuckGames = await GameSession.find({
        status: "active",
        startTime: { $lt: cutoffTime },
      });

      if (stuckGames.length > 0) {
        logger.warn(
          `⚠️ Safety Net: Found ${stuckGames.length} stuck games. Processing refunds...`
        );
      }

      for (const game of stuckGames) {
        logger.info(`🔄 Auto-refunding stuck session: ${game.roomId}`);
        for (const player of game.players) {
          if (!player.walletAddress) continue;
          const success = await refundToVirtualBalance(
            player.walletAddress,
            game.betAmount,
            `System Crash Recovery (Room ${game.roomId})`
          );
          if (success)
            logger.info(
              `✅ Refunded ${player.walletAddress} for crashed game ${game.roomId}`
            );
        }
        game.status = "refunded";
        game.endTime = new Date();
        game.refundReason = "Safety Net - Game exceeded 15 minute timeout";
        await game.save();
        logger.info(`📝 Marked stuck session ${game.roomId} as refunded`);
      }
    } catch (error) {
      logger.error("❌ Safety Net Cron Error:", error);
    }
  });
  logger.info("🛡️ Safety Net cron job initialized (runs every 5 minutes)");

  // ── Subscription expiry: every hour ───────────────────────────────────────
  // Subscription mode only — pot mode sells no subscriptions to expire.
  if (isSubscriptionMode()) {
    cron.schedule("0 * * * *", async () => {
      try {
        const ss = context.subscriptionService;
        if (ss) {
          const expired = await ss.expireOldSubscriptions();
          if (expired > 0) logger.info(`Expired ${expired} subscriptions`);
        }
      } catch (error) {
        logger.error("Failed to expire subscriptions:", error);
      }
    });
    logger.info(
      "📅 Subscription expiry cron job initialized (runs every hour)"
    );
  }

  // ── BotDetector memory cleanup: every hour ────────────────────────────────
  if (botDetector) {
    cron.schedule("0 * * * *", () => {
      try {
        const cleaned = botDetector.cleanup();
        if (cleaned > 0)
          logger.info(`BotDetector: cleaned ${cleaned} stale records`);
      } catch (error) {
        logger.error("BotDetector cleanup failed:", error);
      }
    });
    logger.info("🤖 BotDetector cleanup cron initialized (runs every hour)");
  }

  // ── Tournament starts: every 5 minutes ───────────────────────────────────
  // Subscription mode only — pot mode runs no tournaments.
  if (isSubscriptionMode()) {
    cron.schedule("*/5 * * * *", async () => {
      try {
        const ts = context.tournamentService;
        if (ts) {
          const started = await ts.startScheduledTournaments();
          if (started?.length > 0) {
            for (const t of started)
              logger.info(`Started tournament: ${t._id || t}`);
          }
        }
      } catch (error) {
        logger.error("Failed to check/start tournaments:", error);
      }
    });
    logger.info(
      "🏆 Tournament start cron job initialized (runs every 5 minutes)"
    );
  }

  // ── Weekly prize-cycle rotation: every Monday at 00:00 UTC ───────────────
  // Startup catch-up: getOrCreateActive() checks the week boundary and rotates
  // if the stored cycle is stale. Handles the case where the server was down
  // on Monday midnight and node-cron never fired.
  try {
    const cycle = await PrizeCycle.getOrCreateActive();
    logger.info(
      `📅 Active prize cycle on startup: "${
        cycle.label
      }" (started ${cycle.startedAt.toUTCString()})`
    );
  } catch (err) {
    logger.error("❌ Startup cycle check failed:", { error: err.message });
  }

  // Automatically closes the active cycle and opens a fresh one.
  // Admins can still rotate manually at any time via POST /api/admin/cycles/rotate.
  //
  // NOTE: No prizes are auto-awarded here — that remains a deliberate admin
  //       action so the team can review standings first.
  cron.schedule(
    "0 0 * * 1",
    async () => {
      try {
        // getOrCreateActive() closes any stale cycle and opens the new
        // Monday-anchored one. Idempotent: if another path already rotated,
        // it just returns the current-week cycle without double-closing.
        const cycle = await PrizeCycle.getOrCreateActive();
        logger.info(
          `📅 Weekly cycle ensured — active: ${cycle._id} ("${cycle.label}")`
        );
      } catch (error) {
        logger.error("❌ Weekly cycle rotation failed:", error);
      }
    },
    {
      timezone: "UTC",
    }
  );
  logger.info(
    "🗓️ Weekly prize-cycle rotation initialized (every Monday 00:00 UTC)"
  );

  // ── Payment health: failed + stuck payouts ────────────────────────────────
  cron.schedule("*/10 * * * *", async () => {
    try {
      const [failedCount, stuckCount] = await Promise.all([
        PaymentQueue.countDocuments({
          status: "failed",
          attempts: { $gte: 5 },
        }),
        PaymentQueue.countDocuments({
          status: "processing",
          lastAttemptAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) },
        }),
      ]);

      if (failedCount > 0) {
        logger.error(
          `Payment monitor: ${failedCount} payout(s) exhausted all retries`,
          { failedCount }
        );
        await trackFailedPayout({ failedCount });
      }
      if (stuckCount > 0) {
        logger.warn(
          `Payment monitor: ${stuckCount} payment(s) stuck in 'processing' >30 min`,
          { stuckCount }
        );
        await trackStuckPayment({ stuckCount });
      }
    } catch (error) {
      logger.error("Payment health cron failed:", { error: error.message });
    }
  });
  logger.info("💳 Payment health monitor initialized (runs every 10 minutes)");

  // ── Treasury balance check ────────────────────────────────────────────────
  cron.schedule("*/10 * * * *", async () => {
    try {
      const cfg = context.config;
      if (!cfg?.connection || !cfg?.TREASURY_WALLET || !cfg?.USDC_MINT) return;

      const [lamports, tokenAccounts] = await Promise.all([
        cfg.connection.getBalance(cfg.TREASURY_WALLET),
        cfg.connection.getTokenAccountsByOwner(cfg.TREASURY_WALLET, {
          mint: cfg.USDC_MINT,
        }),
      ]);

      const solBalance = lamports / 1e9;
      let usdcBalance = 0;
      if (tokenAccounts.value.length > 0) {
        const info = await cfg.connection.getTokenAccountBalance(
          tokenAccounts.value[0].pubkey
        );
        usdcBalance = parseFloat(info.value.amount) / 1e6;
      }

      if (solBalance < MIN_TREASURY_SOL) {
        logger.error(
          `Treasury LOW SOL: ${solBalance.toFixed(
            4
          )} SOL (min ${MIN_TREASURY_SOL})`,
          { solBalance }
        );
        await trackLowTreasurySol({ solBalance, threshold: MIN_TREASURY_SOL });
      }
      if (usdcBalance < MIN_TREASURY_USDC) {
        logger.error(
          `Treasury LOW USDC: ${usdcBalance.toFixed(
            2
          )} USDC (min ${MIN_TREASURY_USDC})`,
          { usdcBalance }
        );
        await trackLowTreasuryUsdc({
          usdcBalance,
          threshold: MIN_TREASURY_USDC,
        });
      }
    } catch (error) {
      logger.error("Treasury balance cron failed:", { error: error.message });
    }
  });
  logger.info(
    "🏦 Treasury balance monitor initialized (runs every 10 minutes)"
  );
}

module.exports = { registerCronJobs };
