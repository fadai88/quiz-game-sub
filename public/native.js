/**
 * public/native.js — the client half of device attestation.
 *
 * Server counterpart: services/attestation.js + routes/attestation.js.
 * Threat model and the reasoning behind it: docs/ANTICHEAT_AND_CALIBRATION.md.
 *
 * Flow, run immediately before each staked join (never once per login — a
 * session counts as attested for only a few minutes, so a captured token is
 * worthless later):
 *
 *   POST /api/attest/nonce   → single-use nonce from the server
 *   PlayIntegrity.requestToken(nonce)  → signed verdict from Google
 *   POST /api/attest/verify  → server checks it and marks the session attested
 *
 * On the web every function here is a no-op that reports "not attested". The
 * server decides what that means: with STAKED_REQUIRES_ATTESTATION off (the
 * default) it means nothing at all and staking proceeds exactly as before.
 *
 * MUST be loaded after net.js (it uses AppNet).
 */
(function () {
  "use strict";

  const isNative = window.AppNet && window.AppNet.isNative;

  // The install secret. Persistent per install, random, and never leaves the
  // device in raw form except to our own server, which stores only its hash.
  // It is NOT a hardware id — Play Integrity deliberately exposes none. What it
  // buys is that many wallets appearing on one install become visible.
  const DEVICE_KEY = "deviceSecret";

  function getDeviceSecret() {
    let secret = null;
    try {
      secret = window.localStorage.getItem(DEVICE_KEY);
    } catch {
      /* storage unavailable — fall through and generate a per-session value */
    }
    if (!secret) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      secret = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      try {
        window.localStorage.setItem(DEVICE_KEY, secret);
      } catch {
        /* not persisted; a reinstall-like new id each launch is the worst case */
      }
    }
    return secret;
  }

  /**
   * Refresh this session's attestation.
   *
   * @returns {Promise<{attested: boolean, reason?: string, code?: string}>}
   *          Never throws — the caller decides whether a failure should block.
   */
  async function attest() {
    if (!isNative) {
      return { attested: false, code: "NOT_NATIVE", reason: "Web client" };
    }

    const plugin =
      window.Capacitor &&
      window.Capacitor.Plugins &&
      window.Capacitor.Plugins.PlayIntegrity;
    if (!plugin) {
      return {
        attested: false,
        code: "PLUGIN_MISSING",
        reason: "Attestation plugin unavailable",
      };
    }

    try {
      const nonceRes = await fetch("/api/attest/nonce", { method: "POST" });
      if (!nonceRes.ok) {
        return {
          attested: false,
          code: "NONCE_FAILED",
          reason: "Could not start device check",
        };
      }
      const { nonce } = await nonceRes.json();

      // Google's round trip. Slow path is a few seconds on a cold classloader.
      const { token } = await plugin.requestToken({ nonce });

      const verifyRes = await fetch("/api/attest/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          nonce,
          deviceSecret: getDeviceSecret(),
          platform: "android",
        }),
      });
      const result = await verifyRes.json();

      if (!verifyRes.ok || !result.attested) {
        return {
          attested: false,
          code: result.code || "VERIFY_FAILED",
          reason: result.error || "Device check failed",
        };
      }
      return { attested: true, expiresAt: result.expiresAt };
    } catch (error) {
      console.warn("[native] attestation error:", error && error.message);
      return {
        attested: false,
        code: "ATTEST_ERROR",
        reason: "Device check could not be completed",
      };
    }
  }

  /**
   * Attest if the server requires it for this stake, and explain the outcome in
   * words a player can act on.
   *
   * Deliberately mirrors the server's policy (services/attestation.js
   * assertStakedClientAllowed) rather than duplicating its rules: the server is
   * still the authority and will refuse the join regardless. The point of
   * checking here is to fail BEFORE the USDC transfer, so a player who cannot
   * stake is never left out of pocket.
   *
   * @param {object} cfg  /api/config response
   * @param {number} betAmount  stake in atomic units
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  async function ensureAttestedForStake(cfg, betAmount) {
    if (!cfg || !cfg.stakedRequiresNative) return { ok: true };
    if (!betAmount || betAmount <= 0) return { ok: true };

    const capUsdc = cfg.stakedWebMaxBetUsdc;
    const withinWebCap =
      typeof capUsdc === "number" && betAmount <= capUsdc * 1_000_000;

    if (!isNative) {
      if (withinWebCap) return { ok: true };
      return {
        ok: false,
        message: capUsdc
          ? `Stakes above ${capUsdc} USDC require the mobile app.`
          : "Staked games require the mobile app.",
      };
    }

    const result = await attest();
    if (result.attested) return { ok: true };

    // An attested-capable client that failed the check is a different problem
    // from a browser: usually a rooted device or a sideloaded build.
    return {
      ok: false,
      message:
        result.reason ||
        "This device did not pass the security check, so staked games are unavailable.",
    };
  }

  window.AppNative = { isNative, attest, ensureAttestedForStake };
})();
