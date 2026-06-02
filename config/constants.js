/**
 * config/constants.js
 * Application constants and startup environment validation.
 */

const ENVIRONMENT = process.env.NODE_ENV || "development";

const GAME_MODES = {
  PRACTICE: "practice", // Free users — bot or single-player
  RANKED: "ranked", // Premium users — human vs human with bet
  BOT: "bot", // Bot game room mode
  TOURNAMENT: "tournament", // Premium users — tournament bracket
};

// ─── Startup validation ──────────────────────────────────────────────────────

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

module.exports = { ENVIRONMENT, GAME_MODES, COOKIE_OPTIONS };
