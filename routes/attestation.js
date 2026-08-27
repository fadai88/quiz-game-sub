/**
 * routes/attestation.js
 * Device-attestation endpoints: /api/attest/nonce and /api/attest/verify.
 *
 * Flow (native app, immediately before a staked join):
 *   1. POST /nonce   → server issues a single-use nonce
 *   2. app asks the platform (Play Integrity) for a token bound to that nonce
 *   3. POST /verify  → server decodes + checks the verdicts, marks the session
 *                      attested, and records the device
 *   4. the staked-join gate in socket/index.js reads that session state
 *
 * The session is marked attested for a deliberately short window
 * (ATTESTATION_MAX_AGE_MS, default 5 min) — the app re-attests per stake rather
 * than once per login, so a captured token is worthless minutes later.
 */

const express = require("express");
const router = express.Router();

const logger = require("../logger");
const context = require("../context");
const { authenticate } = require("../middleware/authenticate");
const { attestVerifySchema } = require("../config/schemas");
const { getAttestationMaxAgeMs } = require("../config/constants");
const {
  generateNonce,
  verifyAttestation,
  recordAttestation,
} = require("../services/attestation");

const NONCE_TTL_SECONDS = 120;

// ─── POST /api/attest/nonce ───────────────────────────────────────────────────

router.post("/nonce", authenticate, async (req, res) => {
  try {
    const { walletAddress } = req.user;
    const nonce = generateNonce();

    // Same one-time-token pattern as the login verify token in routes/auth.js:
    // stored under a key that /verify consumes with an atomic DEL, so a nonce
    // cannot be used twice even by concurrent requests.
    await context.redisClient.set(
      `attest:nonce:${walletAddress}:${nonce}`,
      "1",
      "EX",
      NONCE_TTL_SECONDS
    );

    res.json({ success: true, nonce, expiresIn: NONCE_TTL_SECONDS });
  } catch (error) {
    logger.error("[ATTEST] Nonce issue failed:", { error: error.message });
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─── POST /api/attest/verify ──────────────────────────────────────────────────

router.post("/verify", authenticate, async (req, res) => {
  try {
    const { error, value } = attestVerifySchema.validate(req.body, {
      stripUnknown: true,
    });
    if (error) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid input data" });
    }

    const { walletAddress } = req.user;
    const { token, nonce, deviceSecret, platform } = value;

    // Consume the nonce first: DEL returns 1 only for the first caller, so a
    // replayed token can never be re-verified.
    const consumed = await context.redisClient.del(
      `attest:nonce:${walletAddress}:${nonce}`
    );
    if (consumed === 0) {
      return res.status(401).json({
        success: false,
        attested: false,
        code: "NONCE_INVALID",
        error: "Attestation nonce expired or already used",
      });
    }

    const result = await verifyAttestation({
      token,
      nonce,
      deviceSecret,
      platform,
    });

    // Record the attempt either way — repeated failures from one device are
    // themselves a signal worth keeping.
    await recordAttestation({
      deviceId: result.deviceId,
      platform: result.platform || platform,
      wallet: walletAddress,
      verdicts: result.verdicts,
      ok: result.ok,
    });

    if (!result.ok) {
      logger.warn("[ATTEST] Attestation rejected", {
        wallet: walletAddress,
        code: result.code,
        reason: result.reason,
      });
      return res.status(403).json({
        success: false,
        attested: false,
        code: result.code,
        error: result.reason,
      });
    }

    // Mark the session attested. Read-modify-write on the existing record so no
    // other session field is clobbered, and preserve the remaining TTL rather
    // than silently extending the session's life.
    const sessionKey = `session:${req.sessionToken}`;
    const ttl = await context.redisClient.ttl(sessionKey);
    const attestedAt = Date.now();
    const sessionData = {
      ...(req.sessionData || {}),
      clientType: "native",
      attested: true,
      attestedAt,
      deviceId: result.deviceId,
      platform: result.platform || platform,
    };
    if (ttl > 0) {
      await context.redisClient.set(
        sessionKey,
        JSON.stringify(sessionData),
        "EX",
        ttl
      );
    } else {
      await context.redisClient.set(sessionKey, JSON.stringify(sessionData));
    }

    logger.info(`[ATTEST] Session attested for ${walletAddress} (${platform})`);
    res.json({
      success: true,
      attested: true,
      expiresAt: attestedAt + getAttestationMaxAgeMs(),
    });
  } catch (error) {
    logger.error("[ATTEST] Verify failed:", { error: error.message });
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
