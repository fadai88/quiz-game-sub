/**
 * scripts/calibrate-questions.js
 *
 * Run every question in a bank through an LLM and record whether the model
 * answered correctly. This tags each question's difficulty *for an LLM*, which
 * is the raw material for "AI-discriminator" anti-cheat questions (see
 * models/QuestionCalibration.js). Results are stored in the QuestionCalibration
 * collection, keyed by (questionId, model).
 *
 * Safe to stop and re-run: already-calibrated questions for the chosen model are
 * skipped (unless --force). Never logs the API key.
 *
 * Usage (run from project root, where .env lives):
 *   node scripts/calibrate-questions.js --dry-run --batch 20
 *   node scripts/calibrate-questions.js --limit 50                 # small real run
 *   node scripts/calibrate-questions.js                            # full, one-per-call
 *   node scripts/calibrate-questions.js --batch 20 --concurrency 10  # fast pass
 *
 * Flags:
 *   --model <id>        LLM to test (default claude-haiku-4-5-20251001 — cheap)
 *   --collection <name> Quiz (default) | PracticeQuiz
 *   --limit <n>         cap the number of questions this run (0 = all)
 *   --batch <n>         questions per API call (default 1). >1 packs many
 *                       questions into one request — far fewer round-trips, so
 *                       much faster. Try 20.
 *   --concurrency <n>   parallel requests/batches (default 5). Questions in
 *                       flight ≈ batch × concurrency; if you see 429s, lower these.
 *   --force             recalibrate questions already done for this model
 *   --dry-run           no API calls, no writes — just show what would happen
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Quiz = require("../models/Quiz");
const PracticeQuiz = require("../models/PracticeQuiz");
const QuestionCalibration = require("../models/QuestionCalibration");

// ─── Args ─────────────────────────────────────────────────────────────────────
function arg(name, def) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = process.argv.indexOf(`--${name}`);
  if (
    i !== -1 &&
    process.argv[i + 1] &&
    !process.argv[i + 1].startsWith("--")
  ) {
    return process.argv[i + 1];
  }
  return def;
}
const MODEL = arg("model", "claude-haiku-4-5-20251001");
const COLLECTION = arg("collection", "Quiz");
const LIMIT = parseInt(arg("limit", "0"), 10) || 0;
const BATCH = Math.max(1, parseInt(arg("batch", "1"), 10) || 1);
const CONCURRENCY = Math.max(1, parseInt(arg("concurrency", "5"), 10) || 5);
const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");

const API_KEY = process.env.ANTHROPIC_API_KEY;

const stats = {
  processed: 0,
  correct: 0,
  errors: 0,
  skipped: 0,
  inTok: 0,
  outTok: 0,
};
let fatalAuth = null;
let lastBucket = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── LLM calls ────────────────────────────────────────────────────────────────
async function callAnthropic(body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`API ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  const data = await res.json();
  return {
    text: (data.content?.[0]?.text || "").trim(),
    usage: data.usage || {},
  };
}

async function askModel(question, options) {
  const optionsText = options.map((o, i) => `${i}) ${o}`).join("\n");
  return callAnthropic({
    model: MODEL,
    max_tokens: 10,
    system:
      "You are answering a multiple-choice trivia question. Reply with ONLY " +
      "the number of the correct option — no words, no punctuation.",
    messages: [
      {
        role: "user",
        content:
          `Question: ${question}\nOptions:\n${optionsText}\n\n` +
          `Reply with only the option number (0-${options.length - 1}).`,
      },
    ],
  });
}

function buildBatchContent(questions) {
  const blocks = questions
    .map((q, i) => {
      const opts = q.options.map((o, j) => `${j}) ${o}`).join("\n");
      return `${i + 1}. ${q.question}\n${opts}`;
    })
    .join("\n\n");
  return (
    `Answer each numbered multiple-choice question below.\n\n${blocks}\n\n` +
    "Respond with one line per question in the exact format `N=I`, where N is " +
    "the question number and I is the 0-based index of the correct option " +
    "(e.g. `1=2`). Output only these lines, one per question."
  );
}

async function askModelBatch(questions) {
  const { text, usage } = await callAnthropic({
    model: MODEL,
    // Generous budget: enough for one `N=I` line per question plus slack, so a
    // larger batch never truncates (which yields an unparseable reply).
    max_tokens: questions.length * 20 + 50,
    system:
      "You are answering multiple-choice trivia questions. For each numbered " +
      "question output exactly one line `N=I` (question number = 0-based correct " +
      "option index). No other text.",
    messages: [{ role: "user", content: buildBatchContent(questions) }],
  });
  return { answers: parseBatch(text, questions), usage };
}

async function withRetry(fn, tries = 5) {
  let delay = 1000;
  for (let t = 1; t <= tries; t++) {
    try {
      return await fn();
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        fatalAuth = e.message;
        throw e;
      }
      // No credits / billing not set up — every request fails identically, so
      // stop the whole run immediately instead of hammering the bank.
      if (
        e.status === 400 &&
        /credit balance|Plans & Billing/i.test(e.message)
      ) {
        fatalAuth =
          "credit balance too low — add credits in Console → Plans & Billing";
        throw e;
      }
      if (!e.retryable || t === tries) throw e;
      await sleep(delay + Math.random() * 500);
      delay = Math.min(delay * 2, 15000);
    }
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────
function parseIndex(text, n) {
  const m = String(text).match(/\d+/);
  if (!m) return -1;
  const v = parseInt(m[0], 10);
  return v >= 0 && v < n ? v : -1;
}

// Parse `N=I` lines into an answers array aligned to `questions`. Any question
// the model didn't answer stays `undefined` (left pending for a future run,
// rather than being recorded as a wrong -1).
function parseBatch(text, questions) {
  const answers = new Array(questions.length).fill(undefined);
  const re = /(\d+)\s*=\s*(\d+)/g;
  let m;
  while ((m = re.exec(text))) {
    const qi = parseInt(m[1], 10) - 1;
    const opt = parseInt(m[2], 10);
    if (qi >= 0 && qi < questions.length) {
      const nOpts = questions[qi].options.length;
      answers[qi] = opt >= 0 && opt < nOpts ? opt : -1;
    }
  }
  return answers;
}

function isValidQuestion(q) {
  return (
    Array.isArray(q.options) &&
    q.options.length >= 2 &&
    typeof q.correctAnswer === "number" &&
    q.correctAnswer >= 0 &&
    q.correctAnswer < q.options.length &&
    typeof q.question === "string" &&
    q.question.length > 0
  );
}

async function recordResult(q, llmAnswer, raw) {
  const idx = Number.isInteger(llmAnswer) ? llmAnswer : -1;
  const llmCorrect = idx === q.correctAnswer;
  stats.processed++;
  if (llmCorrect) stats.correct++;
  await QuestionCalibration.updateOne(
    { questionId: q._id, model: MODEL },
    {
      $set: {
        collectionName: COLLECTION,
        correctAnswer: q.correctAnswer,
        llmAnswer: idx,
        llmCorrect,
        raw: raw ? String(raw).slice(0, 20) : "",
      },
    },
    { upsert: true }
  );
}

function logProgress() {
  const done = stats.processed;
  const acc = done ? ((stats.correct / done) * 100).toFixed(1) : "0.0";
  console.log(
    `  …${done} answered (LLM accuracy ${acc}%), ` +
      `${stats.skipped} skipped, ${stats.errors} errors, ` +
      `tokens in/out ${stats.inTok}/${stats.outTok}`
  );
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────
async function runPool(items, worker) {
  let idx = 0;
  const runNext = async () => {
    while (idx < items.length && !fatalAuth) {
      await worker(items[idx++]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, runNext)
  );
}

async function processChunk(chunk) {
  if (fatalAuth) return;
  const valid = chunk.filter(isValidQuestion);
  stats.skipped += chunk.length - valid.length;
  if (valid.length === 0) return;

  try {
    if (valid.length === 1) {
      const q = valid[0];
      const { text, usage } = await withRetry(() =>
        askModel(q.question, q.options)
      );
      stats.inTok += usage.input_tokens || 0;
      stats.outTok += usage.output_tokens || 0;
      await recordResult(q, parseIndex(text, q.options.length), text);
    } else {
      const { answers, usage } = await withRetry(() => askModelBatch(valid));
      stats.inTok += usage.input_tokens || 0;
      stats.outTok += usage.output_tokens || 0;
      for (let i = 0; i < valid.length; i++) {
        if (answers[i] === undefined) continue; // unanswered → retry next run
        await recordResult(valid[i], answers[i]);
      }
    }
  } catch (e) {
    stats.errors += valid.length;
    if (!fatalAuth) console.error(`  ✗ chunk(${valid.length}): ${e.message}`);
  }

  const bucket = Math.floor(stats.processed / 100);
  if (bucket > lastBucket) {
    lastBucket = bucket;
    logProgress();
  }
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!API_KEY) {
    console.error(
      "❌ ANTHROPIC_API_KEY is not set. Add it to .env (it is gitignored) and re-run."
    );
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI not set — run this from the project root.");
    process.exit(1);
  }
  if (!["Quiz", "PracticeQuiz"].includes(COLLECTION)) {
    console.error(
      `❌ --collection must be Quiz or PracticeQuiz (got ${COLLECTION})`
    );
    process.exit(1);
  }

  const Bank = COLLECTION === "PracticeQuiz" ? PracticeQuiz : Quiz;

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(
    `🔌 Connected. Calibrating "${COLLECTION}" against model "${MODEL}" ` +
      `(batch ${BATCH}, concurrency ${CONCURRENCY})${
        DRY_RUN ? " (DRY RUN)" : ""
      }`
  );

  const all = await Bank.find({}, "question options correctAnswer").lean();
  console.log(`   ${all.length} questions in the bank.`);

  let pending = all;
  if (!FORCE) {
    const doneDocs = await QuestionCalibration.find(
      { model: MODEL, collectionName: COLLECTION },
      "questionId"
    ).lean();
    const done = new Set(doneDocs.map((d) => d.questionId.toString()));
    pending = all.filter((q) => !done.has(q._id.toString()));
    console.log(
      `   ${done.size} already calibrated for this model — ${pending.length} remaining.`
    );
  }

  if (LIMIT > 0 && pending.length > LIMIT) {
    pending = pending.slice(0, LIMIT);
    console.log(`   --limit ${LIMIT}: processing ${pending.length} this run.`);
  }

  if (pending.length === 0) {
    console.log("✅ Nothing to do.");
    await mongoose.connection.close();
    return;
  }

  const chunks = chunkArray(pending, BATCH);

  if (DRY_RUN) {
    const validPending = pending.filter(isValidQuestion);
    if (BATCH > 1) {
      const sample = validPending.slice(0, Math.min(BATCH, 3));
      console.log(
        `\n(DRY RUN) Would send ${pending.length} questions in ${chunks.length} ` +
          `batch(es) of up to ${BATCH}, ${CONCURRENCY} in parallel.\n` +
          `Sample batch prompt (first ${sample.length} of a batch):\n---\n` +
          buildBatchContent(sample) +
          `\n---\nNo API calls made, nothing written.`
      );
    } else {
      const sample = validPending[0] || pending[0];
      console.log(
        `\n(DRY RUN) Would send ${pending.length} questions one per call. ` +
          `Sample prompt:\n---\nQuestion: ${sample.question}\nOptions:\n` +
          (sample.options || []).map((o, i) => `${i}) ${o}`).join("\n") +
          `\n---\nNo API calls made, nothing written.`
      );
    }
    await mongoose.connection.close();
    return;
  }

  const started = Date.now();
  await runPool(chunks, processChunk);

  console.log("\n──────── done ────────");
  logProgress();
  if (fatalAuth) {
    console.error(
      `\n❌ Stopped early — ${fatalAuth}. ` +
        `Check ANTHROPIC_API_KEY in .env and that the account has API credits.`
    );
  }
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `LLM accuracy on this run: ${
      stats.processed
        ? ((stats.correct / stats.processed) * 100).toFixed(1)
        : "0"
    }% of ${stats.processed} answered in ${secs}s.`
  );
  console.log(
    `Tokens used: ${stats.inTok} input + ${stats.outTok} output ` +
      `(check current per-token pricing for "${MODEL}" to cost it).`
  );
  console.log(
    "Re-run the same command to continue where you left off (already-done " +
      "questions, and any a batch skipped, are picked up next time)."
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
