/**
 * config/constants.js
 * Application constants and startup environment validation.
 */

const ENVIRONMENT = process.env.NODE_ENV || "development";

// ─── Monetization model ──────────────────────────────────────────────────────
// This codebase serves two products from one tree:
//
//   subscription — premium members play ranked; prizes paid from weekly cycles
//   pot          — any wallet may stake USDC; winner takes the pot minus rake
//
// Defaults to "subscription" so an unconfigured deployment keeps its existing
// behaviour. The pot deployment must opt in explicitly via MONETIZATION=pot.
const MONETIZATION_MODELS = {
  SUBSCRIPTION: "subscription",
  POT: "pot",
};

const MONETIZATION =
  process.env.MONETIZATION || MONETIZATION_MODELS.SUBSCRIPTION;

if (!Object.values(MONETIZATION_MODELS).includes(MONETIZATION)) {
  console.error(
    `❌ FATAL: MONETIZATION must be one of ${Object.values(
      MONETIZATION_MODELS
    ).join(" | ")} (got "${MONETIZATION}")`
  );
  process.exit(1);
}

const isPotMode = () => MONETIZATION === MONETIZATION_MODELS.POT;
const isSubscriptionMode = () =>
  MONETIZATION === MONETIZATION_MODELS.SUBSCRIPTION;

// Winner's multiple of their own stake. Two players stake `bet` each (pot =
// 2×bet) and the winner takes 1.8×bet, leaving a 10% rake. Bot games have no
// second stake, so the 1.5× payout is funded by the treasury.
const POT_MULTIPLIERS = {
  HUMAN_OPPONENT: 1.8,
  BOT_OPPONENT: 1.5,
};

// Suspicion score at or above which a payout is withheld and the account flagged.
const FRAUD_SUSPICION_THRESHOLD = 70;

const GAME_MODES = {
  PRACTICE: "practice", // Free users — bot or single-player
  RANKED: "ranked", // Subscription mode: premium members. Pot mode: any staked wallet.
  BOT: "bot", // Bot game room mode
  TOURNAMENT: "tournament", // Premium users — tournament bracket (subscription mode only)
};

// ─── Match / skill-predominance tuning ───────────────────────────────────────
// These shape how "skill" (vs chance) drives outcomes and are configurable so
// the design can be tuned without a code change:
//
//   QUESTIONS_PER_MATCH   — more questions ⇒ lower variance ⇒ the better player
//                           wins more reliably (skill dominates). Default 10.
//   TIEBREAK_MODE         — how a tied match is decided:
//                             "response_time" — lower total response time wins
//                                 (current behaviour; includes reaction/latency,
//                                 which is partly chance).
//                             "sudden_death"  — play extra question(s) until the
//                                 tie breaks (pure skill), then fall back to
//                                 response_time only if still tied after the cap.
//   SUDDEN_DEATH_MAX_ROUNDS — safety cap on sudden-death questions so a match
//                             always terminates. Default 5.
function parseIntEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < min || n > max) {
    console.error(
      `❌ FATAL: ${name} must be an integer in [${min}, ${max}] (got "${raw}")`
    );
    process.exit(1);
  }
  return n;
}

const QUESTIONS_PER_MATCH = parseIntEnv("QUESTIONS_PER_MATCH", 10, 1, 50);

const TIEBREAK_MODES = {
  RESPONSE_TIME: "response_time",
  SUDDEN_DEATH: "sudden_death",
};
const TIEBREAK_MODE = process.env.TIEBREAK_MODE || TIEBREAK_MODES.RESPONSE_TIME;
if (!Object.values(TIEBREAK_MODES).includes(TIEBREAK_MODE)) {
  console.error(
    `❌ FATAL: TIEBREAK_MODE must be one of ${Object.values(
      TIEBREAK_MODES
    ).join(" | ")} (got "${TIEBREAK_MODE}")`
  );
  process.exit(1);
}

const SUDDEN_DEATH_MAX_ROUNDS = parseIntEnv(
  "SUDDEN_DEATH_MAX_ROUNDS",
  5,
  1,
  20
);

// ─── Anti-cheat: AI-discriminator seeding ────────────────────────────────────
// Number of "hard for LLMs" questions (from QuestionCalibration) to force into
// each real-money match. A human who aces these looks nothing like an LLM
// assistant, so they sharpen the accuracy-vs-difficulty risk signal. Default 0
// (OFF) — turn on only after reviewing discriminator quality, since a question
// an LLM got "wrong" is occasionally one whose stored answer is itself wrong.
const DISCRIMINATOR_SEED_COUNT = parseIntEnv(
  "DISCRIMINATOR_SEED_COUNT",
  0,
  0,
  20
);
// Which calibrated model defines "hard for LLMs".
const DISCRIMINATOR_MODEL =
  process.env.DISCRIMINATOR_MODEL || "claude-haiku-4-5-20251001";

// ─── Startup validation ──────────────────────────────────────────────────────

console.log(
  MONETIZATION === MONETIZATION_MODELS.POT
    ? "💰 Monetization: POT (stake-based, winner takes pot minus rake)"
    : "🎟️  Monetization: SUBSCRIPTION (premium ranked + tournaments)"
);

if (ENVIRONMENT === "production") {
  console.log("🚀 Starting in PRODUCTION mode");

  if (process.env.ENABLE_RECAPTCHA !== "true") {
    console.error('❌ FATAL: ENABLE_RECAPTCHA must be "true" in production!');
    process.exit(1);
  }
  if (!process.env.RECAPTCHA_SECRET_KEY) {
    console.error("❌ FATAL: RECAPTCHA_SECRET_KEY missing in production!");
    process.exit(1);
  }
  if (!process.env.REDIS_URL && !process.env.REDIS_PASSWORD) {
    console.error("❌ FATAL: Redis configuration required in production!");
    process.exit(1);
  }

  console.log("✅ reCAPTCHA properly configured for production");
  console.log(
    process.env.REDIS_URL
      ? "✅ Redis properly configured (using REDIS_URL)"
      : "✅ Redis properly configured (using REDIS_PASSWORD)"
  );
} else {
  console.log("🔧 Starting in DEVELOPMENT mode");
  console.log(
    "   reCAPTCHA:",
    process.env.ENABLE_RECAPTCHA === "true" ? "ENABLED" : "DISABLED"
  );
  console.log(
    "   Redis:",
    process.env.REDIS_PASSWORD
      ? "PASSWORD PROTECTED"
      : "⚠️  NO PASSWORD (insecure - dev only)"
  );
}

// ─── Cookie options ──────────────────────────────────────────────────────────

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: ENVIRONMENT === "production",
  sameSite: "strict",
  signed: true,
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
};

module.exports = {
  ENVIRONMENT,
  GAME_MODES,
  COOKIE_OPTIONS,
  MONETIZATION,
  MONETIZATION_MODELS,
  POT_MULTIPLIERS,
  FRAUD_SUSPICION_THRESHOLD,
  QUESTIONS_PER_MATCH,
  TIEBREAK_MODE,
  TIEBREAK_MODES,
  SUDDEN_DEATH_MAX_ROUNDS,
  DISCRIMINATOR_SEED_COUNT,
  DISCRIMINATOR_MODEL,
  isPotMode,
  isSubscriptionMode,
};
