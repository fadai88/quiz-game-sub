/**
 * routes/balance.js
 * Balance check, virtual balance, payment status, leaderboard, and honeypot routes.
 *
 * Changes from original:
 *   - /api/leaderboard now returns weekly-cycle standings (wins/losses/win%)
 *     instead of all-time totalWinnings.
 *   - Added /api/leaderboard/cycles          — list all cycles (public)
 *   - Added /api/leaderboard/cycle/:id       — standings for a specific cycle
 *   - Added POST /api/admin/cycles/rotate    — close cycle + open new one (admin)
 *   - Added GET  /api/admin/cycles/:id/awards — view awarded prizes (admin)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const router = express.Router();
const { PublicKey } = require("@solana/web3.js");
const logger = require("../logger");
const context = require("../context");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const PaymentQueue = require("../models/PaymentQueue");
const PrizeCycle = require("../models/PrizeCycle");
const CycleStat = require("../models/CycleStat");
const WithheldPayout = require("../models/WithheldPayout");
const { refundToVirtualBalance } = require("../services/playerService");
const {
  walletParamSchema,
  paymentIdParamSchema,
} = require("../config/schemas");
const { authenticate, requireAdmin } = require("../middleware/authenticate");
const { getClientIpFromRequest } = require("../middleware/trustedProxy");
const { SecurityLogger } = require("../utils/securityLogger");
const { trackValidationFailure } = require("../config/alerts");
const { MONETIZATION, isPotMode } = require("../config/constants");
const { VALID_BET_AMOUNTS_ATOMIC } = require("../utils/usdcUtils");

// ─── GET /api/balance/:walletAddress (authenticated) ─────────────────────────
// (unchanged from original)

router.get("/balance/:walletAddress", authenticate, async (req, res) => {
  try {
    const { walletAddress } = req.params;
    if (
      !walletAddress ||
      walletAddress.length < 32 ||
      walletAddress.length > 44
    ) {
      SecurityLogger.log("balance_check_invalid_address", {
        ip: getClientIpFromRequest(req),
        address: walletAddress,
      });
      return res.status(400).json({ error: "Invalid wallet address" });
    }
    if (req.user.walletAddress !== walletAddress) {
      SecurityLogger.log("balance_check_unauthorized", {
        ip: getClientIpFromRequest(req),
        requestedWallet: walletAddress,
        sessionWallet: req.user.walletAddress,
      });
      return res.status(403).json({ error: "Unauthorized" });
    }
    const cfg = context.config;
    const publicKey = new PublicKey(walletAddress);
    const tokenAccounts = await cfg.connection.getTokenAccountsByOwner(
      publicKey,
      { mint: cfg.USDC_MINT }
    );
    let balance = 0;
    if (tokenAccounts.value.length > 0) {
      const info = await cfg.connection.getTokenAccountBalance(
        tokenAccounts.value[0].pubkey
      );
      balance = parseFloat(info.value.amount) / 1_000_000;
    }
    logger.info("[BALANCE] Balance checked:", {
      wallet: walletAddress,
      balance,
    });
    res.json({ balance: balance.toFixed(6), walletAddress });
  } catch (error) {
    logger.error("Error fetching balance:", { error });
    res.status(500).json({ error: "Server error", balance: 0 });
  }
});

// ─── GET /api/virtual-balance/:walletAddress (unchanged) ─────────────────────

router.get(
  "/virtual-balance/:walletAddress",
  authenticate,
  async (req, res) => {
    try {
      const { walletAddress } = req.params;
      if (req.user.walletAddress !== walletAddress) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      const user = await User.findOne({ walletAddress }).lean();
      if (!user)
        return res.status(404).json({ error: "User not found", balance: 0 });
      res.json({ balance: user.virtualBalance || 0, walletAddress });
    } catch (error) {
      logger.error("Error fetching virtual balance:", error);
      res.status(500).json({ error: "Server error", balance: 0 });
    }
  }
);

// ─── GET /api/payment/:paymentId (unchanged) ─────────────────────────────────

router.get("/payment/:paymentId", authenticate, async (req, res) => {
  try {
    const { error, value } = paymentIdParamSchema.validate(req.params, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      trackValidationFailure(
        getClientIpFromRequest(req),
        "payment",
        error.details.map((d) => d.message).join("; ")
      );
      return res
        .status(400)
        .json({ success: false, error: "Invalid payment ID" });
    }
    const payment = await PaymentQueue.findOne({
      _id: value.paymentId,
      recipientWallet: req.user.walletAddress,
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    res.json({
      paymentId: payment._id,
      status: payment.status,
      amount: payment.amount,
      transactionSignature: payment.transactionSignature,
      errorMessage: payment.errorMessage,
    });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/leaderboard ─────────────────────────────────────────────────────
// Returns standings for the current ACTIVE weekly cycle.
// Sorted by: wins DESC → losses ASC → walletAddress ASC

router.get("/leaderboard", async (req, res) => {
  try {
    const cycle = await PrizeCycle.getOrCreateActive();

    const stats = await CycleStat.find({ cycleId: cycle._id })
      .sort({ wins: -1, losses: 1, walletAddress: 1 })
      .limit(50)
      .lean();

    // Filter to active subscribers only — real-time endDate check, not stale User fields
    const wallets = stats.map((s) => s.walletAddress);
    const premiumSet = new Set(
      (
        await Subscription.find({
          walletAddress: { $in: wallets },
          status: "active",
          endDate: { $gt: new Date() },
        })
          .select("walletAddress")
          .lean()
      ).map((s) => s.walletAddress)
    );
    const rows = stats
      .filter((s) => premiumSet.has(s.walletAddress))
      .map((s, i) => ({
        rank: i + 1,
        username: s.walletAddress,
        wins: s.wins || 0,
        losses: s.losses || 0,
        gamesPlayed: s.gamesPlayed || 0,
        winPct:
          s.gamesPlayed > 0 ? +((s.wins / s.gamesPlayed) * 100).toFixed(1) : 0,
      }));

    res.json({
      cycle: {
        id: cycle._id,
        label: cycle.label,
        status: cycle.status,
        startedAt: cycle.startedAt,
      },
      rows,
    });
  } catch (error) {
    logger.error("Error fetching leaderboard:", { error });
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// ─── GET /api/leaderboard/cycles ─────────────────────────────────────────────
// Public — list all cycles (newest first)

router.get("/leaderboard/cycles", async (req, res) => {
  try {
    const cycles = await PrizeCycle.find()
      .select("label status startedAt closedAt awards")
      .sort({ startedAt: -1 })
      .lean();
    res.json(cycles);
  } catch (error) {
    logger.error("Error fetching cycles:", { error });
    res.status(500).json({ error: "Failed to fetch cycles" });
  }
});

// ─── GET /api/leaderboard/cycle/:cycleId ─────────────────────────────────────
// Public — standings for a specific cycle

router.get("/leaderboard/cycle/:cycleId", async (req, res) => {
  try {
    const cycle = await PrizeCycle.findById(req.params.cycleId).lean();
    if (!cycle) return res.status(404).json({ error: "Cycle not found" });

    const stats = await CycleStat.find({ cycleId: cycle._id })
      .sort({ wins: -1, losses: 1, walletAddress: 1 })
      .limit(50)
      .lean();

    res.json({
      cycle,
      rows: stats.map((s, i) => ({
        rank: i + 1,
        username: s.walletAddress,
        wins: s.wins || 0,
        losses: s.losses || 0,
        gamesPlayed: s.gamesPlayed || 0,
        winPct:
          s.gamesPlayed > 0 ? +((s.wins / s.gamesPlayed) * 100).toFixed(1) : 0,
      })),
    });
  } catch (error) {
    logger.error("Error fetching cycle leaderboard:", { error });
    res.status(500).json({ error: "Failed to fetch cycle leaderboard" });
  }
});

// ─── POST /api/admin/cycles/rotate  (admin only) ─────────────────────────────
// Closes the current active cycle (optionally recording prize awards) and
// opens a fresh one.  Prize disbursement itself happens off-platform.
//
// Body: {
//   newLabel?:  string,            // label for the new cycle
//   awards?: [{ walletAddress, rank, prizeNote }]
// }

router.post(
  "/admin/cycles/rotate",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { newLabel, awards = [] } = req.body;

      // Validate awards minimally
      for (const a of awards) {
        if (!a.walletAddress || typeof a.rank !== "number") {
          return res.status(400).json({
            error: "Each award needs walletAddress and rank (number).",
          });
        }
      }

      const { closed, opened } = await PrizeCycle.rotateWeekly(
        newLabel,
        awards
      );

      logger.info(
        `[CYCLE] Rotated: closed=${closed?._id} opened=${opened._id}`
      );
      res.json({
        success: true,
        closedCycle: closed ? { id: closed._id, label: closed.label } : null,
        openedCycle: { id: opened._id, label: opened.label },
        awardsRecorded: awards.length,
      });
    } catch (error) {
      logger.error("Error rotating cycle:", { error });
      res.status(500).json({ error: "Failed to rotate cycle." });
    }
  }
);

// ─── GET /api/admin/cycles/:cycleId/awards  (admin only) ─────────────────────

router.get(
  "/admin/cycles/:cycleId/awards",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const cycle = await PrizeCycle.findById(req.params.cycleId).lean();
      if (!cycle) return res.status(404).json({ error: "Cycle not found" });
      res.json({ cycle, awards: cycle.awards || [] });
    } catch (error) {
      logger.error("Error fetching cycle awards:", { error });
      res.status(500).json({ error: "Failed to fetch awards." });
    }
  }
);

// ─── Withheld-payout operator flow (admin only) ──────────────────────────────
// settlePotGame writes a WithheldPayout row whenever it holds a pot (fraud,
// missing dependency, staked-bot backstop, or a failed queue). These endpoints
// let an operator review and resolve each hold rather than the funds sitting in
// the treasury indefinitely.

// GET /api/admin/withheld-payouts?status=pending_review&limit=100
router.get(
  "/admin/withheld-payouts",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const status = req.query.status || "pending_review";
      const allowed = [
        "pending_review",
        "resolving",
        "resolved_refunded",
        "resolved_paid",
        "resolved_denied",
        "all",
      ];
      if (!allowed.includes(status)) {
        return res.status(400).json({ error: "Invalid status filter" });
      }
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const filter = status === "all" ? {} : { status };
      const rows = await WithheldPayout.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      res.json({ count: rows.length, rows });
    } catch (error) {
      logger.error("[WITHHELD] Error listing withheld payouts:", {
        error: error.message,
      });
      res.status(500).json({ error: "Failed to list withheld payouts" });
    }
  }
);

// POST /api/admin/withheld-payouts/:id/resolve
// Body: { action: "refund" | "release" | "deny", note?: string }
//   refund  — return the winner's own stake to their virtual balance
//   release — queue the full withheld payout on-chain (treasury → winner)
//   deny    — close the hold with no money movement (confirmed abuse)
router.post(
  "/admin/withheld-payouts/:id/resolve",
  authenticate,
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { action, note } = req.body || {};
    if (!["refund", "release", "deny"].includes(action)) {
      return res
        .status(400)
        .json({ error: "action must be refund | release | deny" });
    }
    if (!/^[a-f0-9]{24}$/.test(id || "")) {
      return res.status(400).json({ error: "Invalid record id" });
    }

    // Atomically claim the record so two operators can't resolve it twice (and a
    // release can't double-queue the payout). Only a pending_review row can be
    // claimed; anything else means it's already resolved or in flight.
    let record;
    try {
      record = await WithheldPayout.findOneAndUpdate(
        { _id: id, status: "pending_review" },
        { $set: { status: "resolving" } },
        { new: true }
      );
    } catch (error) {
      logger.error("[WITHHELD] Error claiming record:", {
        error: error.message,
      });
      return res.status(500).json({ error: "Failed to claim record" });
    }
    if (!record) {
      return res
        .status(409)
        .json({ error: "Record not found or already resolved" });
    }

    // Revert the claim if the money action fails, so the hold stays actionable.
    const revert = async () => {
      await WithheldPayout.updateOne(
        { _id: id, status: "resolving" },
        { $set: { status: "pending_review" } }
      );
    };

    try {
      if (action === "deny") {
        await finalizeResolution(record, "resolved_denied", req.user, note);
        return res.json({ success: true, status: "resolved_denied" });
      }

      if (action === "refund") {
        const ok = await refundToVirtualBalance(
          record.walletAddress,
          record.stakeAmount,
          `Withheld pot resolved (refund) — room ${record.roomId}`
        );
        if (!ok) {
          await revert();
          return res
            .status(502)
            .json({ error: "Refund failed; hold left open for retry" });
        }
        await finalizeResolution(record, "resolved_refunded", req.user, note);
        return res.json({ success: true, status: "resolved_refunded" });
      }

      // action === "release" — queue the full payout on-chain.
      const paymentProcessor = context.paymentProcessor;
      if (!paymentProcessor) {
        await revert();
        return res.status(503).json({ error: "Payment processor unavailable" });
      }
      if (!record.intendedPayout || record.intendedPayout <= 0) {
        await revert();
        return res
          .status(400)
          .json({ error: "Record has no payable amount; use refund or deny" });
      }
      let payment;
      try {
        payment = await paymentProcessor.queuePayment(
          record.walletAddress,
          Number(record.intendedPayout),
          record.roomId, // gameId — unique, so this can't double-queue
          record.stakeAmount,
          { source: "withheld_payout_release", withheldId: id }
        );
      } catch (queueErr) {
        await revert();
        logger.error("[WITHHELD] Release queue failed:", {
          error: queueErr.message,
        });
        return res
          .status(502)
          .json({ error: `Failed to queue payout: ${queueErr.message}` });
      }
      await finalizeResolution(
        record,
        "resolved_paid",
        req.user,
        note,
        payment._id.toString()
      );
      return res.json({
        success: true,
        status: "resolved_paid",
        paymentId: payment._id.toString(),
      });
    } catch (error) {
      await revert();
      logger.error("[WITHHELD] Error resolving record:", {
        error: error.message,
      });
      return res.status(500).json({ error: "Failed to resolve record" });
    }
  }
);

async function finalizeResolution(record, status, adminUser, note, payoutId) {
  await WithheldPayout.updateOne(
    { _id: record._id },
    {
      $set: {
        status,
        resolvedBy: adminUser.walletAddress,
        resolvedAt: new Date(),
        resolutionNote: typeof note === "string" ? note.slice(0, 500) : null,
        ...(payoutId ? { payoutId } : {}),
      },
    }
  );
  logger.info(
    `[WITHHELD] Record ${record._id} (room ${record.roomId}) resolved as ${status} by ${adminUser.walletAddress}`
  );
}

// ─── GET /api/tokens.json (honeypot — unchanged) ─────────────────────────────

router.get("/tokens.json", async (req, res) => {
  const clientIP = getClientIpFromRequest(req);
  logger.warn(`Potential bot detected accessing honeypot: ${clientIP}`);
  await context.redisClient.set(`blocklist:${clientIP}`, 1, "EX", 86400);
  res.json({ status: "success", data: { tokens: [] } });
});

// ─── GET /api/config (unchanged) ─────────────────────────────────────────────

router.get("/config", (req, res) => {
  try {
    res.json({
      recaptchaEnabled: process.env.ENABLE_RECAPTCHA === "true",
      recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || "",
      // Client-facing Solana RPC endpoint. Served from config (env var) instead
      // of hardcoded in public/*.js so no RPC key is baked into shipped source or
      // git, and it can be rotated without a client redeploy. This endpoint is
      // visible to the browser by nature (the client builds/sends stake txs), so
      // it must be a client-scoped endpoint — never the server's privileged RPC.
      rpcUrl: process.env.CLIENT_RPC_URL || "",
      // Lets the client render the right product: stake controls in pot mode,
      // subscription/tournament entry points otherwise.
      monetization: MONETIZATION,
      validBetAmounts: isPotMode() ? VALID_BET_AMOUNTS_ATOMIC : [],
      treasuryWallet: isPotMode()
        ? process.env.TREASURY_WALLET_ADDRESS || ""
        : "",
      usdcMint: isPotMode()
        ? process.env.USDC_MINT_ADDRESS ||
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        : "",
    });
  } catch (error) {
    logger.error("[CONFIG] Error serving config:", { error });
    res.status(500).json({ error: "Failed to load configuration" });
  }
});

module.exports = router;
