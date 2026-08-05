/**
 * services/questionStats.js
 * Materialize per-question empirical difficulty from AnswerTelemetry.
 *
 * recomputeQuestionStats() does one grouping pass over the telemetry and upserts
 * a QuestionStats row per question. It is read-only against telemetry and writes
 * only to QuestionStats, so it never touches gameplay or payments and is safe to
 * run on a cron or on demand.
 */

const AnswerTelemetry = require("../models/AnswerTelemetry");
const QuestionStats = require("../models/QuestionStats");
const logger = require("../logger");

// A question needs this many recorded answers before we trust a difficulty label.
const MIN_ATTEMPTS = 5;
// correctRate thresholds for the difficulty buckets.
const EASY_MIN = 0.75; // >= 75% correct ⇒ easy
const HARD_MAX = 0.4; // < 40% correct ⇒ hard

function deriveDifficulty(correctRate, attempts) {
  if (!attempts || attempts < MIN_ATTEMPTS) return "unrated";
  if (correctRate >= EASY_MIN) return "easy";
  if (correctRate < HARD_MAX) return "hard";
  return "medium";
}

/**
 * Recompute stats for every question that has telemetry. Full recompute (simple
 * and correct); if the telemetry collection ever grows large enough that this is
 * slow, switch to an incremental time-windowed pass.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.stakedOnly] only count real-money games (staked:true)
 * @returns {Promise<{questions:number, totalAnswers:number}>}
 */
async function recomputeQuestionStats(opts = {}) {
  const match = opts.stakedOnly ? [{ $match: { staked: true } }] : [];

  const rows = await AnswerTelemetry.aggregate([
    ...match,
    {
      $group: {
        _id: "$questionId",
        attempts: { $sum: 1 },
        correct: { $sum: { $cond: ["$isCorrect", 1, 0] } },
        timeouts: { $sum: { $cond: ["$timedOut", 1, 0] } },
        // Response time only makes sense for real answers, not timeouts.
        respSum: {
          $sum: {
            $cond: ["$timedOut", 0, { $ifNull: ["$responseTimeMs", 0] }],
          },
        },
        respCount: { $sum: { $cond: ["$timedOut", 0, 1] } },
      },
    },
  ]);

  let totalAnswers = 0;
  const now = new Date();
  for (const r of rows) {
    const attempts = r.attempts || 0;
    totalAnswers += attempts;
    const correctRate = attempts ? r.correct / attempts : 0;
    const timeoutRate = attempts ? r.timeouts / attempts : 0;
    const avgResponseMs = r.respCount ? Math.round(r.respSum / r.respCount) : 0;

    await QuestionStats.updateOne(
      { questionId: r._id },
      {
        $set: {
          attempts,
          correct: r.correct,
          correctRate,
          timeouts: r.timeouts,
          timeoutRate,
          avgResponseMs,
          difficulty: deriveDifficulty(correctRate, attempts),
          computedAt: now,
        },
      },
      { upsert: true }
    );
  }

  logger.info(
    `[QuestionStats] recomputed ${rows.length} question(s) from ${totalAnswers} answer(s)` +
      (opts.stakedOnly ? " (staked only)" : "")
  );
  return { questions: rows.length, totalAnswers };
}

async function getQuestionDifficulty(questionId) {
  return QuestionStats.findOne({ questionId }).lean();
}

module.exports = {
  recomputeQuestionStats,
  getQuestionDifficulty,
  deriveDifficulty,
  MIN_ATTEMPTS,
  EASY_MIN,
  HARD_MAX,
};
