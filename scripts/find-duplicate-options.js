/**
 * Read-only check: finds questions that have two or more identical answer
 * options (e.g. "May 20" listed as both B and D). Does NOT modify anything.
 *
 *   node scripts/find-duplicate-options.js          # live MongoDB banks
 *   node scripts/find-duplicate-options.js --json   # local data/*.json snapshots
 */
const mongoose = require("mongoose");
require("dotenv").config();

const Quiz = require("../models/Quiz");
const PracticeQuiz = require("../models/PracticeQuiz");

// Drop the "A) " / "B. " label so only the answer text is compared.
const stripLabel = (o) =>
  String(o)
    .replace(/^\s*[A-Da-d]\s*[\)\.\:\-]\s*/, "")
    .trim();

// Case, whitespace and quote style only. Symbols, digits and accents are
// meaningful in this bank (-1 vs 1, É vs È, – ◡ – prosody), so never fold them.
const looseKey = (o) =>
  stripLabel(o)
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

function duplicateGroups(options, keyFn) {
  const seen = new Map();
  options.forEach((opt, i) => {
    const key = keyFn(opt);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(i);
  });
  return [...seen.values()].filter((idxs) => idxs.length > 1);
}

function scan(questions) {
  const exact = [];
  const loose = [];
  for (const q of questions) {
    const options = q.options || [];
    const exactDups = duplicateGroups(options, stripLabel);
    if (exactDups.length) {
      exact.push([q, exactDups]);
      continue;
    }
    const looseDups = duplicateGroups(options, looseKey);
    if (looseDups.length) loose.push([q, looseDups]);
  }
  return { exact, loose };
}

function report(label, questions, id) {
  const { exact, loose } = scan(questions);
  console.log(
    `\n===== ${label}: ${questions.length} questions | ` +
      `identical options: ${exact.length} | case/space-only: ${loose.length} =====\n`
  );
  const print = (rows, tag) =>
    rows.forEach(([q, dups]) => {
      console.log(`[${tag}] ${id(q)} | correctAnswer=${q.correctAnswer}`);
      console.log(`  Q: ${q.question}`);
      q.options.forEach((opt, i) => {
        const flagged = dups.some((idxs) => idxs.includes(i));
        console.log(`   ${flagged ? "**" : "  "} ${opt}`);
      });
      console.log("");
    });
  print(exact, "EXACT");
  print(loose, "CASE/SPACE");
  return exact.length + loose.length;
}

async function main() {
  if (process.argv.includes("--json")) {
    report(
      "data/quiz.json",
      require("../data/quiz.json"),
      (q) => `"${q.question}"`
    );
    report(
      "data/practice.json",
      require("../data/practice.json"),
      (q) => `"${q.question}"`
    );
    return;
  }

  if (!process.env.MONGODB_URI) {
    console.error(
      "❌ MONGODB_URI not set — run this from the project root, where .env lives."
    );
    process.exit(1);
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    for (const [Model, label] of [
      [Quiz, "Quiz (real / staked games)"],
      [PracticeQuiz, "PracticeQuiz (practice games)"],
    ]) {
      report(label, await Model.find({}).lean(), (q) => `_id=${q._id}`);
    }
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
