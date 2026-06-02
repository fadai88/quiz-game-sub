/**
 * routes/tournaments.js
 * User-facing and admin tournament management endpoints.
 */

const express = require("express");
const router = express.Router();
const path = require("path");
const logger = require("../logger");
const context = require("../context");
const User = require("../models/User");
const Tournament = require("../models/Tournament");
const { authenticate, requireAdmin } = require("../middleware/authenticate");
const { createTournamentSchema } = require("../config/schemas");

// ─── User-facing ──────────────────────────────────────────────────────────────

router.get("/active", authenticate, async (req, res) => {
  try {
    const ts = context.tournamentService;
    if (!ts) return res.json({ success: true, tournaments: [] });
    const tournaments = await ts.getActiveTournaments();
    res.json({ success: true, tournaments });
  } catch (error) {
    logger.error("[TOURNAMENT] Error fetching active:", {
      error: error.message,
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/upcoming", authenticate, async (req, res) => {
  try {
    const ts = context.tournamentService;
    if (!ts) return res.json({ success: true, tournaments: [] });
    const tournaments = await ts.getUpcomingTournaments();
    res.json({ success: true, tournaments });
  } catch (error) {
    logger.error("[TOURNAMENT] Error fetching upcoming:", {
      error: error.message,
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/:id/register", authenticate, async (req, res) => {
  try {
    const ts = context.tournamentService;
    if (!ts)
      return res
        .status(503)
        .json({ success: false, error: "Tournament service not available" });
    const user = await User.findById(req.user.id);
    const tournament = await ts.registerForTournament(
      req.params.id,
      user._id,
      user.walletAddress,
      user.username
    );
    res.json({ success: true, tournament });
  } catch (error) {
    logger.error("[TOURNAMENT] Error registering:", { error: error.message });
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post("/:id/unregister", authenticate, async (req, res) => {
  try {
    const ts = context.tournamentService;
    if (!ts)
      return res
        .status(503)
        .json({ success: false, error: "Tournament service not available" });
    const user = await User.findById(req.user.id);
    const tournament = await ts.unregisterFromTournament(
      req.params.id,
      user._id
    );
    res.json({ success: true, tournament });
  } catch (error) {
    logger.error("[TOURNAMENT] Error unregistering:", { error: error.message });
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get("/my-history", authenticate, async (req, res) => {
  try {
    const ts = context.tournamentService;
    if (!ts) return res.json({ success: true, tournaments: [] });
    const user = await User.findById(req.user.id);
    const tournaments = await ts.getUserTournaments(user._id);
    res.json({ success: true, tournaments });
  } catch (error) {
    logger.error("[TOURNAMENT] Error fetching history:", {
      error: error.message,
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Admin (mounted at /api/admin/tournaments) ──────────────────────────────

const adminRouter = express.Router();

adminRouter.post("/", authenticate, requireAdmin, async (req, res) => {
  try {
    const { error, value } = createTournamentSchema.validate(req.body);
    if (error)
      return res
        .status(400)
        .json({ success: false, error: error.details[0].message });
    const ts = context.tournamentService;
    if (!ts)
      return res
        .status(503)
        .json({ success: false, error: "Tournament service not available" });
    const tournament = await ts.createTournament(value);
    logger.info(
      `[ADMIN] Tournament created by ${req.user.walletAddress}: ${tournament._id} - ${tournament.name}`
    );
    res.status(201).json({ success: true, tournament });
  } catch (error) {
    logger.error("[ADMIN] Error creating tournament:", {
      error: error.message,
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.get("/", authenticate, requireAdmin, async (req, res) => {
  try {
    const tournaments = await Tournament.find()
      .sort({ createdAt: -1 })
      .limit(50)
      .select(
        "name status startTime registrationDeadline minPlayers maxPlayers participants prizePool"
      );
    res.json({ success: true, tournaments });
  } catch (error) {
    logger.error("[ADMIN] Error listing tournaments:", {
      error: error.message,
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

adminRouter.post(
  "/:id/cancel",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const tournament = await Tournament.findById(req.params.id);
      if (!tournament)
        return res
          .status(404)
          .json({ success: false, error: "Tournament not found" });
      if (tournament.status === "completed")
        return res.status(400).json({
          success: false,
          error: "Cannot cancel a completed tournament",
        });
      tournament.status = "cancelled";
      await tournament.save();
      logger.info(
        `[ADMIN] Tournament cancelled by ${req.user.walletAddress}: ${tournament._id}`
      );
      res.json({ success: true, tournament });
    } catch (error) {
      logger.error("[ADMIN] Error cancelling tournament:", {
        error: error.message,
      });
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

module.exports = {
  tournamentRouter: router,
  adminTournamentRouter: adminRouter,
};
