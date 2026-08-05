/**
 * scripts/recompute-question-stats.js
 * On-demand recompute of per-question empirical difficulty from AnswerTelemetry.
 * (The server also refreshes this on a cron; this is for manual runs / testing.)
 *
 * Usage (from project root, where .env lives):
 *   node scripts/recompute-question-stats.js
 *   node scripts/recompute-question-stats.js --staked-only
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { recomputeQuestionStats } = require("../services/questionStats");
const QuestionStats = require("../models/QuestionStats");

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI not set — run this from the project root.");
    process.exit(1);
  }
  const stakedOnly = process.argv.includes("--staked-only");

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(
    `🔌 Connected. Recomputing question stats${
      stakedOnly ? " (staked only)" : ""
    }…`
  );

  const { questions, totalAnswers } = await recomputeQuestionStats({
    stakedOnly,
  });
  console.log(
    `✅ Updated ${questions} question(s) from ${totalAnswers} answer(s).`
  );

  if (questions > 0) {
    const byDifficulty = await QuestionStats.aggregate([
      { $group: { _id: "$difficulty", n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    console.log("   Difficulty breakdown:");
    for (const d of byDifficulty) console.log(`     ${d._id}: ${d.n}`);
  } else {
    console.log(
      "   No telemetry yet — this fills in as games are played (bots don't count)."
    );
  }

  await mongoose.connection.close();
}

main().catch(async (e) => {
  console.error("Fatal:", e.message);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
