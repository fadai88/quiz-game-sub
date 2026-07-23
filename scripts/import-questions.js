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
 * Usage:
 *   node scripts/import-questions.js data/practice.json practice
 *   node scripts/import-questions.js data/quiz.json     quiz
 */

const path = require("path");
const fs = require("fs");
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
  return { valid, skipped };
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
  } catch (err) {
    console.error("❌ Import failed:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
    console.log("🔒 MongoDB connection closed");
  }
}

main();
