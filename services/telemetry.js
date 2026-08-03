/**
 * services/telemetry.js
 * Per-answer telemetry recording. See models/AnswerTelemetry.js for the "why".
 *
 * Hard rule: telemetry MUST NEVER affect gameplay. Every write is fire-and-forget
 * and fully swallows its own errors, so a slow or unavailable telemetry collection
 * can never delay an answer, break a round, or throw into the game loop.
 */

const mongoose = require("mongoose");
const AnswerTelemetry = require("../models/AnswerTelemetry");
const logger = require("../logger");

// Default ON — the user wants data from match one. Set ANSWER_TELEMETRY=false to
// disable (e.g. for a load test where the extra write is unwanted).
function isEnabled() {
  return process.env.ANSWER_TELEMETRY !== "false";
}

function toObjectId(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

/**
 * Record one human answer / timeout. Non-blocking: returns immediately, resolves
 * silently, and never rejects. Do not `await` this in the game path.
 *
 * @param {object} r
 * @param {string} r.wallet          player wallet address
 * @param {string} r.roomId          match/room id
 * @param {*}      r.questionId       stable question _id (ObjectId or hex string)
 * @param {number} [r.questionIndex]  0-based position within the match
 * @param {string} [r.gameMode]       room mode
 * @param {number} [r.betAmount]      stake (0 = free play)
 * @param {number} [r.responseTimeMs] server-measured response time
 * @param {boolean} [r.isCorrect]
 * @param {boolean} [r.timedOut]
 * @param {object} [r.clientSignals]  untrusted, self-reported client signals
 */
function logAnswer(r) {
  if (!isEnabled()) return;

  // Build synchronously so a bad input can't blow up the caller, then persist
  // detached.
  Promise.resolve()
    .then(() => {
      const questionId = toObjectId(r.questionId);
      if (!r.wallet || !r.roomId || !questionId) return; // incomplete → skip

      const betAmount = Number(r.betAmount) || 0;
      return AnswerTelemetry.create({
        wallet: r.wallet,
        roomId: r.roomId,
        questionId,
        questionIndex: Number.isFinite(r.questionIndex) ? r.questionIndex : 0,
        gameMode: r.gameMode,
        staked: betAmount > 0,
        betAmount,
        responseTimeMs: Number(r.responseTimeMs) || 0,
        isCorrect: !!r.isCorrect,
        timedOut: !!r.timedOut,
        clientSignals: r.clientSignals || undefined,
      });
    })
    .catch((err) => {
      // Swallow — telemetry is best-effort and must not surface into the game.
      logger.warn("Answer telemetry write failed (non-fatal):", {
        error: err.message,
      });
    });
}

module.exports = { logAnswer };
