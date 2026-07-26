/**
 * services/redisService.js
 * Redis client initialisation, health monitoring, and operation helpers.
 */

const Redis = require("ioredis");
const { createAdapter } = require("@socket.io/redis-adapter");
const { RateLimiterRedis } = require("rate-limiter-flexible");
const logger = require("../logger");
const context = require("../context");
const { trackRedisReconnect } = require("../config/alerts");

// ─── Per-event rate limiters (populated by initializeRateLimiter) ─────────────
const eventLimiters = new Map();
let socketRateLimiter;

async function initializeRateLimiter(redisClient) {
  try {
    socketRateLimiter = new RateLimiterRedis({
      storeClient: redisClient,
      points: 200,
      duration: 60,
      keyPrefix: "socket",
    });

    const eventDefs = [
      { name: "submitAnswer", points: 20, duration: 30, blockDuration: 300 },
      { name: "joinGame", points: 5, duration: 60, blockDuration: 180 },
      {
        name: "joinHumanMatchmaking",
        points: 5,
        duration: 60,
        blockDuration: 180,
      },
      { name: "joinBotGame", points: 8, duration: 60, blockDuration: 120 },
      { name: "requestBotRoom", points: 5, duration: 60, blockDuration: 180 },
      { name: "switchToBot", points: 5, duration: 60, blockDuration: 120 },
      { name: "requestBotGame", points: 8, duration: 60, blockDuration: 120 },
      {
        name: "joinPracticeGame",
        points: 10,
        duration: 60,
        blockDuration: 120,
      },
      {
        name: "joinTournamentGame",
        points: 5,
        duration: 60,
        blockDuration: 180,
      },
      { name: "subscribe", points: 3, duration: 60, blockDuration: 300 },
      { name: "playerReady", points: 20, duration: 60, blockDuration: 60 },
      { name: "leaveRoom", points: 15, duration: 60, blockDuration: 60 },
    ];

    for (const def of eventDefs) {
      eventLimiters.set(
        def.name,
        new RateLimiterRedis({
          storeClient: redisClient,
          points: def.points,
          duration: def.duration,
          blockDuration: def.blockDuration,
          keyPrefix: `event:${def.name}`,
        })
      );
    }

    console.log("✅ Socket and per-event rate-limiters initialized");
  } catch (error) {
    logger.error("❌ Failed to init rate-limiter:", { error });
  }
}

// ─── Redis init ───────────────────────────────────────────────────────────────

// Build TLS options for Redis, verifying certificates by DEFAULT. Redis is part
// of the security boundary here (sessions, login challenges, nonce/replay state,
// blocklists, rate limits), so an unverified TLS connection is a MITM hole.
//   - Private-CA / self-signed server → set REDIS_CA_CERT (PEM) rather than
//     disabling verification.
//   - REDIS_TLS_REJECT_UNAUTHORIZED=false is allowed only OUTSIDE production; in
//     production it is a deploy-blocking misconfiguration.
function buildRedisTlsOptions() {
  const isProd = (process.env.NODE_ENV || "development") === "production";
  const reject = process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== "false";

  if (!reject && isProd) {
    console.error(
      "❌ FATAL: REDIS_TLS_REJECT_UNAUTHORIZED=false is not allowed in production — " +
        "it disables Redis TLS certificate verification (MITM risk for sessions, " +
        "nonces, blocklists and rate limits). For a private-CA or self-signed " +
        "Redis, set REDIS_CA_CERT to the CA certificate instead."
    );
    process.exit(1);
  }

  // Platforms often store the PEM with escaped newlines — normalize them.
  const ca = process.env.REDIS_CA_CERT
    ? process.env.REDIS_CA_CERT.replace(/\\n/g, "\n")
    : undefined;

  return { rejectUnauthorized: reject, ...(ca && { ca }) };
}

async function initializeRedis() {
  let redisClient;

  try {
    if (process.env.REDIS_URL) {
      console.log("📡 Using REDIS_URL from environment");
      const useTLS = process.env.REDIS_URL.startsWith("rediss://");
      const opts = {
        keepAlive: 10000,
        family: 4,
        connectTimeout: 20000,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
        enableReadyCheck: true,
        commandTimeout: 5000,
      };
      if (useTLS) {
        opts.tls = buildRedisTlsOptions();
        console.log(
          `🔒 TLS enabled for Redis (verify cert: ${
            opts.tls.rejectUnauthorized
          }${opts.tls.ca ? ", custom CA" : ""})`
        );
      } else {
        console.log("📡 Using non-TLS Redis (Railway internal)");
      }
      redisClient = new Redis(process.env.REDIS_URL, opts);
    } else {
      console.log("🔧 Using individual Redis env vars (local dev)");
      redisClient = new Redis({
        host: process.env.REDIS_HOST || "localhost",
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD,
        tls:
          process.env.REDIS_TLS === "true" ? buildRedisTlsOptions() : undefined,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
        enableReadyCheck: true,
        connectTimeout: 10000,
        commandTimeout: 5000,
      });
    }

    redisClient.on("ready", () => console.log("✅ Redis ready"));
    redisClient.on("connect", () => console.log("Redis connected"));
    redisClient.on("error", (err) =>
      logger.error("⚠️  Redis error (will auto-retry):", { error: err.message })
    );
    redisClient.on("close", () => {
      logger.warn("⚠️  Redis connection closed (will auto-reconnect)");
      trackRedisReconnect({ event: "close" });
    });
    redisClient.on("reconnecting", () => {
      logger.warn("⚠️  Redis reconnecting...");
      trackRedisReconnect({ event: "reconnecting" });
    });

    await redisClient.ping();
    await redisClient.set("test", "1", "EX", 60);
    const testValue = await redisClient.get("test");
    logger.info(`Redis test: ${testValue}`);

    context.set("redisClient", redisClient);

    await initializeRateLimiter(redisClient);

    return redisClient;
  } catch (error) {
    logger.error("Failed to initialize Redis:", { error });
    console.error("Redis unavailable - transaction processing disabled");
    throw error;
  }
}

// ─── Adapter (Socket.IO scaling) ──────────────────────────────────────────────

async function initializeSocketAdapter() {
  const redisClient = context.redisClient;
  const io = context.io;
  if (!redisClient || !io) return;
  try {
    const pubClient = redisClient.duplicate();
    const subClient = redisClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    console.log("Socket.io Redis adapter initialized for scaling");
  } catch (error) {
    logger.error("Failed to initialize Socket.io adapter:", { error });
  }
}

// ─── Operation wrappers ───────────────────────────────────────────────────────

async function safeRedisOp(
  operation,
  fallbackValue = null,
  operationName = "Redis operation"
) {
  try {
    return await operation();
  } catch (error) {
    console.error(`${operationName} failed:`, error.message);
    return fallbackValue;
  }
}

async function criticalRedisOp(
  operation,
  operationName = "Critical Redis operation"
) {
  try {
    return await operation();
  } catch (error) {
    console.error(`${operationName} failed (CRITICAL):`, error.message);
    throw new Error(`Service temporarily unavailable: ${operationName}`);
  }
}

module.exports = {
  initializeRedis,
  initializeSocketAdapter,
  buildRedisTlsOptions,
  safeRedisOp,
  criticalRedisOp,
  eventLimiters,
  get socketRateLimiter() {
    return socketRateLimiter;
  },
};
