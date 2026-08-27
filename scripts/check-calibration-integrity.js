#!/usr/bin/env node
"use strict";

/**
 * scripts/check-calibration-integrity.js
 *
 * Answers two questions about the calibration corpus that nothing else surfaces,
 * because the runtime code that depends on it fails soft by design:
 *
 *   1. ORPHANS — rows whose questionId points at a question that no longer
 *      exists. Caused by a re-import that changed question ids. The rows look
 *      healthy; services/discriminators.js just silently matches nothing, so
 *      discriminator seeding and the risk score's aiAlignment signal quietly
 *      stop working. This is what happened on 2026-08-25.
 *
 *   2. DRIFT — rows whose stored `correctAnswer` no longer matches the question's
 *      current answer, i.e. you corrected an answer key. `llmCorrect` was
 *      computed against the OLD key and is now wrong, which matters because
 *      llmCorrect=false is exactly what defines an "AI-discriminator".
 *
 * Drift is repairable FOR FREE with --repair: the row already records which
 * option the model chose (`llmAnswer`), so llmCorrect can be recomputed against
 * the corrected key without a single API call.
 *
 * Orphans are NOT repairable — a row stores no question text, so there is no way
 * to re-link it. Those questions must be re-calibrated.
 *
 * A third, smaller trap: UNPARSED rows (llmAnswer -1). The calibration script
 * resumes by skipping any question that already has a row, so a row recorded
 * from an unreadable reply is never retried — it is stuck at -1 forever unless
 * the whole model is re-run with --force. `--clear-unparsed` deletes just those
 * rows so the next normal run picks them up.
 *
 * Usage:
 *   node scripts/check-calibration-integrity.js                  # report only
 *   node scripts/check-calibration-integrity.js --repair         # fix drift (free)
 *   node scripts/check-calibration-integrity.js --prune          # delete orphans
 *   node scripts/check-calibration-integrity.js --clear-unparsed # retry -1 rows
 */

const mongoose = require("mongoose");
require("dotenv").config();

const Quiz = require("../models/Quiz");
const PracticeQuiz = require("../models/PracticeQuiz");
const QuestionCalibration = require("../models/QuestionCalibration");

const REPAIR = process.argv.includes("--repair");
const PRUNE = process.argv.includes("--prune");
const CLEAR_UNPARSED = process.argv.includes("--clear-unparsed");
const BATCH = 1000;

function bankFor(collectionName) {
  return collectionName === "PracticeQuiz" ? PracticeQuiz : Quiz;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
  });
  console.log("✅ Connected\n");

  const total = await QuestionCalibration.countDocuments();
  if (total === 0) {
    console.log("No calibration rows — nothing to check.");
    return;
  }

  const stats = {
    total,
    orphaned: 0,
    drifted: 0,
    repaired: 0,
    pruned: 0,
    flippedToCorrect: 0,
    flippedToWrong: 0,
    ok: 0,
  };
  const orphansByModel = new Map();

  // Streamed in batches: the corpus is ~30k rows across models and there is no
  // need to hold it all in memory.
  let skip = 0;
  for (;;) {
    const rows = await QuestionCalibration.find(
      {},
      "questionId collectionName model correctAnswer llmAnswer llmCorrect"
    )
      .skip(skip)
      .limit(BATCH)
      .lean();
    if (rows.length === 0) break;
    skip += rows.length;

    // One lookup per bank per batch rather than per row.
    const byBank = new Map();
    for (const r of rows) {
      const name = r.collectionName || "Quiz";
      if (!byBank.has(name)) byBank.set(name, []);
      byBank.get(name).push(r.questionId);
    }
    const answers = new Map();
    for (const [name, ids] of byBank) {
      const docs = await bankFor(name)
        .find({ _id: { $in: ids } }, "_id correctAnswer")
        .lean();
      for (const d of docs) answers.set(`${name}:${d._id}`, d.correctAnswer);
    }

    const updates = [];
    const orphanIds = [];
    for (const r of rows) {
      const name = r.collectionName || "Quiz";
      const current = answers.get(`${name}:${r.questionId}`);

      if (current === undefined) {
        stats.orphaned++;
        orphansByModel.set(r.model, (orphansByModel.get(r.model) || 0) + 1);
        if (PRUNE) orphanIds.push(r._id);
        continue;
      }
      if (current === r.correctAnswer) {
        stats.ok++;
        continue;
      }

      // The key changed under this row.
      stats.drifted++;
      const nowCorrect = r.llmAnswer === current;
      if (nowCorrect && !r.llmCorrect) stats.flippedToCorrect++;
      if (!nowCorrect && r.llmCorrect) stats.flippedToWrong++;

      if (REPAIR) {
        updates.push({
          updateOne: {
            filter: { _id: r._id },
            update: {
              $set: { correctAnswer: current, llmCorrect: nowCorrect },
            },
          },
        });
      }
    }

    if (updates.length) {
      await QuestionCalibration.bulkWrite(updates);
      stats.repaired += updates.length;
    }
    if (orphanIds.length) {
      await QuestionCalibration.deleteMany({ _id: { $in: orphanIds } });
      stats.pruned += orphanIds.length;
      // Deleting shifts the pages under a skip/limit scan; step back by what we
      // removed so nothing is silently skipped.
      skip -= orphanIds.length;
    }
    process.stdout.write(`\r   scanned ${skip}/${total}...`);
  }
  process.stdout.write("\r".padEnd(40) + "\r");

  // ── Report ────────────────────────────────────────────────────────────────
  console.log("── Calibration integrity ".padEnd(60, "─"));
  console.log(`   total rows          ${stats.total}`);
  console.log(`   healthy             ${stats.ok}`);
  console.log(`   answer-key drift    ${stats.drifted}`);
  console.log(`   orphaned            ${stats.orphaned}`);

  if (stats.drifted) {
    console.log(
      `\n   Of the drifted rows: ${stats.flippedToCorrect} now count as the model being\n` +
        `   RIGHT (they were false discriminators — a wrong key made the model look wrong),\n` +
        `   and ${stats.flippedToWrong} now count as the model being WRONG (genuine new discriminators).`
    );
    console.log(
      REPAIR
        ? `   ✅ Repaired ${stats.repaired} rows (no API calls needed).`
        : "   Run with --repair to fix these for free (recomputed from the stored llmAnswer)."
    );
  }

  if (stats.orphaned) {
    const pct = ((stats.orphaned / stats.total) * 100).toFixed(1);
    console.log(
      `\n   ⚠️  ${stats.orphaned} rows (${pct}%) point at questions that no longer exist.`
    );
    for (const [model, n] of [...orphansByModel].sort((a, b) => b[1] - a[1])) {
      console.log(`        ${model}: ${n}`);
    }
    console.log(
      "\n   These are NOT recoverable — a calibration row stores no question text,\n" +
        "   so it cannot be re-linked. Those questions must be re-calibrated:\n" +
        "     node scripts/calibrate-questions.js --model <id> --batch 20 --concurrency 8\n" +
        "\n   Question ids are now derived from question content (see\n" +
        "   scripts/import-questions.js), so a future re-import preserves identity\n" +
        "   for every question whose text and options are unchanged."
    );
    console.log(
      PRUNE
        ? `   🗑️  Deleted ${stats.pruned} orphaned rows.`
        : "   Run with --prune to delete them (they are dead weight and keep this\n" +
            "   warning firing forever; re-calibration writes fresh rows regardless)."
    );
  }

  // ── Unparsed rows ─────────────────────────────────────────────────────────
  // Counted separately from drift/orphans: these rows point at a live question
  // and carry the right key, they just never got a readable answer out of the
  // model. They are excluded from the discriminator set (which requires
  // llmAnswer !== -1), so they are not harmful — only wasted coverage.
  const unparsedByModel = await QuestionCalibration.aggregate([
    { $match: { llmAnswer: -1 } },
    { $group: { _id: "$model", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  const unparsedTotal = unparsedByModel.reduce((a, r) => a + r.n, 0);

  if (unparsedTotal) {
    console.log(`\n   ${unparsedTotal} unparsed rows (llmAnswer -1):`);
    for (const r of unparsedByModel) console.log(`        ${r._id}: ${r.n}`);
    if (CLEAR_UNPARSED) {
      const res = await QuestionCalibration.deleteMany({ llmAnswer: -1 });
      console.log(
        `   🔄 Cleared ${res.deletedCount} — re-run the calibration script and\n` +
          "      those questions will be picked up as pending."
      );
    } else {
      console.log(
        "   These are never retried on their own: the calibration script resumes by\n" +
          "   skipping any question that already has a row. Use --clear-unparsed to\n" +
          "   delete them so a normal re-run retries them."
      );
    }
  }

  if (!stats.drifted && !stats.orphaned && !unparsedTotal) {
    console.log(
      "\n   ✅ Calibration is fully consistent with the question bank."
    );
  }
}

main()
  .catch((e) => {
    console.error("❌", e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
