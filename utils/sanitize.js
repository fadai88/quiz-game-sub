/**
 * utils/sanitize.js
 * Input / output / error sanitization helpers.
 * All user-supplied data must pass through these before hitting Redis, MongoDB,
 * external APIs, or being sent back to clients.
 */

const { v4: uuidv4 } = require("uuid");
const logger = require("../logger");

// ─── HTML sanitizer (graceful fallback if package not installed) ──────────────

let sanitizeHtml;
try {
  sanitizeHtml = require("sanitize-html");
  console.log("✅ sanitize-html loaded for XSS protection");
} catch {
  console.warn(
    "⚠️  sanitize-html not installed. Using basic fallback. Run: npm install sanitize-html"
  );
  sanitizeHtml = (dirty) => {
    if (typeof dirty !== "string") return String(dirty);
    return dirty
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;")
      .replace(/\//g, "&#x2F;");
  };
}

// ─── Log sanitization ─────────────────────────────────────────────────────────

/**
 * Remove control characters and cap length — prevents log injection.
 */
function sanitizeForLog(input) {
  if (typeof input !== "string") return String(input);
  return input.replace(/[\x00-\x1F\x7F]/g, "").substring(0, 100);
}

// ─── Output sanitization (XSS) ───────────────────────────────────────────────

/**
 * Strip all HTML tags — safe for rendering untrusted content in the UI.
 */
function sanitizeOutput(dirty) {
  return sanitizeHtml(dirty, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
  });
}

/**
 * Allow minimal safe formatting tags (b, i, em, strong, br).
 */
function sanitizeText(text) {
  if (typeof text !== "string") return String(text);
  return sanitizeHtml(text, {
    allowedTags: ["b", "i", "em", "strong", "br"],
    allowedAttributes: {},
    disallowedTagsMode: "escape",
  });
}

// ─── Error sanitization (information-disclosure prevention) ──────────────────

/**
 * Log the full error server-side; return a safe generic response to the client.
 * @param {Error}  error
 * @param {string} context - descriptive label for server logs
 * @param {string} [userMessage] - optional override for the client-facing message
 */
function sanitizeError(error, context, userMessage = null) {
  const errorId = uuidv4().substring(0, 8);
  logger.error(`[ERROR:${errorId}] ${context}:`);
  logger.error(`  Message: ${error.message}`);
  logger.error(`  Stack: ${error.stack}`);
  if (error.code) logger.error(`  Code: ${error.code}`);

  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    return {
      error: userMessage || "An error occurred. Please try again.",
      code: "SERVER_ERROR",
      errorId,
    };
  }
  return {
    error: userMessage || "An error occurred",
    message: sanitizeForLog(error.message),
    code: error.code || "UNKNOWN",
    errorId,
    context,
  };
}

/**
 * Sanitize Joi validation errors (less sensitive, but still scrubbed).
 */
function sanitizeValidationError(validationError, context) {
  const errorId = uuidv4().substring(0, 8);
  console.error(`[VALIDATION:${errorId}] ${context}:`, validationError.message);

  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    return { error: "Invalid input format", code: "VALIDATION_ERROR", errorId };
  }
  const fields = validationError.details?.map((d) => d.path.join(".")) || [];
  return {
    error: "Validation failed",
    fields,
    code: "VALIDATION_ERROR",
    errorId,
  };
}

module.exports = {
  sanitizeForLog,
  sanitizeOutput,
  sanitizeText,
  sanitizeError,
  sanitizeValidationError,
};
