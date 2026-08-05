const mongoose = require("mongoose");

/**
 * QuestionStats — empirical, per-question difficulty derived from real play
 * (the AnswerTelemetry collection). Materialized periodically by
 * services/questionStats.js; read by anti-cheat scoring (accuracy-vs-difficulty
 * curves), adaptive per-question timers, and balanced-difficulty match sampling.
 *
 * This is the *human* difficulty signal (measured from players), complementing
 * QuestionCalibration's *LLM* difficulty signal (measured from models). A
 * question that is hard for humans but easy for LLMs is a prime AI-discriminator.
 *
 * A question needs at least MIN_ATTEMPTS answers before it gets a confident
 * difficulty; below that it stays "unrated". See [[anti-cheat-telemetry]].
 */
const QuestionStatsSchema = new mongoose.Schema(
  {
    questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    attempts: { type: Number, default: 0 }, // total human answers (incl. timeouts)
    correct: { type: Number, default: 0 },
    correctRate: { type: Number, default: 0 }, // correct / attempts
    timeouts: { type: Number, default: 0 },
    timeoutRate: { type: Number, default: 0 },
    avgResponseMs: { type: Number, default: 0 }, // mean over non-timeout answers
    difficulty: {
      type: String,
      enum: ["easy", "medium", "hard", "unrated"],
      default: "unrated",
    },
    computedAt: { type: Date },
  },
  { timestamps: true }
);

QuestionStatsSchema.index({ questionId: 1 }, { unique: true });
QuestionStatsSchema.index({ difficulty: 1 });

module.exports = mongoose.model("QuestionStats", QuestionStatsSchema);
