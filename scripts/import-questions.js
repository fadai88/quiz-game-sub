/**
 * Import a questions JSON file (produced by scripts/db_to_json.py) into MongoDB.
 *
 * No sqlite3 / native modules — only mongoose — so it runs anywhere Node runs
 * (Windows, WSL, any Node version), unlike migrate-script.js.
 *
 * Two independent question banks:
 *   quiz     -> Quiz          collection  (real / staked / ranked / tournament)
 *   practice -> PracticeQuiz  collection  (free practice games)
 *
 * Each run clears and repopulates ONLY its own collection.
 *
 * ── STABLE IDS ───────────────────────────────────────────────────────────────
 * Each question's `_id` is DERIVED FROM ITS CONTENT rather than generated fresh.
 *
 * This matters because other collections reference questions by id and outlive
 * any single import:
 *   - QuestionCalibration (expensive: an LLM API call per question per model)
 *   - QuestionStats       (empirical difficulty, accumulated from real play)
 *   - AnswerTelemetry     (the anti-cheat evidence trail)
 *
 * With random ids, a re-import silently orphaned all of them — the rows still
 * existed, still looked healthy, and pointed at documents that no longer did.
 * That is exactly what happened on 2026-08-25: 30,075 calibration rows were
 * detached by an answer-key fix, and nothing reported an error because
 * services/discriminators.js fails soft by design.
 *
 * The hash covers the question text and its options, but NOT `correctAnswer` —
 * so fixing a wrong answer key preserves the question's identity and keeps its
 * calibration. Editing the wording or the options mints a new id, which is
 * correct: that is a different question and its old calibration is meaningless.
 *
 * Usage:
 *   node scripts/import-questions.js data/practice.json practice
 *   node scripts/import-questions.js data/quiz.json     quiz
 *   node scripts/import-questions.js data/quiz.json     quiz --dry-run
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const mongoose = require("mongoose");
require("dotenv").config();

const Quiz = require("../models/Quiz");
const PracticeQuiz = require("../models/PracticeQuiz");

const TARGETS = {
  quiz: { model: Quiz, label: "Quiz (real games)" },
  practice: { model: PracticeQuiz, label: "PracticeQuiz (practice games)" },
};

function resolveConfig() {
  const jsonArg = process.argv[2];
  if (!jsonArg) {
    console.error(
      "Usage: node scripts/import-questions.js <file.json> <quiz|practice>"
    );
    process.exit(1);
  }
  let targetKey = (process.argv[3] || "").toLowerCase();
  if (!targetKey) targetKey = /practice/i.test(jsonArg) ? "practice" : "quiz";

  const target = TARGETS[targetKey];
  if (!target) {
    console.error(
      `❌ Unknown target "${targetKey}". Use "quiz" or "practice".`
    );
    process.exit(1);
  }
  const jsonPath = path.isAbsolute(jsonArg)
    ? jsonArg
    : path.join(__dirname, "..", jsonArg);
  return { jsonPath, target };
}

/**
 * A deterministic ObjectId for a question, from its text + options.
 *
 * An ObjectId is 12 bytes, so we take the leading 12 of a sha256. The hash input
 * is JSON-encoded rather than concatenated so that option boundaries cannot be
 * forged by a question whose text happens to end with an option's text.
 *
 * Deliberately excludes correctAnswer — see the STABLE IDS note at the top.
 */
function stableQuestionId(question) {
  const canonical = JSON.stringify([question.question, question.options]);
  const digest = crypto.createHash("sha256").update(canonical).digest("hex");
  return new mongoose.Types.ObjectId(digest.slice(0, 24));
}

function loadQuestions(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    console.error(`❌ File not found: ${jsonPath}`);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (e) {
    console.error(`❌ Could not parse JSON: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(data)) {
    console.error("❌ Expected the JSON to be an array of questions");
    process.exit(1);
  }

  const valid = [];
  let skipped = 0;
  for (const q of data) {
    const ok =
      q &&
      typeof q.question === "string" &&
      q.question.trim().length > 0 &&
      Array.isArray(q.options) &&
      q.options.length >= 2 &&
      Number.isInteger(q.correctAnswer) &&
      q.correctAnswer >= 0 &&
      q.correctAnswer < q.options.length;
    if (ok) {
      valid.push({
        _id: stableQuestionId(q),
        question: q.question,
        options: q.options,
        correctAnswer: q.correctAnswer,
      });
    } else {
      skipped++;
      console.warn(
        `⚠️  Skipping invalid question: "${String(q && q.question).slice(
          0,
          50
        )}..."`
      );
    }
  }
  // Two questions with identical text AND identical options would hash to the
  // same id, and insertMany would reject the second — losing a question. The
  // bank has no such pairs today (many share text but differ in options, which
  // the hash separates correctly), so treat it as a data error worth stopping
  // for rather than silently importing 11,511 of 11,512.
  const byId = new Map();
  const collisions = [];
  for (const q of valid) {
    const key = String(q._id);
    if (byId.has(key)) collisions.push([byId.get(key), q]);
    else byId.set(key, q);
  }
  if (collisions.length) {
    console.error(
      `❌ ${collisions.length} question(s) are exact duplicates (same text AND options):`
    );
    for (const [a] of collisions.slice(0, 5)) {
      console.error(`   "${a.question.slice(0, 70)}..."`);
    }
    console.error("   Remove the duplicates and re-export, then import again.");
    process.exit(1);
  }

  return { valid, skipped };
}

/**
 * Report how this import changes question identity, before anything is written.
 *
 * The point is to make id churn impossible to miss: anything in `removed` takes
 * its calibration, difficulty stats and telemetry references with it.
 */
async function reportIdChanges(Model, valid) {
  const incoming = new Set(valid.map((q) => String(q._id)));
  const existingDocs = await Model.find({}, "_id").lean();
  const existing = new Set(existingDocs.map((d) => String(d._id)));

  if (existing.size === 0) {
    console.log(`🆕 Empty collection — importing ${valid.length} questions.`);
    return { preserved: 0, added: valid.length, removed: 0 };
  }

  let preserved = 0;
  for (const id of incoming) if (existing.has(id)) preserved++;
  const added = incoming.size - preserved;
  const removed = existing.size - preserved;

  console.log(
    `🔗 Identity: ${preserved} preserved, ${added} new, ${removed} no longer present.`
  );
  if (removed > 0) {
    console.log(
      `   ⚠️  ${removed} question(s) will lose their calibration, difficulty stats\n` +
        "      and telemetry links. Expected if you edited wording or options;\n" +
        "      NOT expected if you only corrected answer keys."
    );
  }
  return { preserved, added, removed };
}

async function main() {
  const { jsonPath, target } = resolveConfig();
  const { valid, skipped } = loadQuestions(jsonPath);

  console.log(`📦 Importing ${path.basename(jsonPath)} -> ${target.label}`);
  console.log(
    `📝 ${valid.length} valid questions` +
      (skipped ? `, ${skipped} skipped` : "")
  );
  if (valid.length === 0) {
    console.error("❌ Nothing to import — aborting.");
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  }

  const Model = target.model;
  try {
    await reportIdChanges(Model, valid);

    if (process.argv.includes("--dry-run")) {
      console.log("\n🔎 Dry run — nothing written.");
      return;
    }

    const deleteResult = await Model.deleteMany({});
    console.log(
      `🗑️  Cleared ${deleteResult.deletedCount} existing questions from ${target.label}`
    );

    const batchSize = 100;
    let inserted = 0;
    for (let i = 0; i < valid.length; i += batchSize) {
      const batch = valid.slice(i, i + batchSize);
      await Model.insertMany(batch);
      inserted += batch.length;
      console.log(
        `✅ Inserted ${inserted}/${valid.length} into ${target.label}`
      );
    }

    const count = await Model.countDocuments();
    console.log(`🎉 Done. ${count} questions now in ${target.label}.`);
    console.log(
      "\nNext: `node scripts/check-calibration-integrity.js` to see what the\n" +
        "import did to the calibration corpus (and repair answer-key drift for free)."
    );
  } catch (err) {
    console.error("❌ Import failed:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
    console.log("🔒 MongoDB connection closed");
  }
}

// Only run when invoked directly. Requiring this file (the id helper is unit
// tested) must never kick off an import against the live database.
if (require.main === module) main();

module.exports = { stableQuestionId };
