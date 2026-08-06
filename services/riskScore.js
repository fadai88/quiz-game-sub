/**
 * services/riskScore.js
 * Per-player anti-cheat risk scoring from AnswerTelemetry.
 *
 * Philosophy (shared by all three reviews of this system): score on
 * DISTRIBUTIONS, not single rules. No single metric flags an account — high
 * accuracy alone is just a good player. Suspicion comes from the COMBINATION:
 * uniform response times (bot-like), implausibly high accuracy, correctness that
 * tracks LLM-easiness rather than human difficulty, very fast answers, and IP
 * clustering (multi-account / collusion).
 *
 * Output is REVIEW-ONLY. A high score routes an account to human review (and,
 * if warranted, the WithheldPayout flow); it never auto-seizes funds. Thresholds
 * and weights are deliberately explicit constants — tune them as real data
 * arrives. The scoring core (scorePlayer) is pure and unit-tested.
 */

const AnswerTelemetry = require("../models/AnswerTelemetry");
const QuestionCalibration = require("../models/QuestionCalibration");
const PlayerRisk = require("../models/PlayerRisk");
const {
  FRAUD_SUSPICION_THRESHOLD,
  DISCRIMINATOR_MODEL,
} = require("../config/constants");
const logger = require("../logger");

// ─── Tunables ─────────────────────────────────────────────────────────────────
const MIN_ANSWERS = 20; // below this, not enough signal to score
const MIN_LLM_SAMPLES = 5; // need this many llm-easy AND llm-hard for aiAlignment
const UNIFORMITY_CV_FLOOR = 0.5; // response-time CV at/above which uniformity=0
const ACC_FLOOR = 0.85; // accuracy below this contributes 0
const SPEED_FAST_MS = 3000; // mean response at/below which speed saturates
const CLUSTER_FULL = 5; // wallets-per-IP at which clustering saturates

const WEIGHTS = {
  uniformity: 0.25, // low response-time variance (bot-like)
  accuracy: 0.2, // implausibly high accuracy
  aiAlignment: 0.25, // correctness tracks LLM-easiness
  speed: 0.1, // very fast answers
  clustering: 0.2, // many wallets share the IP
};

// ─── Pure math ────────────────────────────────────────────────────────────────
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
}
function coefficientOfVariation(a) {
  const m = mean(a);
  return m > 0 ? stdev(a) / m : 0;
}
function accuracyOf(records) {
  return records.length
    ? records.filter((r) => r.isCorrect).length / records.length
    : 0;
}

/**
 * Score one player from their answer records. Pure — no I/O.
 *
 * @param {Array<{isCorrect:boolean,timedOut:boolean,responseTimeMs:number,
 *                llmCorrect:(boolean|null)}>} records
 * @param {{maxWalletsPerIp?:number}} [ctx]
 * @returns {{score:number, flagged:boolean, confidence:string, attempts:number,
 *            signals:object, metrics:object}}
 */
function scorePlayer(records, ctx = {}) {
  const attempts = records.length;
  if (attempts < MIN_ANSWERS) {
    return {
      score: 0,
      flagged: false,
      confidence: "insufficient_data",
      attempts,
      signals: {},
      metrics: {},
    };
  }

  const answered = records.filter((r) => !r.timedOut && r.responseTimeMs > 0);
  const times = answered.map((r) => r.responseTimeMs);
  const cv = coefficientOfVariation(times);
  const overallAccuracy = accuracyOf(records);
  const meanRt = mean(times);
  const llmEasy = records.filter((r) => r.llmCorrect === true);
  const llmHard = records.filter((r) => r.llmCorrect === false);
  const llmEasyAcc = accuracyOf(llmEasy);
  const llmHardAcc = accuracyOf(llmHard);
  const maxWalletsPerIp = ctx.maxWalletsPerIp || 1;

  const signals = {
    uniformity: clamp01((UNIFORMITY_CV_FLOOR - cv) / UNIFORMITY_CV_FLOOR),
    accuracy: clamp01((overallAccuracy - ACC_FLOOR) / (1 - ACC_FLOOR)),
    speed: clamp01((SPEED_FAST_MS - meanRt) / SPEED_FAST_MS),
    clustering: clamp01((maxWalletsPerIp - 1) / (CLUSTER_FULL - 1)),
    // Only meaningful with enough of BOTH classes; otherwise neutral (0).
    aiAlignment:
      llmEasy.length >= MIN_LLM_SAMPLES && llmHard.length >= MIN_LLM_SAMPLES
        ? clamp01(llmEasyAcc - llmHardAcc)
        : 0,
  };

  const score = Math.round(
    100 *
      (WEIGHTS.uniformity * signals.uniformity +
        WEIGHTS.accuracy * signals.accuracy +
        WEIGHTS.aiAlignment * signals.aiAlignment +
        WEIGHTS.speed * signals.speed +
        WEIGHTS.clustering * signals.clustering)
  );

  return {
    score,
    flagged: score >= FRAUD_SUSPICION_THRESHOLD,
    confidence: "ok",
    attempts,
    signals,
    metrics: {
      cv: Number(cv.toFixed(3)),
      overallAccuracy: Number(overallAccuracy.toFixed(3)),
      meanResponseMs: Math.round(meanRt),
      llmEasyAcc: Number(llmEasyAcc.toFixed(3)),
      llmHardAcc: Number(llmHardAcc.toFixed(3)),
      llmEasyN: llmEasy.length,
      llmHardN: llmHard.length,
      maxWalletsPerIp,
    },
  };
}

// ─── DB-backed computation ────────────────────────────────────────────────────
async function computePlayerRisk(wallet) {
  const rows = await AnswerTelemetry.find(
    { wallet },
    "questionId isCorrect timedOut responseTimeMs ip"
  ).lean();
  if (rows.length === 0) return null;

  // Enrich with LLM correctness per question.
  const qIds = [...new Set(rows.map((r) => String(r.questionId)))];
  const calib = await QuestionCalibration.find(
    { model: DISCRIMINATOR_MODEL, questionId: { $in: qIds } },
    "questionId llmCorrect"
  ).lean();
  const llmByQ = new Map(
    calib.map((c) => [String(c.questionId), c.llmCorrect])
  );

  const records = rows.map((r) => ({
    isCorrect: r.isCorrect,
    timedOut: r.timedOut,
    responseTimeMs: r.responseTimeMs,
    llmCorrect: llmByQ.has(String(r.questionId))
      ? llmByQ.get(String(r.questionId))
      : null,
  }));

  // IP clustering: the most wallets sharing any IP this player used.
  const ips = [...new Set(rows.map((r) => r.ip).filter(Boolean))];
  let maxWalletsPerIp = 1;
  if (ips.length) {
    const wallets = await AnswerTelemetry.distinct("wallet", {
      ip: { $in: ips },
    });
    maxWalletsPerIp = Math.max(1, wallets.length);
  }

  const result = scorePlayer(records, { maxWalletsPerIp });
  await PlayerRisk.updateOne(
    { wallet },
    {
      $set: {
        score: result.score,
        flagged: result.flagged,
        attempts: result.attempts,
        signals: result.signals,
        metrics: result.metrics,
        computedAt: new Date(),
      },
    },
    { upsert: true }
  );
  return { wallet, ...result };
}

async function recomputeAllRisk() {
  const wallets = await AnswerTelemetry.distinct("wallet");
  let scored = 0;
  let flagged = 0;
  for (const wallet of wallets) {
    const r = await computePlayerRisk(wallet);
    if (r && r.confidence === "ok") {
      scored++;
      if (r.flagged) flagged++;
    }
  }
  logger.info(
    `[riskScore] recomputed ${wallets.length} wallet(s): ${scored} scored, ${flagged} flagged`
  );
  return { wallets: wallets.length, scored, flagged };
}

module.exports = {
  // pure (tested)
  scorePlayer,
  coefficientOfVariation,
  clamp01,
  // db-backed
  computePlayerRisk,
  recomputeAllRisk,
  // tunables (exported for tests / ops)
  MIN_ANSWERS,
  WEIGHTS,
};
