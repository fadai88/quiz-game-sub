/**
 * config/schemas.js
 * All Joi validation schemas for socket events and HTTP endpoints.
 */

const Joi = require("joi");
const { PublicKey } = require("@solana/web3.js");
const { VALID_BET_AMOUNTS_ATOMIC } = require("../utils/usdcUtils");

// ─── Reusable primitives ──────────────────────────────────────────────────────

const solanaPublicKey = Joi.string()
  .required()
  .custom((value, helpers) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
      return helpers.error("any.invalid", {
        message: "Invalid Solana public key format",
      });
    }
    try {
      new PublicKey(value);
      return value;
    } catch {
      return helpers.error("any.invalid", {
        message: "Invalid Solana public key",
      });
    }
  }, "Solana Public Key Validation");

const nonceSchema = Joi.string().guid({ version: "uuidv4" }).required();

const roomIdSchema = Joi.string()
  .pattern(/^[a-zA-Z0-9_-]+$/)
  .min(1)
  .max(100)
  .required()
  .messages({
    "string.pattern.base":
      "Room ID must contain only alphanumeric characters, hyphens, and underscores",
    "string.min": "Room ID must be at least 1 character",
    "string.max": "Room ID cannot exceed 100 characters",
  });

const questionIdSchema = Joi.string()
  .pattern(
    /^[a-zA-Z0-9_-]+-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
  )
  .min(1)
  .max(150)
  .required()
  .messages({
    "string.pattern.base": "Question ID must be in format: roomId-uuid",
    "string.max": "Question ID cannot exceed 150 characters",
  });

// ─── Socket event schemas ─────────────────────────────────────────────────────

const transactionSchema = Joi.object({
  walletAddress: solanaPublicKey,
  betAmount: Joi.number()
    .integer()
    .valid(...VALID_BET_AMOUNTS_ATOMIC)
    .required(),
  transactionSignature: Joi.string().required(),
  nonce: nonceSchema,
  gameMode: Joi.string().optional(),
  recaptchaToken: Joi.string().required(),
});

const submitAnswerSchema = Joi.object({
  roomId: roomIdSchema,
  questionId: questionIdSchema,
  answer: Joi.number().integer().min(-1).max(3).required().messages({
    "number.min": "Answer must be -1 (timeout) or 0-3 (option index)",
    "number.max": "Answer index cannot exceed 3",
  }),
  recaptchaToken: Joi.string().optional().allow(null, ""),
  // Optional, untrusted anti-cheat telemetry self-reported by the client
  // (tab-visibility / focus signals). Bounded so a malicious client can't stuff
  // arbitrary payloads; unknown keys are stripped. Never treated as truth.
  clientSignals: Joi.object({
    visibilityChanges: Joi.number().integer().min(0).max(10000).optional(),
    blurEvents: Joi.number().integer().min(0).max(10000).optional(),
    focusEvents: Joi.number().integer().min(0).max(10000).optional(),
    copyEvents: Joi.number().integer().min(0).max(10000).optional(),
    hidden: Joi.boolean().optional(),
  }).optional(),
});

const playerReadySchema = Joi.object({
  roomId: roomIdSchema,
  preferredMode: Joi.string().valid("human", "bot").optional(),
  recaptchaToken: Joi.string().optional(),
});

const switchToBotSchema = Joi.object({ roomId: roomIdSchema });
const requestBotRoomSchema = Joi.object({
  betAmount: Joi.number()
    .integer()
    .valid(...VALID_BET_AMOUNTS_ATOMIC)
    .required(),
  transactionSignature: Joi.when("betAmount", {
    is: Joi.number().greater(0),
    then: Joi.string().required(),
    otherwise: Joi.string().optional(),
  }),
  nonce: Joi.when("betAmount", {
    is: Joi.number().greater(0),
    then: nonceSchema,
    otherwise: nonceSchema.optional(),
  }),
  recaptchaToken: Joi.string().optional(),
});
const requestBotGameSchema = Joi.object({ roomId: roomIdSchema });
const leaveRoomSchema = Joi.object({ roomId: roomIdSchema });
const matchFoundSchema = Joi.object({ newRoomId: roomIdSchema });

const joinPracticeGameSchema = Joi.object({
  gameMode: Joi.string().valid("bot", "human").optional().default("bot"),
});

const joinHumanMatchmakingSchema = Joi.object({
  betAmount: Joi.number()
    .integer()
    .valid(0, ...VALID_BET_AMOUNTS_ATOMIC)
    .default(0)
    .optional(),
});

// Pot mode: entering the queue means real USDC has already moved to the
// treasury, so the stake proof is mandatory and the bet cannot be zero.
//
// recaptchaToken is shape-checked but not required here: verifyRecaptcha() is
// the policy owner and short-circuits when ENABLE_RECAPTCHA is off, so making
// it required would reject every dev request before that check could run.
const joinHumanMatchmakingPotSchema = Joi.object({
  betAmount: Joi.number()
    .integer()
    .valid(...VALID_BET_AMOUNTS_ATOMIC)
    .required(),
  transactionSignature: Joi.string().required(),
  nonce: nonceSchema,
  recaptchaToken: Joi.string().allow(null, "").optional(),
});

const joinTournamentGameSchema = Joi.object({
  tournamentId: Joi.string()
    .pattern(/^[a-f0-9]{24}$/)
    .required()
    .messages({ "string.pattern.base": "Invalid tournament ID format" }),
});

const subscribeSchema = Joi.object({
  walletAddress: solanaPublicKey,
  transactionSignature: Joi.string().required(),
  plan: Joi.string().valid("monthly", "yearly").required(),
});

// ─── HTTP endpoint schemas ────────────────────────────────────────────────────

const loginSchema = Joi.object({
  walletAddress: solanaPublicKey,
  verifyToken: Joi.string().required(),
  recaptchaToken:
    process.env.ENABLE_RECAPTCHA === "true"
      ? Joi.string().required()
      : Joi.string().optional(),
  clientData: Joi.object().optional(),
});

const walletParamSchema = Joi.object({ wallet: solanaPublicKey });

const paymentIdParamSchema = Joi.object({
  paymentId: Joi.string()
    .pattern(/^[a-f0-9]{24}$/)
    .required()
    .messages({ "string.pattern.base": "Invalid payment ID format" }),
});

const createTournamentSchema = Joi.object({
  name: Joi.string().min(3).max(100).required(),
  description: Joi.string().max(500).optional().allow(""),
  type: Joi.string().valid("scheduled", "on_demand").default("scheduled"),
  format: Joi.string()
    .valid("single_elimination", "round_robin", "bracket")
    .default("single_elimination"),
  startTime: Joi.date().iso().greater("now").required(),
  registrationDeadline: Joi.date()
    .iso()
    .less(Joi.ref("startTime"))
    .required()
    .messages({
      "date.less": "Registration deadline must be before start time",
    }),
  minPlayers: Joi.number().integer().min(4).max(128).default(4),
  maxPlayers: Joi.number()
    .integer()
    .min(Joi.ref("minPlayers"))
    .max(256)
    .default(100),
  entryFee: Joi.number().min(0).default(0),
  prizePool: Joi.number().min(0).default(0),
  currency: Joi.string().valid("USDC", "SOL").default("USDC"),
  questionsPerGame: Joi.number().integer().min(5).max(30).default(10),
  timePerQuestion: Joi.number().integer().min(10).max(60).default(15),
  categories: Joi.array().items(Joi.string()).default([]),
});

module.exports = {
  // primitives (reusable in other modules)
  solanaPublicKey,
  nonceSchema,
  roomIdSchema,
  questionIdSchema,
  // socket schemas
  transactionSchema,
  submitAnswerSchema,
  playerReadySchema,
  switchToBotSchema,
  requestBotRoomSchema,
  requestBotGameSchema,
  leaveRoomSchema,
  matchFoundSchema,
  joinPracticeGameSchema,
  joinHumanMatchmakingSchema,
  joinHumanMatchmakingPotSchema,
  joinTournamentGameSchema,
  subscribeSchema,
  // HTTP schemas
  loginSchema,
  walletParamSchema,
  paymentIdParamSchema,
  createTournamentSchema,
};
