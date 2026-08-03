const mongoose = require("mongoose");

/**
 * AnswerTelemetry — one document per human answer (or timeout) submitted.
 *
 * Triple-duty dataset:
 *   1. Anti-cheat: response-time signatures and accuracy-vs-difficulty curves.
 *      LLM pipelines produce uniform latencies and a flat, uncannily-high
 *      accuracy curve; honest humans are fast on easy items, slow/variable on
 *      hard ones, and show domain profiles. The distribution betrays automation
 *      even when individual answers look plausible.
 *   2. Skill evidence: a per-answer record that outcomes track knowledge/speed.
 *   3. Difficulty tagging: empirical per-question difficulty (correct-rate,
 *      median response time) computed from real play, feeding adaptive timers
 *      and balanced-difficulty sampling.
 *
 * Bots never write here (they don't hit submitAnswer and are skipped by the
 * timeout path), so the collection is human-only by construction.
 *
 * NOTE: `clientSignals` is SELF-REPORTED by an adversary-controlled client — a
 * cheater can lie or omit it. It is a weak-but-useful signal in aggregate, never
 * a source of truth. Server-measured fields (responseTimeMs, isCorrect) are the
 * trustworthy ones.
 */
const AnswerTelemetrySchema = new mongoose.Schema(
  {
    wallet: { type: String, required: true },
    roomId: { type: String, required: true },
    questionId: { type: mongoose.Schema.Types.ObjectId, required: true },

    // Position of the question within the match (0-based).
    questionIndex: { type: Number, default: 0 },

    // Match context.
    gameMode: { type: String }, // "bot" | "multiplayer" | "practice" | "tournament"
    staked: { type: Boolean, default: false }, // real-money vs free play
    betAmount: { type: Number, default: 0 },

    // Server-measured, trustworthy.
    responseTimeMs: { type: Number, default: 0 },
    isCorrect: { type: Boolean, default: false },
    timedOut: { type: Boolean, default: false },

    // Optional, untrusted, self-reported by the client. Bounded upstream.
    clientSignals: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true } // createdAt / updatedAt
);

// Per-player behavioural analysis (response-time signature, accuracy curve).
AnswerTelemetrySchema.index({ wallet: 1, createdAt: -1 });
// Per-question empirical difficulty aggregation.
AnswerTelemetrySchema.index({ questionId: 1 });
// Per-match reconstruction.
AnswerTelemetrySchema.index({ roomId: 1 });

module.exports = mongoose.model("AnswerTelemetry", AnswerTelemetrySchema);
