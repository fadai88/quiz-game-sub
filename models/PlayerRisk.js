const mongoose = require("mongoose");

/**
 * PlayerRisk — a per-wallet suspicion snapshot computed from AnswerTelemetry
 * (enriched with QuestionCalibration and IP clustering). REVIEW-ONLY: this ranks
 * accounts for a human to look at and, if warranted, routes through the existing
 * WithheldPayout flow. It never auto-seizes funds — a brilliant honest player can
 * look like a mild cheater, so a score is evidence, not a verdict. See
 * services/riskScore.js and [[anti-cheat-telemetry]].
 */
const PlayerRiskSchema = new mongoose.Schema(
  {
    wallet: { type: String, required: true, unique: true },
    score: { type: Number, default: 0 }, // 0-100
    flagged: { type: Boolean, default: false }, // score >= threshold
    attempts: { type: Number, default: 0 }, // answers considered
    signals: { type: mongoose.Schema.Types.Mixed }, // per-signal 0-1 breakdown
    metrics: { type: mongoose.Schema.Types.Mixed }, // raw features behind the score
    computedAt: { type: Date },
  },
  { timestamps: true }
);

// wallet already has a unique index via `unique: true` above.
PlayerRiskSchema.index({ flagged: 1, score: -1 });

module.exports = mongoose.model("PlayerRisk", PlayerRiskSchema);
