/**
 * scripts/answer-review.js
 * Build a PRIVATE data-quality review list from QuestionCalibration: questions
 * where the strongest calibrated model (Sonnet) disagrees with the stored answer
 * — the most likely places the answer key in the DB is wrong.
 *
 * Output → data/answer-review.md (gitignored; contains question text, keep private).
 * The script itself holds no question data and is safe to commit.
 *
 * Ranking (most actionable first):
 *   1. LIKELY WRONG KEY  — every model that scored the question picked the SAME
 *      option, and it isn't the stored answer (models unanimously say the key is
 *      wrong, and agree on the real answer).
 *   2. Both Claude models wrong.
 *   3. Only Sonnet wrong (weaker signal — could just be hard, or a model slip).
 *
 * Usage:  node scripts/answer-review.js
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Quiz = require("../models/Quiz");

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";
const GPT = "gpt-4o-mini";
const LABEL = { [HAIKU]: "Haiku", [SONNET]: "Sonnet", [GPT]: "GPT" };

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI not set — run this from the project root.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const C = mongoose.connection.collection("questioncalibrations");

  // qid -> { model -> { ans, correct } }
  const byQ = new Map();
  const docs = await C.find(
    { model: { $in: [HAIKU, SONNET, GPT] } },
    { projection: { questionId: 1, model: 1, llmAnswer: 1, llmCorrect: 1 } }
  ).toArray();
  for (const d of docs) {
    const k = String(d.questionId);
    if (!byQ.has(k)) byQ.set(k, {});
    byQ.get(k)[d.model] = { ans: d.llmAnswer, correct: d.llmCorrect };
  }

  // Suspects: Sonnet scored it and got it wrong.
  const suspectIds = [];
  for (const [k, v] of byQ) {
    if (v[SONNET] && v[SONNET].correct === false) suspectIds.push(k);
  }

  const quizzes = await Quiz.find(
    { _id: { $in: suspectIds.map((id) => new mongoose.Types.ObjectId(id)) } },
    "question options correctAnswer"
  ).lean();
  const quizById = new Map(quizzes.map((q) => [String(q._id), q]));

  const entries = [];
  for (const k of suspectIds) {
    const q = quizById.get(k);
    if (!q) continue;
    const picks = byQ.get(k); // model -> {ans, correct}
    const scoring = [HAIKU, SONNET, GPT].filter((m) => picks[m]);
    const wrong = scoring.filter((m) => picks[m].correct === false);
    const answers = scoring.map((m) => picks[m].ans);
    const unanimous =
      scoring.length >= 2 &&
      answers.every((a) => a === answers[0]) &&
      answers[0] !== q.correctAnswer &&
      answers[0] >= 0;

    let tier;
    if (unanimous) tier = 1;
    else if (picks[HAIKU] && picks[HAIKU].correct === false)
      tier = 2; // both Claude wrong
    else tier = 3; // only Sonnet wrong
    entries.push({
      q,
      picks,
      scoring,
      wrongCount: wrong.length,
      tier,
      unanimous,
    });
  }

  entries.sort((a, b) => a.tier - b.tier || b.wrongCount - a.wrongCount);

  const counts = { 1: 0, 2: 0, 3: 0 };
  entries.forEach((e) => counts[e.tier]++);

  const out = [];
  out.push(`# Answer-key review list`);
  out.push("");
  out.push(
    `Questions where the strongest calibrated model (Sonnet) disagrees with the ` +
      `stored answer — likely wrong answer keys. Generated ${new Date().toISOString()}.`
  );
  out.push("");
  out.push(
    `- **${counts[1]}** LIKELY WRONG KEY (all models agree on a different option)`
  );
  out.push(`- **${counts[2]}** both Claude models wrong`);
  out.push(`- **${counts[3]}** only Sonnet wrong`);
  out.push(`- **${entries.length}** total to review`);
  out.push("");

  const tierTitle = {
    1: "## ⚠️ Tier 1 — LIKELY WRONG KEY (all models picked the same different option)",
    2: "## Tier 2 — both Claude models disagree with the key",
    3: "## Tier 3 — only Sonnet disagrees (weaker signal)",
  };

  let currentTier = 0;
  let n = 0;
  for (const e of entries) {
    if (e.tier !== currentTier) {
      currentTier = e.tier;
      out.push("");
      out.push(tierTitle[currentTier]);
    }
    n++;
    const { q, picks, scoring } = e;
    // which models picked each option index
    const pickedBy = (idx) =>
      scoring
        .filter((m) => picks[m].ans === idx)
        .map((m) => LABEL[m])
        .join(", ");
    out.push("");
    out.push(`### ${n}. ${q.question}`);
    q.options.forEach((opt, idx) => {
      const marks = [];
      if (idx === q.correctAnswer) marks.push("**STORED ANSWER**");
      const by = pickedBy(idx);
      if (by) marks.push(`picked by ${by}`);
      out.push(
        `- \`${idx}\` ${opt}${marks.length ? "  ← " + marks.join(" · ") : ""}`
      );
    });
    const modelLine = scoring
      .map((m) => `${LABEL[m]}=${picks[m].ans}`)
      .join("  ");
    out.push(
      `  - stored=\`${q.correctAnswer}\`  |  ${modelLine}  |  _id: ${q._id}`
    );
  }

  const outPath = path.join(__dirname, "..", "data", "answer-review.md");
  fs.writeFileSync(outPath, out.join("\n"), "utf8");
  console.log(
    `✅ Wrote ${entries.length} questions to ${outPath}\n` +
      `   Tier 1 (likely wrong key): ${counts[1]}\n` +
      `   Tier 2 (both Claude wrong): ${counts[2]}\n` +
      `   Tier 3 (only Sonnet wrong): ${counts[3]}`
  );
  await mongoose.connection.close();
}

main().catch(async (e) => {
  console.error("Fatal:", e.message);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
