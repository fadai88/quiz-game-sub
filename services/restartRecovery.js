/**
 * services/restartRecovery.js
 *
 * On startup, refund every stake the previous server instance left in-flight —
 * whether it went down gracefully or crashed. We do NOT try to resume games:
 * finding the same two players and re-pitting them is fragile and often
 * impossible, so the rule is simply "give everyone their stake back."
 *
 * Refunds are ON-CHAIN (queued via PaymentQueue → PaymentProcessor sends USDC
 * back to the player's wallet). Virtual balance is a dead-end in pot mode, so it
 * is not used here.
 *
 * Safety properties:
 *   - Idempotent: each refund uses a deterministic gameId
 *     (`refund:<roomId>:<wallet>` / `refund:pool:<wallet>:<joinTime>`), and
 *     PaymentQueue's unique gameId prevents a duplicate refund if recovery runs
 *     twice (crash mid-recovery + reboot).
 *   - No double-pay: a game whose winner payout was already queued
 *     (PaymentQueue has an entry with gameId === roomId, which settlePotGame
 *     uses) is treated as settled and is NOT refunded.
 *   - Practice games (betAmount 0) are just cleaned up, never paid.
 */

const logger = require("../logger");
const context = require("../context");
const GameSession = require("../models/GameSession");
const PaymentQueue = require("../models/PaymentQueue");
const {
  getCleanActiveRooms,
  getGameRoom,
  deleteGameRoom,
  getMatchmakingPool,
  removeFromMatchmakingPool,
} = require("./roomManager");
const { isPotMode } = require("../config/constants");
const { VALID_BET_AMOUNTS_ATOMIC } = require("../utils/usdcUtils");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared on-chain refund helper (idempotent via gameId). Aliased for readability.
const { queueOnChainRefund: queueRefund } = require("./refunds");

// True if this game already paid a winner (settlePotGame queues with gameId=roomId).
async function alreadySettled(roomId) {
  const payout = await PaymentQueue.findOne({ gameId: roomId })
    .select("_id")
    .lean()
    .catch(() => null);
  return !!payout;
}

// Refund the human players of one in-flight room, then delete it.
// `players` is [{ wallet }]. Returns number of refunds queued.
async function settleRoom(roomId, betAmount, players, sessionId) {
  let refunds = 0;

  // Don't refund a game that already queued a winner payout — that would pay
  // stake + winnings and drain the treasury.
  if (betAmount > 0 && !(await alreadySettled(roomId))) {
    for (const wallet of players) {
      const ok = await queueRefund(
        wallet,
        betAmount,
        `refund:${roomId}:${wallet}`,
        `restart — in-flight game ${roomId}`
      );
      if (ok) refunds++;
    }
  }

  // Mark the session done and clear the room either way.
  if (sessionId) {
    await GameSession.updateOne(
      { _id: sessionId },
      {
        status: "refunded",
        endTime: new Date(),
        refundReason: "Server restart — in-flight game refunded",
      }
    ).catch(() => {});
  }
  await deleteGameRoom(roomId).catch(() => {});
  await context.redisClient.del(`room:${roomId}`).catch(() => {});
  return refunds;
}

// ── Pass 1 + 2: in-flight games (Redis rooms, then any orphaned sessions) ──────
async function recoverGames() {
  const handledRooms = new Set();
  let refunds = 0;
  let games = 0;

  // Pass 1 — live Redis rooms (covers all games, incl. legacy ones with no session)
  let roomIds = [];
  try {
    roomIds = await getCleanActiveRooms();
  } catch (e) {
    logger.error("[RESTART-RECOVERY] could not list active rooms", {
      error: e.message,
    });
  }
  for (const roomId of roomIds) {
    try {
      const room = await getGameRoom(roomId);
      if (!room) continue;
      const players = (room.players || [])
        .filter((p) => !p.isBot && p.username)
        .map((p) => p.username);
      const session = await GameSession.findOne({ roomId })
        .select("_id")
        .lean();
      refunds += await settleRoom(
        roomId,
        Number(room.betAmount) || 0,
        players,
        session?._id
      );
      handledRooms.add(roomId);
      games++;
    } catch (e) {
      logger.error(`[RESTART-RECOVERY] room ${roomId} failed`, {
        error: e.message,
      });
    }
  }

  // Pass 2 — active sessions whose Redis room is already gone (e.g. downtime >1h)
  let staleSessions = [];
  try {
    staleSessions = await GameSession.find({ status: "active" }).lean();
  } catch (e) {
    logger.error("[RESTART-RECOVERY] could not list active sessions", {
      error: e.message,
    });
  }
  for (const s of staleSessions) {
    if (handledRooms.has(s.roomId)) continue;
    try {
      const players = (s.players || [])
        .filter((p) => p.walletAddress)
        .map((p) => p.walletAddress);
      refunds += await settleRoom(
        s.roomId,
        Number(s.betAmount) || 0,
        players,
        s._id
      );
      games++;
    } catch (e) {
      logger.error(`[RESTART-RECOVERY] session ${s.roomId} failed`, {
        error: e.message,
      });
    }
  }

  return { games, refunds };
}

// ── Pass 3: stakers still waiting in the matchmaking pools ─────────────────────
// In pot mode a pool entry means the player already paid on-chain. Only stale
// entries (no live socket) are refunded; a live socket is a fresh, valid stake.
async function recoverMatchmakingStakers() {
  if (!isPotMode()) return { stakers: 0, refunds: 0 };
  const io = context.io;
  let stakers = 0;
  let refunds = 0;

  for (const betAmount of VALID_BET_AMOUNTS_ATOMIC) {
    let pool = [];
    try {
      pool = await getMatchmakingPool(betAmount);
    } catch {
      continue;
    }
    for (const entry of pool) {
      if (!entry?.walletAddress) continue;
      // Skip entries backed by a live socket — those are new, valid stakes.
      if (io && entry.socketId && io.sockets.sockets.get(entry.socketId))
        continue;
      const ok = await queueRefund(
        entry.walletAddress,
        betAmount,
        `refund:pool:${entry.walletAddress}:${entry.joinTime || "0"}`,
        "restart — waiting in matchmaking queue"
      );
      if (ok) refunds++;
      stakers++;
      await removeFromMatchmakingPool(betAmount, entry.socketId).catch(
        () => {}
      );
    }
  }
  return { stakers, refunds };
}

/**
 * Entry point — call once on startup, after Mongo + Redis are ready.
 * Non-fatal: any failure is logged, never crashes boot.
 */
async function recoverInFlightOnStartup() {
  // Redis is initialized concurrently in startServer(); wait briefly for it.
  for (let i = 0; i < 30 && !context.redisClient; i++) await sleep(500);
  if (!context.redisClient) {
    logger.error(
      "[RESTART-RECOVERY] Redis not ready — skipping in-flight refund"
    );
    return;
  }

  // A fresh instance is, by definition, no longer draining — clear any
  // maintenance flag left set by the operator before the restart.
  try {
    await require("../utils/maintenance").setDraining(false);
  } catch (e) {
    logger.warn("[RESTART-RECOVERY] could not clear drain flag", {
      error: e.message,
    });
  }

  try {
    logger.info("[RESTART-RECOVERY] scanning for in-flight games/stakes…");
    const g = await recoverGames();
    const m = await recoverMatchmakingStakers();
    logger.info(
      `[RESTART-RECOVERY] done — games:${g.games} game-refunds:${g.refunds} ` +
        `waiting-stakers:${m.stakers} pool-refunds:${m.refunds}`
    );
  } catch (err) {
    logger.error("[RESTART-RECOVERY] failed", { error: err.message });
  }
}

module.exports = {
  recoverInFlightOnStartup,
  // exposed for tests
  _internal: {
    queueRefund,
    alreadySettled,
    settleRoom,
    recoverGames,
    recoverMatchmakingStakers,
  },
};
