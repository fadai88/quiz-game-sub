/**
 * scripts/compute-player-risk.js
 * Recompute per-player anti-cheat risk from telemetry and print the flagged /
 * highest-scoring accounts for HUMAN review. (The server also refreshes this on
 * a cron.) REVIEW-ONLY — this never seizes funds.
 *
 * Usage (from project root, where .env lives):
 *   node scripts/compute-player-risk.js
 *   node scripts/compute-player-risk.js --top 30
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { recomputeAllRisk } = require("../services/riskScore");
const PlayerRisk = require("../models/PlayerRisk");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI not set — run this from the project root.");
    process.exit(1);
  }
  const top = parseInt(arg("top", "20"), 10) || 20;

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("🔌 Connected. Recomputing player risk…");

  const { wallets, scored, flagged } = await recomputeAllRisk();
  console.log(
    `✅ ${wallets} wallet(s) seen, ${scored} had enough data to score, ${flagged} flagged.`
  );

  if (scored === 0) {
    console.log(
      "   No scorable players yet — needs real games with ≥20 answers per player."
    );
  } else {
    const rows = await PlayerRisk.find({ score: { $gt: 0 } })
      .sort({ score: -1 })
      .limit(top)
      .lean();
    console.log(
      `\nTop ${rows.length} by risk score (review, do not auto-act):`
    );
    for (const r of rows) {
      console.log(
        `  ${r.flagged ? "🚩" : "  "} ${r.score.toString().padStart(3)}  ` +
          `${r.wallet}  (n=${r.attempts}, acc=${r.metrics?.overallAccuracy}, ` +
          `cv=${r.metrics?.cv}, ipWallets=${r.metrics?.maxWalletsPerIp})`
      );
    }
  }

  await mongoose.connection.close();
}

main().catch(async (e) => {
  console.error("Fatal:", e.message);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
