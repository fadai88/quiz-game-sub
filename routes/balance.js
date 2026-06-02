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
const {
  walletParamSchema,
  paymentIdParamSchema,
} = require("../config/schemas");
const { authenticate, requireAdmin } = require("../middleware/authenticate");
const { getClientIpFromRequest } = require("../middleware/trustedProxy");
const { SecurityLogger } = require("../utils/securityLogger");
const { trackValidationFailure } = require("../config/alerts");

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
          return res
            .status(400)
            .json({
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
    });
  } catch (error) {
    logger.error("[CONFIG] Error serving config:", { error });
    res.status(500).json({ error: "Failed to load configuration" });
  }
});

module.exports = router;
