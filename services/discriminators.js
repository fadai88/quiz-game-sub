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
const Quiz = require("../models/Quiz");
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

    // Calibration rows outlive the questions they describe. A question re-import
    // that changes ids leaves these rows intact but pointing at documents that
    // no longer exist — and because this module fails soft, seeding would then
    // quietly do nothing while looking perfectly healthy. That happened on
    // 2026-08-25 and went unnoticed, so check rather than assume.
    if (cache.ids.length) {
      const live = await Quiz.countDocuments({ _id: { $in: cache.ids } });
      if (live === 0) {
        logger.error(
          `[discriminators] ${cache.ids.length} calibration ids for ${DISCRIMINATOR_MODEL} ` +
            "match NO live questions — the calibration is orphaned (question ids changed). " +
            "Discriminator seeding is doing nothing. Run scripts/check-calibration-integrity.js."
        );
      } else if (live < cache.ids.length / 2) {
        logger.warn(
          `[discriminators] only ${live}/${cache.ids.length} calibration ids still resolve ` +
            "to live questions — the bank has drifted. Consider re-calibrating."
        );
      } else {
        logger.info(
          `[discriminators] loaded ${cache.ids.length} AI-discriminator ids for ${DISCRIMINATOR_MODEL} (${live} live)`
        );
      }
    } else {
      logger.info(
        `[discriminators] no AI-discriminator ids for ${DISCRIMINATOR_MODEL}`
      );
    }
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
