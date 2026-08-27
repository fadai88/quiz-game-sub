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
 * Supports both Anthropic (Claude) and OpenAI (GPT) models — the provider is
 * inferred from the model name or forced with --provider. Uses ANTHROPIC_API_KEY
 * or OPENAI_API_KEY from .env accordingly. Results are keyed by (questionId,
 * model), so calibrating a new model adds a column without touching the others —
 * calibrate several to find where they DISAGREE (the sharpest discriminators).
 *
 * Usage (run from project root, where .env lives):
 *   node scripts/calibrate-questions.js --dry-run --batch 20
 *   node scripts/calibrate-questions.js --batch 20 --concurrency 10        # Claude (default)
 *   node scripts/calibrate-questions.js --model claude-sonnet-5 --batch 20
 *   node scripts/calibrate-questions.js --model gpt-4o-mini --batch 20     # OpenAI (auto)
 *
 * Flags:
 *   --model <id>        LLM to test (default claude-haiku-4-5-20251001 — cheap)
 *   --provider <name>   anthropic | openai (default: inferred from --model)
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
// Provider is inferred from the model name (gpt-*/o-series/chatgpt → openai,
// else anthropic) but can be forced with --provider.
const PROVIDER = arg(
  "provider",
  /^(gpt|o\d|chatgpt)/i.test(MODEL) ? "openai" : "anthropic"
);
const COLLECTION = arg("collection", "Quiz");
const LIMIT = parseInt(arg("limit", "0"), 10) || 0;
const BATCH = Math.max(1, parseInt(arg("batch", "1"), 10) || 1);
const CONCURRENCY = Math.max(1, parseInt(arg("concurrency", "5"), 10) || 5);
const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");

const API_KEY =
  PROVIDER === "openai"
    ? process.env.OPENAI_API_KEY
    : process.env.ANTHROPIC_API_KEY;

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

// ─── LLM calls (provider-agnostic) ─────────────────────────────────────────────
// Every provider call takes { system, content, maxTokens } and returns
// { text, usage:{ input_tokens, output_tokens } } so the rest of the script is
// provider-neutral.
// fetch with an abort timeout so a hung connection can't freeze a worker forever
// (no timeout was why the OpenAI run stalled: stuck requests never resolved).
// Timeouts and network errors are marked retryable so withRetry re-issues them.
async function fetchWithTimeout(url, opts, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    const err = new Error(
      e.name === "AbortError"
        ? `request timeout after ${ms}ms`
        : `network error: ${e.message}`
    );
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function apiError(res) {
  const text = await res.text().catch(() => "");
  const err = new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  err.status = res.status;
  err.body = text;
  err.retryable = res.status === 429 || res.status >= 500;
  return err;
}

// Some models (Sonnet 5) use extended thinking by default. That is wrong for
// this job in two ways: the thinking is billed and unbounded, and on a question
// that needs real work it consumes the whole max_tokens budget before any text
// block is produced — the reply comes back stop_reason:"max_tokens" with a
// single empty `thinking` block and nothing to parse.
//
// That is exactly what stranded 810 questions here: they were the computational
// ones, so they were deterministically the ones whose thinking overran, and no
// number of re-runs could ever clear them. Calibration wants a one-line verdict,
// not deliberation, so thinking is turned off.
//
// Not every model accepts the parameter, so a rejection falls back to omitting
// it rather than failing the run.
let thinkingSupported = true;

function anthropicBody({ system, content, maxTokens, disableThinking }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
  };
  if (disableThinking) body.thinking = { type: "disabled" };
  return JSON.stringify(body);
}

async function callAnthropic({ system, content, maxTokens }) {
  const post = (disableThinking) =>
    fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: anthropicBody({ system, content, maxTokens, disableThinking }),
    });

  let res = await post(thinkingSupported);
  if (!res.ok && thinkingSupported && res.status === 400) {
    // Probably a model that does not know the parameter — stop sending it.
    const err = await apiError(res);
    if (/thinking/i.test(err.message || "")) {
      thinkingSupported = false;
      console.warn(
        "[calibrate] model rejected `thinking: disabled` — continuing without it"
      );
      res = await post(false);
    } else {
      throw err;
    }
  }
  if (!res.ok) throw await apiError(res);

  const data = await res.json();
  // Take the TEXT block specifically. Indexing content[0] returns undefined when
  // the model leads with a thinking block, which silently yielded an empty reply.
  const text = (data.content || [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    text,
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0,
    },
  };
}

async function callOpenAI({ system, content, maxTokens }) {
  const res = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        // max_completion_tokens is the current param; older max_tokens is rejected
        // by the o-series / gpt-5 models.
        max_completion_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content },
        ],
      }),
    }
  );
  if (!res.ok) throw await apiError(res);
  const data = await res.json();
  return {
    text: (data.choices?.[0]?.message?.content || "").trim(),
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

function callProvider(args) {
  return PROVIDER === "openai" ? callOpenAI(args) : callAnthropic(args);
}

// Reasoning-capable models work through computational questions ("a regular
// octagon has interior angles summing to…") before answering. A tight ceiling
// truncated those replies mid-thought, so the answer never arrived and the
// question stayed pending forever — deterministically, which is why re-running
// never cleared the tail. max_tokens is only a CAP, not a charge: a question the
// model answers tersely still costs a handful of output tokens, so headroom here
// is free. Sized per question so a big batch cannot be squeezed.
const TOKENS_PER_QUESTION = 220;
const TOKEN_SLACK = 400;

async function askModel(question, options) {
  const optionsText = options.map((o, i) => `${i}) ${o}`).join("\n");
  return callProvider({
    system:
      "You are answering a multiple-choice trivia question. Work it out silently " +
      "if you need to, then give your answer.",
    content:
      `Question: ${question}\nOptions:\n${optionsText}\n\n` +
      `End your reply with the line \`ANSWER=<index>\`, where <index> is the ` +
      `0-based index of the correct option (0-${options.length - 1}). ` +
      "The ANSWER line must be the last thing you output.",
    maxTokens: TOKENS_PER_QUESTION + TOKEN_SLACK,
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
    "Work out any that need calculation, then output a final block that starts " +
    "with a line containing only `ANSWERS:` followed by one line per question in " +
    "the exact format `N=I`, where N is the question number and I is the 0-based " +
    "index of the correct option (e.g. `1=2`). Output nothing after that block."
  );
}

async function askModelBatch(questions) {
  const { text, usage } = await callProvider({
    system:
      "You are answering multiple-choice trivia questions. Finish with a block " +
      "starting `ANSWERS:` containing exactly one line `N=I` per question " +
      "(question number = 0-based correct option index).",
    content: buildBatchContent(questions),
    maxTokens: questions.length * TOKENS_PER_QUESTION + TOKEN_SLACK,
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
      // stop the whole run immediately instead of hammering the bank. Covers
      // Anthropic (400 credit balance) and OpenAI (429 insufficient_quota).
      if (
        /credit balance|Plans & Billing|insufficient_quota|exceeded your current quota|billing/i.test(
          e.message
        )
      ) {
        fatalAuth = "billing/quota problem — add credits for this provider";
        throw e;
      }
      if (!e.retryable || t === tries) throw e;
      await sleep(delay + Math.random() * 500);
      delay = Math.min(delay * 2, 15000);
    }
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────
//
// These decide what gets recorded as the model's answer, and a wrong index here
// is worse than no answer at all: llmCorrect=false is what defines an
// "AI-discriminator", which can be seeded into real-money matches. So both
// parsers anchor on an explicit marker and refuse to guess from loose text.
//
// The hazard is concrete. Reasoning output contains numbers ("an octagon has 8
// sides", "(8-2)*180 = 1080"), and the previous parsers took the FIRST integer
// anywhere in the reply and matched `N=I` mid-sentence — so working like
// "= 1080" could be read as an answer for question 8.

/**
 * The model's chosen option index from a single-question reply.
 * Returns -1 when it cannot be determined with confidence.
 */
function parseIndex(text, n) {
  const s = String(text);

  // Preferred: the explicit end marker we asked for. Last one wins, so a marker
  // quoted mid-reasoning cannot beat the final answer.
  const marked = [...s.matchAll(/ANSWER\s*[:=]\s*(\d+)/gi)];
  if (marked.length) {
    const v = parseInt(marked[marked.length - 1][1], 10);
    return v >= 0 && v < n ? v : -1;
  }

  // Fallback only for a terse reply that is essentially just the number — the
  // old bare-integer behaviour, kept for models that ignore the marker. Anything
  // longer is prose we refuse to guess from.
  const bare = s.trim();
  if (bare.length <= 4) {
    const m = bare.match(/\d+/);
    if (m) {
      const v = parseInt(m[0], 10);
      return v >= 0 && v < n ? v : -1;
    }
  }
  return -1;
}

/**
 * Parse `N=I` lines into an answers array aligned to `questions`.
 *
 * A question the model did not answer stays `undefined`, which leaves it PENDING
 * for a future run rather than recording a wrong -1 — that distinction is why
 * the script is resumable.
 */
function parseBatch(text, questions) {
  const answers = new Array(questions.length).fill(undefined);
  let s = String(text);

  // Only look at the final ANSWERS: block when the model produced one, so any
  // preceding working is out of scope.
  const blocks = [...s.matchAll(/^[ \t]*ANSWERS:[ \t]*$/gim)];
  if (blocks.length) {
    const last = blocks[blocks.length - 1];
    s = s.slice(last.index + last[0].length);
  }

  // Line-anchored: `N=I` must be the whole line (bar whitespace), so arithmetic
  // embedded in a sentence cannot masquerade as an answer.
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*=\s*(\d+)\s*$/);
    if (!m) continue;
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
  if (!["anthropic", "openai"].includes(PROVIDER)) {
    console.error(
      `❌ --provider must be anthropic or openai (got ${PROVIDER})`
    );
    process.exit(1);
  }
  if (!API_KEY) {
    const keyName =
      PROVIDER === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    console.error(
      `❌ ${keyName} is not set. Add it to .env (it is gitignored) and re-run.`
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
    `🔌 Connected. Calibrating "${COLLECTION}" against ${PROVIDER} model ` +
      `"${MODEL}" (batch ${BATCH}, concurrency ${CONCURRENCY})${
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
    const keyName =
      PROVIDER === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    console.error(
      `\n❌ Stopped early — ${fatalAuth}. ` +
        `Check ${keyName} in .env and that the ${PROVIDER} account has API credits.`
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

// Only run when invoked directly — the parsers are unit tested, and requiring
// this file must never start a calibration run against the live database.
if (require.main === module) {
  main().catch(async (e) => {
    console.error("Fatal:", e.message);
    try {
      await mongoose.connection.close();
    } catch {}
    process.exit(1);
  });
}

module.exports = { parseIndex, parseBatch };
