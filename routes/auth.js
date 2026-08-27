/**
 * routes/auth.js
 * HTTP authentication endpoints: login, logout, session check.
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const logger = require("../logger");
const context = require("../context");
const User = require("../models/User");
const { loginSchema } = require("../config/schemas");
const { COOKIE_OPTIONS } = require("../config/constants");
const { verifyRecaptcha } = require("../utils/helpers");
const { SecurityLogger } = require("../utils/securityLogger");
const {
  trackValidationFailure,
  trackFailedLogin,
} = require("../config/alerts");
const { getClientIpFromRequest } = require("../middleware/trustedProxy");

// ─── POST /api/auth/login ─────────────────────────────────────────────────────

router.post("/login", async (req, res) => {
  try {
    const clientIp = getClientIpFromRequest(req);
    const { error, value } = loginSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      const errorDetails = error.details.map((d) => d.message).join("; ");
      trackValidationFailure(clientIp, "login", errorDetails);
      logger.warn(
        `[SECURITY] Validation failed for login from ${clientIp}: ${errorDetails}`
      );
      return res
        .status(400)
        .json({ success: false, error: "Invalid input data" });
    }

    const { walletAddress, verifyToken, recaptchaToken } = value;
    const redisClient = context.redisClient;

    // Atomically consume the one-time verify token. DEL returns 1 only if the key
    // existed; concurrent requests with the same token all get 0 after the first.
    const deletedCount = await redisClient.del(
      `verify:${walletAddress}:${verifyToken}`
    );
    if (deletedCount === 0) {
      SecurityLogger.invalidToken(walletAddress, "expired_or_invalid");
      trackFailedLogin(clientIp, {
        walletAddress,
        reason: "invalid_or_expired_token",
      });
      return res.status(401).json({
        success: false,
        error: "Invalid verification. Please try logging in again.",
      });
    }
    logger.auth(`Verification token validated for ${walletAddress}`);

    // reCAPTCHA (if enabled)
    if (process.env.ENABLE_RECAPTCHA === "true") {
      if (!recaptchaToken)
        return res
          .status(400)
          .json({ success: false, error: "reCAPTCHA required" });
      const result = await verifyRecaptcha(recaptchaToken);
      if (!result.success)
        return res
          .status(400)
          .json({ success: false, error: "reCAPTCHA failed" });
    }

    const connectionData = {
      ip: clientIp,
      userAgent: req.headers["user-agent"],
    };

    let user = await User.findOne({ walletAddress });
    if (!user) {
      user = await User.create({
        walletAddress,
        registrationIP: connectionData.ip,
        registrationDate: new Date(),
        lastLoginIP: connectionData.ip,
        lastLoginDate: new Date(),
        userAgent: connectionData.userAgent,
        recentQuestions: [],
      });
    } else {
      user.lastLoginIP = connectionData.ip;
      user.lastLoginDate = new Date();
      user.userAgent = connectionData.userAgent;
      await user.save();
    }

    // Fingerprint is derived from server-observed data only — never trust client-provided values.
    const fingerprint = crypto
      .createHash("sha256")
      .update(`${connectionData.ip}:${connectionData.userAgent}`)
      .digest("hex");
    user.deviceFingerprint = fingerprint;
    await user.save();

    const sessionToken = crypto.randomBytes(32).toString("hex");
    const sessionData = {
      walletAddress,
      fingerprint,
      timestamp: Date.now(),
      ip: connectionData.ip,
      userAgent: connectionData.userAgent,
      // Self-declared and therefore untrusted — kept for telemetry only. The
      // staked-play gate keys off `attested`, which is server-verified against
      // the platform attestation service (see services/attestation.js).
      clientType: req.headers["x-client-type"] === "native" ? "native" : "web",
    };

    await redisClient.set(
      `session:${sessionToken}`,
      JSON.stringify(sessionData),
      "EX",
      86400
    );
    await redisClient.set(
      `session:wallet:${walletAddress}`,
      sessionToken,
      "EX",
      86400
    );

    logger.info(`[SESSION] HTTP login successful for ${walletAddress}`);
    res.cookie("sessionToken", sessionToken, COOKIE_OPTIONS);

    // The native app has no cookie jar, so it needs the token in the body to
    // send as `Authorization: Bearer` / socket handshake auth. This hands the
    // caller nothing it isn't already receiving as a cookie; the header gate is
    // what keeps the token out of browser-visible responses, where HttpOnly is
    // the defence against XSS reading it.
    const isNativeClient = req.headers["x-client-type"] === "native";

    res.json({
      success: true,
      virtualBalance: user.virtualBalance,
      ...(isNativeClient ? { sessionToken } : {}),
    });
  } catch (error) {
    logger.error("[AUTH] HTTP login error:", { error });
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────

router.post("/logout", async (req, res) => {
  const { sessionToken } = req.signedCookies;
  if (sessionToken) {
    const raw = await context.redisClient
      .get(`session:${sessionToken}`)
      .catch(() => null);
    const walletAddress = raw ? JSON.parse(raw).walletAddress : null;
    await context.redisClient
      .del(`session:${sessionToken}`)
      .catch(console.error);
    if (walletAddress)
      await context.redisClient
        .del(`session:wallet:${walletAddress}`)
        .catch(console.error);
  }
  res.clearCookie("sessionToken");
  res.json({ success: true });
});

// ─── GET /api/auth/session ────────────────────────────────────────────────────

router.get("/session", async (req, res) => {
  try {
    const { sessionToken } = req.signedCookies;
    if (!sessionToken) return res.status(401).json({ authenticated: false });

    const sessionDataStr = await context.redisClient.get(
      `session:${sessionToken}`
    );
    if (!sessionDataStr) {
      res.clearCookie("sessionToken");
      return res.status(401).json({ authenticated: false });
    }

    const sessionData = JSON.parse(sessionDataStr);
    const user = await User.findOne({
      walletAddress: sessionData.walletAddress,
    });
    res.json({
      authenticated: true,
      walletAddress: sessionData.walletAddress,
      virtualBalance: user?.virtualBalance || 0,
    });
  } catch (error) {
    logger.error("[AUTH] Session validation error:", { error });
    res.status(500).json({ authenticated: false });
  }
});

module.exports = router;
