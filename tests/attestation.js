"use strict";

/**
 * Unit tests for device attestation (services/attestation.js).
 *
 * Two properties matter most and are asserted directly:
 *
 *   1. OFF BY DEFAULT — with STAKED_REQUIRES_ATTESTATION unset, the gate is a
 *      no-op. The existing web product must behave exactly as it does today.
 *   2. FAILS CLOSED — unlike the payout auto-hold (which fails open, because
 *      wrongly withholding money is worse than missing a cheat), a verification
 *      problem here refuses ENTRY. Nobody's funds are at risk, so the safe
 *      direction is to not start the match.
 */

const { expect } = require("chai");

const {
  evaluateVerdict,
  verifyAttestation,
  assertStakedClientAllowed,
  isSessionAttested,
  hashDeviceSecret,
  generateNonce,
} = require("../services/attestation");

const USDC = 1_000_000;
const NONCE = "test-nonce-abc";
const PACKAGE = "com.example.quiz";

// A payload in Play Integrity's shape, healthy unless overridden.
function payload(overrides = {}) {
  const {
    nonce = NONCE,
    packageName = PACKAGE,
    appVerdict = "PLAY_RECOGNIZED",
    deviceVerdicts = ["MEETS_DEVICE_INTEGRITY"],
    timestampMillis = Date.now(),
  } = overrides;

  return {
    requestDetails: {
      requestPackageName: packageName,
      nonce,
      timestampMillis: String(timestampMillis),
    },
    appIntegrity: { appRecognitionVerdict: appVerdict },
    deviceIntegrity: { deviceRecognitionVerdict: deviceVerdicts },
    accountDetails: { appLicensingVerdict: "LICENSED" },
  };
}

const opts = { expectedNonce: NONCE, expectedPackage: PACKAGE };

// Env is process-global; every test that touches it restores afterwards.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("attestation — verdict policy", () => {
  it("accepts a healthy Play Integrity payload", () => {
    const r = evaluateVerdict(payload(), opts);
    expect(r.ok).to.equal(true);
    expect(r.verdicts.deviceRecognitionVerdict).to.include(
      "MEETS_DEVICE_INTEGRITY"
    );
  });

  it("rejects a mismatched nonce (replay from another request)", () => {
    const r = evaluateVerdict(payload({ nonce: "someone-elses-nonce" }), opts);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal("NONCE_MISMATCH");
  });

  it("rejects a missing expected nonce rather than accepting anything", () => {
    const r = evaluateVerdict(payload(), { expectedPackage: PACKAGE });
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal("NONCE_MISMATCH");
  });

  it("rejects a token from a different package", () => {
    const r = evaluateVerdict(payload({ packageName: "com.evil.clone" }), opts);
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal("PACKAGE_MISMATCH");
  });

  it("rejects a stale token even if every verdict is healthy", () => {
    const r = evaluateVerdict(
      payload({ timestampMillis: Date.now() - 60 * 60 * 1000 }),
      opts
    );
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal("TOKEN_STALE");
  });

  it("rejects a rooted / emulated device", () => {
    const r = evaluateVerdict(
      payload({ deviceVerdicts: ["MEETS_BASIC_INTEGRITY"] }),
      opts
    );
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal("DEVICE_INTEGRITY_FAILED");
  });

  it("rejects an unrecognized binary by default", () => {
    const r = evaluateVerdict(
      payload({ appVerdict: "UNRECOGNIZED_VERSION" }),
      opts
    );
    expect(r.ok).to.equal(false);
    expect(r.code).to.equal("APP_NOT_RECOGNIZED");
  });

  it("accepts a sideloaded beta build when PLAY_RECOGNIZED is not required", () => {
    withEnv({ ATTESTATION_REQUIRE_PLAY_RECOGNIZED: "false" }, () => {
      const r = evaluateVerdict(
        payload({ appVerdict: "UNRECOGNIZED_VERSION" }),
        opts
      );
      expect(r.ok).to.equal(true);
    });
  });

  it("still requires device integrity for a sideloaded beta build", () => {
    withEnv({ ATTESTATION_REQUIRE_PLAY_RECOGNIZED: "false" }, () => {
      const r = evaluateVerdict(
        payload({
          appVerdict: "UNRECOGNIZED_VERSION",
          deviceVerdicts: [],
        }),
        opts
      );
      expect(r.ok).to.equal(false);
      expect(r.code).to.equal("DEVICE_INTEGRITY_FAILED");
    });
  });

  it("rejects an empty payload without throwing", () => {
    const r = evaluateVerdict({}, opts);
    expect(r.ok).to.equal(false);
  });
});

describe("attestation — verifyAttestation (mock provider)", () => {
  const base = {
    nonce: NONCE,
    deviceSecret: "install-secret-0123456789abcdef",
    platform: "mock",
  };

  it("verifies a well-formed mock token and derives a device id", async () => {
    await withEnv(
      { ATTESTATION_PROVIDER: "mock", ANDROID_PACKAGE_NAME: PACKAGE },
      async () => {
        const r = await verifyAttestation({
          ...base,
          token: JSON.stringify(payload()),
        });
        expect(r.ok).to.equal(true);
        expect(r.deviceId).to.equal(hashDeviceSecret(base.deviceSecret));
      }
    );
  });

  it("hashes the device secret rather than storing it", () => {
    const id = hashDeviceSecret("install-secret-0123456789abcdef");
    expect(id).to.match(/^[a-f0-9]{64}$/);
    expect(id).to.not.contain("install-secret");
  });

  it("returns a failure (never throws) on an undecodable token", async () => {
    await withEnv({ ATTESTATION_PROVIDER: "mock" }, async () => {
      const r = await verifyAttestation({ ...base, token: "not-json-at-all" });
      expect(r.ok).to.equal(false);
      expect(r.code).to.equal("VERIFICATION_ERROR");
    });
  });

  it("returns a failure on an unknown provider", async () => {
    await withEnv({ ATTESTATION_PROVIDER: "nonsense" }, async () => {
      const r = await verifyAttestation({
        ...base,
        token: JSON.stringify(payload()),
      });
      expect(r.ok).to.equal(false);
      expect(r.code).to.equal("VERIFICATION_ERROR");
    });
  });

  it("does not leak provider error detail to the caller", async () => {
    await withEnv({ ATTESTATION_PROVIDER: "google" }, async () => {
      // No credentials configured — the underlying error names the env var.
      const r = await verifyAttestation({ ...base, token: "x" });
      expect(r.ok).to.equal(false);
      expect(r.reason).to.not.contain("GOOGLE_PLAY_INTEGRITY_CREDENTIALS");
    });
  });

  it("issues unique, URL-safe nonces", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).to.not.equal(b);
    expect(a).to.match(/^[A-Za-z0-9_-]+$/);
  });
});

describe("attestation — staked-play gate", () => {
  const attested = () => ({ attested: true, attestedAt: Date.now() });

  it("is a no-op when the flag is off (default) — web keeps staking", () => {
    withEnv({ STAKED_REQUIRES_ATTESTATION: undefined }, () => {
      expect(assertStakedClientAllowed({}, 30 * USDC).allowed).to.equal(true);
      expect(assertStakedClientAllowed(null, 30 * USDC).allowed).to.equal(true);
    });
  });

  it("never gates free play, even when enabled", () => {
    withEnv({ STAKED_REQUIRES_ATTESTATION: "true" }, () => {
      expect(assertStakedClientAllowed({}, 0).allowed).to.equal(true);
      expect(assertStakedClientAllowed({}, undefined).allowed).to.equal(true);
    });
  });

  it("refuses an unattested client for a staked game when enabled", () => {
    withEnv(
      {
        STAKED_REQUIRES_ATTESTATION: "true",
        STAKED_WEB_MAX_BET_USDC: undefined,
      },
      () => {
        const r = assertStakedClientAllowed({}, 3 * USDC);
        expect(r.allowed).to.equal(false);
        expect(r.code).to.equal("NATIVE_CLIENT_REQUIRED");
      }
    );
  });

  it("allows a freshly attested client", () => {
    withEnv({ STAKED_REQUIRES_ATTESTATION: "true" }, () => {
      expect(assertStakedClientAllowed(attested(), 30 * USDC).allowed).to.equal(
        true
      );
    });
  });

  it("refuses a stale attestation with a distinct re-attest code", () => {
    withEnv(
      {
        STAKED_REQUIRES_ATTESTATION: "true",
        ATTESTATION_MAX_AGE_MS: "1000",
      },
      () => {
        const r = assertStakedClientAllowed(
          { attested: true, attestedAt: Date.now() - 10_000 },
          3 * USDC
        );
        expect(r.allowed).to.equal(false);
        // Distinct from NATIVE_CLIENT_REQUIRED so the app re-attests silently
        // instead of telling the player to install what they already have.
        expect(r.code).to.equal("ATTESTATION_STALE");
      }
    );
  });

  it("treats a missing attestedAt as stale, not as valid", () => {
    withEnv({ STAKED_REQUIRES_ATTESTATION: "true" }, () => {
      const r = assertStakedClientAllowed({ attested: true }, 3 * USDC);
      expect(r.allowed).to.equal(false);
      expect(r.code).to.equal("ATTESTATION_STALE");
    });
  });

  it("ignores a client-declared clientType — only server-verified attestation counts", () => {
    withEnv({ STAKED_REQUIRES_ATTESTATION: "true" }, () => {
      const r = assertStakedClientAllowed(
        { clientType: "native", attested: false },
        3 * USDC
      );
      expect(r.allowed).to.equal(false);
    });
  });

  describe("soft rollout via STAKED_WEB_MAX_BET_USDC", () => {
    const env = {
      STAKED_REQUIRES_ATTESTATION: "true",
      STAKED_WEB_MAX_BET_USDC: "3",
    };

    it("lets an unattested web client stake up to the cap", () => {
      withEnv(env, () => {
        expect(assertStakedClientAllowed({}, 3 * USDC).allowed).to.equal(true);
      });
    });

    it("refuses an unattested web client above the cap", () => {
      withEnv(env, () => {
        const r = assertStakedClientAllowed({}, 10 * USDC);
        expect(r.allowed).to.equal(false);
        expect(r.code).to.equal("NATIVE_CLIENT_REQUIRED");
        expect(r.reason).to.contain("3");
      });
    });

    it("still lets an attested client stake above the cap", () => {
      withEnv(env, () => {
        expect(
          assertStakedClientAllowed(attested(), 30 * USDC).allowed
        ).to.equal(true);
      });
    });

    it("ignores a malformed cap rather than granting unlimited web staking", () => {
      withEnv({ ...env, STAKED_WEB_MAX_BET_USDC: "not-a-number" }, () => {
        const r = assertStakedClientAllowed({}, 3 * USDC);
        expect(r.allowed).to.equal(false);
      });
    });
  });
});

describe("attestation — isSessionAttested", () => {
  // This predicate is what the reCAPTCHA exemption in socket/index.js keys off,
  // so "attested" has to mean the same thing there as it does at the stake gate.
  // A session that attested an hour ago must not buy a reCAPTCHA bypass.

  it("is true for a fresh, server-verified attestation", () => {
    expect(
      isSessionAttested({ attested: true, attestedAt: Date.now() })
    ).to.equal(true);
  });

  it("is false once the attestation has aged out", () => {
    withEnv({ ATTESTATION_MAX_AGE_MS: "1000" }, () => {
      expect(
        isSessionAttested({ attested: true, attestedAt: Date.now() - 10_000 })
      ).to.equal(false);
    });
  });

  it("is false for a session that never attested", () => {
    expect(isSessionAttested({})).to.equal(false);
    expect(isSessionAttested(null)).to.equal(false);
    expect(isSessionAttested(undefined)).to.equal(false);
  });

  it("is false when a client merely claims to be native", () => {
    // clientType is self-declared at login and therefore worthless as a
    // security signal — only the server-verified flag counts.
    expect(isSessionAttested({ clientType: "native" })).to.equal(false);
  });

  it("is false when attestedAt is missing or unparseable", () => {
    expect(isSessionAttested({ attested: true })).to.equal(false);
    expect(
      isSessionAttested({ attested: true, attestedAt: "not-a-time" })
    ).to.equal(false);
  });

  it("agrees with the stake gate on the same session", () => {
    withEnv({ STAKED_REQUIRES_ATTESTATION: "true" }, () => {
      const fresh = { attested: true, attestedAt: Date.now() };
      const stale = { attested: true, attestedAt: 0 };
      expect(isSessionAttested(fresh)).to.equal(true);
      expect(assertStakedClientAllowed(fresh, 3 * USDC).allowed).to.equal(true);
      expect(isSessionAttested(stale)).to.equal(false);
      expect(assertStakedClientAllowed(stale, 3 * USDC).allowed).to.equal(
        false
      );
    });
  });
});

describe("attestation — the mock provider must never work in production", () => {
  // The mock provider trusts whatever the client sends. Since ATTESTATION_PROVIDER
  // defaults to "mock" and /api/attest is mounted unconditionally, a production
  // deployment that never configures a real provider would otherwise let anyone
  // POST a hand-written payload and become "attested" — inheriting staking
  // access AND the reCAPTCHA exemption in socket/index.js.
  const base = {
    nonce: NONCE,
    deviceSecret: "install-secret-0123456789abcdef",
    platform: "mock",
  };

  it("refuses a mock token when NODE_ENV=production", async () => {
    await withEnv(
      {
        NODE_ENV: "production",
        ATTESTATION_PROVIDER: "mock",
        ANDROID_PACKAGE_NAME: PACKAGE,
      },
      async () => {
        const r = await verifyAttestation({
          ...base,
          token: JSON.stringify(payload()),
        });
        expect(r.ok).to.equal(false);
        expect(r.code).to.equal("VERIFICATION_ERROR");
      }
    );
  });

  it("refuses it even when the provider is left at its default", async () => {
    await withEnv(
      {
        NODE_ENV: "production",
        ATTESTATION_PROVIDER: undefined,
        ANDROID_PACKAGE_NAME: PACKAGE,
      },
      async () => {
        const r = await verifyAttestation({
          ...base,
          token: JSON.stringify(payload()),
        });
        expect(r.ok).to.equal(false);
      }
    );
  });

  it("still works outside production, so dev and tests can exercise the flow", async () => {
    await withEnv(
      {
        NODE_ENV: "development",
        ATTESTATION_PROVIDER: "mock",
        ANDROID_PACKAGE_NAME: PACKAGE,
      },
      async () => {
        const r = await verifyAttestation({
          ...base,
          token: JSON.stringify(payload()),
        });
        expect(r.ok).to.equal(true);
      }
    );
  });
});
