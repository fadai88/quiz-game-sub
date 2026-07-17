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
  isPotMode,
  isSubscriptionMode,
};
