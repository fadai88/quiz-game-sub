/**
 * services/attestation.js
 * Device attestation — proof that a staked match is being played from the real
 * app binary on a genuine, unrooted device.
 *
 * Why: everything else in the anti-cheat system (AnswerTelemetry, riskScore,
 * discriminators) is *detection* — it catches cheating after the fact. This is
 * the one *prevention* lever: the web client is fully adversary-controlled, so a
 * headless browser, a DOM scraper or an LLM in a second tab is indistinguishable
 * from a real player. Platform attestation makes that whole class of cheap,
 * scalable attacks stop working. It does NOT stop a second phone pointed at the
 * screen — see docs/ANTICHEAT_AND_CALIBRATION.md.
 *
 * Structure: providers only *decode* a token into a verdict payload; the policy
 * that decides whether a payload is acceptable is shared (`evaluateVerdict`), so
 * the mock provider used by tests and local dev exercises the real policy code.
 *
 * Nothing here throws into the game path — callers get result objects.
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const logger = require("../logger");
const DeviceAttestation = require("../models/DeviceAttestation");
const { USDC_MULTIPLIER } = require("../utils/usdcUtils");
const {
  getAttestationProvider,
  getAttestationMaxAgeMs,
  isPlayRecognizedRequired,
  isStakedAttestationRequired,
  getStakedWebMaxBetUsdc,
} = require("../config/constants");

const MEETS_DEVICE_INTEGRITY = "MEETS_DEVICE_INTEGRITY";
const PLAY_RECOGNIZED = "PLAY_RECOGNIZED";

// ─── Device id ────────────────────────────────────────────────────────────────

/**
 * Hash the app's install secret. The raw secret never reaches the database, so a
 * database leak cannot be replayed as a device identity.
 */
function hashDeviceSecret(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

// ─── Nonce ────────────────────────────────────────────────────────────────────

// URL-safe so it survives the round trip through the platform integrity API.
function generateNonce() {
  return crypto.randomBytes(32).toString("base64url");
}

// ─── Shared verdict policy ────────────────────────────────────────────────────

/**
 * Decide whether a decoded integrity payload is acceptable.
 *
 * @param {object} payload  decoded token (Play Integrity shape)
 * @param {object} opts     { expectedNonce, expectedPackage }
 * @returns {{ok: boolean, code?: string, reason?: string, verdicts: object}}
 */
function evaluateVerdict(payload, { expectedNonce, expectedPackage } = {}) {
  const requestDetails = payload?.requestDetails || {};
  const appIntegrity = payload?.appIntegrity || {};
  const deviceIntegrity = payload?.deviceIntegrity || {};

  const deviceVerdicts = Array.isArray(deviceIntegrity.deviceRecognitionVerdict)
    ? deviceIntegrity.deviceRecognitionVerdict
    : [];

  const verdicts = {
    packageName: requestDetails.requestPackageName,
    appRecognitionVerdict: appIntegrity.appRecognitionVerdict,
    deviceRecognitionVerdict: deviceVerdicts,
    appLicensingVerdict: payload?.accountDetails?.appLicensingVerdict,
    timestampMillis: requestDetails.timestampMillis,
  };

  const fail = (code, reason) => ({ ok: false, code, reason, verdicts });

  // The nonce is what stops a token captured from one device being replayed by
  // another: it is single-use and issued per request.
  if (!expectedNonce || requestDetails.nonce !== expectedNonce) {
    return fail("NONCE_MISMATCH", "Attestation nonce did not match");
  }

  if (
    expectedPackage &&
    requestDetails.requestPackageName !== expectedPackage
  ) {
    return fail(
      "PACKAGE_MISMATCH",
      `Attestation came from an unexpected package (${requestDetails.requestPackageName})`
    );
  }

  // Freshness of the token itself, independent of when the session was marked
  // attested. Google signs timestampMillis, so this cannot be forged forward.
  const ts = Number(requestDetails.timestampMillis);
  if (Number.isFinite(ts)) {
    const age = Date.now() - ts;
    if (age > getAttestationMaxAgeMs()) {
      return fail("TOKEN_STALE", `Attestation token is ${age}ms old`);
    }
  }

  if (!deviceVerdicts.includes(MEETS_DEVICE_INTEGRITY)) {
    return fail(
      "DEVICE_INTEGRITY_FAILED",
      `Device did not meet integrity (${deviceVerdicts.join(",") || "none"})`
    );
  }

  // A sideloaded closed-beta APK reports UNRECOGNIZED_VERSION even on a healthy
  // device, so this check is opt-out for the beta.
  if (
    isPlayRecognizedRequired() &&
    appIntegrity.appRecognitionVerdict !== PLAY_RECOGNIZED
  ) {
    return fail(
      "APP_NOT_RECOGNIZED",
      `App binary not recognized (${appIntegrity.appRecognitionVerdict})`
    );
  }

  return { ok: true, verdicts };
}

// ─── Providers (decode only) ──────────────────────────────────────────────────

/**
 * Mock provider — the token IS the payload, as JSON. Used by tests and local dev
 * so the whole flow (nonce, policy, session marking, device records) can be
 * exercised before an Android build exists.
 *
 * SECURITY: this provider trusts whatever the client sends, so anyone could hand
 * it a payload claiming a healthy device. That is fine in dev and fatal in
 * production — an attacker would become "attested" and inherit everything that
 * status grants (staking access, the reCAPTCHA exemption). It is refused outright
 * when NODE_ENV=production, which also means a production deployment that never
 * configures ATTESTATION_PROVIDER simply cannot attest anyone, rather than
 * attesting everyone.
 */
function decodeMockToken(token) {
  // Read live rather than via the load-time ENVIRONMENT const so this is
  // testable, in keeping with the other attestation config.
  if ((process.env.NODE_ENV || "development") === "production") {
    throw new Error(
      "The mock attestation provider is not allowed in production"
    );
  }
  return JSON.parse(token);
}

// Google service-account access tokens, cached until shortly before expiry.
let googleToken = { value: null, expiresAt: 0 };

function loadServiceAccount() {
  const raw = process.env.GOOGLE_PLAY_INTEGRITY_CREDENTIALS;
  if (!raw) {
    throw new Error("GOOGLE_PLAY_INTEGRITY_CREDENTIALS is not set");
  }
  // Accept either the JSON itself or a path to it, so deployments can use a
  // secret manager (env) or a mounted file without extra config.
  const json = raw.trim().startsWith("{")
    ? raw
    : require("fs").readFileSync(raw, "utf8");
  return JSON.parse(json);
}

async function getGoogleAccessToken() {
  if (googleToken.value && Date.now() < googleToken.expiresAt) {
    return googleToken.value;
  }

  const sa = loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/playintegrity",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    sa.private_key,
    { algorithm: "RS256" }
  );

  const { data } = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10_000,
    }
  );

  googleToken = {
    value: data.access_token,
    // Renew a minute early rather than racing the expiry.
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return googleToken.value;
}

/**
 * Play Integrity. Decoding happens server-side at Google (decodeIntegrityToken)
 * so we never handle the decryption keys ourselves.
 */
async function decodePlayIntegrityToken(token) {
  const packageName = process.env.ANDROID_PACKAGE_NAME;
  if (!packageName) throw new Error("ANDROID_PACKAGE_NAME is not set");

  const accessToken = await getGoogleAccessToken();
  const { data } = await axios.post(
    `https://playintegrity.googleapis.com/v1/${encodeURIComponent(
      packageName
    )}:decodeIntegrityToken`,
    { integrity_token: token },
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    }
  );
  return data?.tokenPayloadExternal || {};
}

function decodeAppleToken() {
  // Phase 3 (iOS App Attest / DeviceCheck). Android ships first.
  throw new Error("Apple App Attest is not implemented yet");
}

async function decodeToken(token, provider) {
  switch (provider) {
    case "mock":
      return decodeMockToken(token);
    case "google":
      return decodePlayIntegrityToken(token);
    case "apple":
      return decodeAppleToken(token);
    default:
      throw new Error(`Unknown ATTESTATION_PROVIDER "${provider}"`);
  }
}

// ─── Verification entry point ─────────────────────────────────────────────────

/**
 * Verify an attestation token. Never throws.
 *
 * @returns {{ok: boolean, code?: string, reason?: string, deviceId?: string,
 *            platform?: string, verdicts?: object}}
 */
async function verifyAttestation({ token, nonce, deviceSecret, platform }) {
  const provider = getAttestationProvider();
  try {
    const payload = await decodeToken(token, provider);
    const result = evaluateVerdict(payload, {
      expectedNonce: nonce,
      expectedPackage: process.env.ANDROID_PACKAGE_NAME || null,
    });

    return {
      ...result,
      deviceId: deviceSecret ? hashDeviceSecret(deviceSecret) : undefined,
      platform: platform || (provider === "google" ? "android" : provider),
    };
  } catch (error) {
    // Decode failures are logged but never surfaced verbatim to the client —
    // error text from the provider can leak configuration details.
    logger.warn("[attestation] verification failed", {
      provider,
      error: error.message,
    });
    return {
      ok: false,
      code: "VERIFICATION_ERROR",
      reason: "Attestation could not be verified",
    };
  }
}

/**
 * Record the outcome against the device. Best-effort: a bookkeeping failure must
 * not block a player who legitimately passed attestation.
 */
async function recordAttestation({ deviceId, platform, wallet, verdicts, ok }) {
  if (!deviceId) return null;
  try {
    return await DeviceAttestation.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          platform,
          lastSeen: new Date(),
          ...(verdicts ? { lastVerdicts: verdicts } : {}),
        },
        $setOnInsert: { firstSeen: new Date() },
        $inc: ok ? { verifyCount: 1 } : { failCount: 1 },
        // Only successful attestations bind a wallet to a device — otherwise a
        // spoofed failing request could pollute another device's wallet list.
        ...(ok && wallet ? { $addToSet: { wallets: wallet } } : {}),
      },
      { upsert: true, new: true }
    );
  } catch (error) {
    logger.warn("[attestation] could not record device", {
      error: error.message,
    });
    return null;
  }
}

// ─── The staked-play gate ─────────────────────────────────────────────────────

/**
 * Is this session currently attested — i.e. server-verified AND still fresh?
 *
 * Shared so that every consumer (the staking gate, the reCAPTCHA exemption)
 * means exactly the same thing by "attested". A session that attested an hour
 * ago is not attested now.
 */
function isSessionAttested(sessionData) {
  if (!sessionData || !sessionData.attested) return false;
  const age = Date.now() - Number(sessionData.attestedAt || 0);
  return age <= getAttestationMaxAgeMs();
}

/**
 * The single place the native-only-staking policy lives. Pure — no I/O — so the
 * call sites in socket/index.js stay simple and the policy is directly testable.
 *
 * @param {object} sessionData  the Redis session record (attested, attestedAt…)
 * @param {number} betAmount    stake in USDC *atomic* units (0 = free play)
 * @returns {{allowed: boolean, code?: string, reason?: string}}
 */
function assertStakedClientAllowed(sessionData, betAmount) {
  if (!isStakedAttestationRequired()) return { allowed: true };

  // Practice and any other free play is never gated — the whole point of the
  // web client after this lands is that it remains a free on-ramp.
  const bet = Number(betAmount) || 0;
  if (bet <= 0) return { allowed: true };

  if (isSessionAttested(sessionData)) return { allowed: true };

  if (sessionData?.attested) {
    // Attested once, but too long ago. Distinct from "no app at all": the client
    // should silently re-attest, not tell the player to go and install
    // something they already have.
    return {
      allowed: false,
      code: "ATTESTATION_STALE",
      reason: "Attestation expired — please retry.",
    };
  }

  // Soft rollout: unattested web clients may still play small stakes.
  const capUsdc = getStakedWebMaxBetUsdc();
  if (capUsdc !== null && bet <= capUsdc * USDC_MULTIPLIER) {
    return { allowed: true };
  }

  return {
    allowed: false,
    code: "NATIVE_CLIENT_REQUIRED",
    reason:
      capUsdc !== null
        ? `Stakes above ${capUsdc} USDC require the mobile app.`
        : "Staked games require the mobile app.",
  };
}

module.exports = {
  hashDeviceSecret,
  generateNonce,
  evaluateVerdict,
  verifyAttestation,
  recordAttestation,
  isSessionAttested,
  assertStakedClientAllowed,
  // exported for tests
  MEETS_DEVICE_INTEGRITY,
  PLAY_RECOGNIZED,
};
