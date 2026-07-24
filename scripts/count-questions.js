/**
 * Read-only check: prints how many questions live in each MongoDB question bank.
 * Does NOT modify anything. Run from the project root (where .env lives):
 *
 *   node scripts/count-questions.js
 */
const mongoose = require("mongoose");
require("dotenv").config();

const Quiz = require("../models/Quiz");
const PracticeQuiz = require("../models/PracticeQuiz");

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error(
      "❌ MONGODB_URI not set — run this from the project root, where .env lives."
    );
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const [quiz, practice] = await Promise.all([
      Quiz.countDocuments(),
      PracticeQuiz.countDocuments(),
    ]);
    console.log("MongoDB question banks:");
    console.log(`  Quiz         (real / staked games): ${quiz} questions`);
    console.log(`  PracticeQuiz (practice games):      ${practice} questions`);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

main();
