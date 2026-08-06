/**
 * services/discriminators.js
 * The set of "AI-discriminator" question ids — questions the calibrated LLM
 * answered WRONG (see scripts/calibrate-questions.js / QuestionCalibration).
 * Seeding a couple of these into a match sharpens the anti-cheat signal: an
 * honest skilled human can get them right, an LLM assistant tends not to.
 *
 * Cached with a TTL because it's read on the match-start hot path and the set
 * only changes when calibration is re-run. Fails soft (returns [] / stale cache)
 * so a lookup problem never blocks a game from starting.
 */

const QuestionCalibration = require("../models/QuestionCalibration");
const { DISCRIMINATOR_MODEL } = require("../config/constants");
const logger = require("../logger");

const TTL_MS = 10 * 60 * 1000;
let cache = { ids: null, at: 0 };

async function getDiscriminatorIds(force = false) {
  const now = Date.now();
  if (!force && cache.ids && now - cache.at < TTL_MS) return cache.ids;
  try {
    const docs = await QuestionCalibration.find(
      // llmAnswer:-1 would be a parse miss, not a genuine "LLM got it wrong".
      { model: DISCRIMINATOR_MODEL, llmCorrect: false, llmAnswer: { $ne: -1 } },
      "questionId"
    ).lean();
    cache = { ids: docs.map((d) => d.questionId), at: now };
    logger.info(
      `[discriminators] loaded ${cache.ids.length} AI-discriminator ids for ${DISCRIMINATOR_MODEL}`
    );
    return cache.ids;
  } catch (e) {
    logger.warn(
      `[discriminators] load failed (using stale/empty): ${e.message}`
    );
    return cache.ids || [];
  }
}

// Test/ops helper — drop the cache so the next call reloads.
function clearDiscriminatorCache() {
  cache = { ids: null, at: 0 };
}

module.exports = { getDiscriminatorIds, clearDiscriminatorCache };
