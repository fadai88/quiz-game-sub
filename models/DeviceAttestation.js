const mongoose = require("mongoose");

/**
 * DeviceAttestation — one document per attested device, recording every wallet
 * that has ever attested from it.
 *
 * Purpose is twofold:
 *   1. Gate — services/attestation.js writes here on every successful verify,
 *      and the staked-play gate reads the session's attestation state.
 *   2. Detection — a single device seen with many wallets is a far stronger
 *      multi-account / collusion signal than the IP clustering already used by
 *      services/riskScore.js (IPs are shared by households, campuses and VPNs;
 *      a device is not). Wiring this into the risk score is a later phase.
 *
 * HONEST LIMITATION: `deviceId` is NOT a hardware identifier. Play Integrity
 * deliberately exposes no stable device ID. It is a random secret the app
 * generates at first launch and keeps in Keystore-backed storage, hashed here so
 * the raw value never sits in the database. A reinstall produces a new id, and a
 * determined attacker with N devices still gets N identities. What the pairing
 * of (attested device integrity + persistent install id) buys is that cloning
 * one identity across many cheap emulated "devices" stops working — reinstall
 * farms become visible as churn rather than being free.
 */
const DeviceAttestationSchema = new mongoose.Schema(
  {
    // sha256 of the app's install secret — never the raw value.
    deviceId: { type: String, required: true, unique: true },
    platform: { type: String, enum: ["android", "ios", "mock"], index: true },

    // Every wallet that has successfully attested from this device.
    wallets: { type: [String], default: [] },

    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },

    // Most recent raw verdicts, kept for operator review of a flagged device.
    lastVerdicts: { type: mongoose.Schema.Types.Mixed },

    verifyCount: { type: Number, default: 0 },
    failCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// deviceId already has a unique index via `unique: true` above.
DeviceAttestationSchema.index({ wallets: 1 });
DeviceAttestationSchema.index({ lastSeen: -1 });

module.exports = mongoose.model("DeviceAttestation", DeviceAttestationSchema);
