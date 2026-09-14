"use strict";

/**
 * scripts/loadtest/concurrency.js
 *
 * Drives N simultaneous practice matches through the real server and checks the
 * invariants a match is supposed to have, rather than just measuring throughput.
 * A load test that only reports latency will happily give a clean bill of health
 * to a server that is quietly pairing people twice.
 *
 * Practice mode (betAmount 0) is used deliberately: it runs the same matchmaking
 * pool, room lifecycle, question loop, Redis writes and settlement path as a
 * staked game, without needing a funded devnet wallet per virtual player. The
 * pot-mode differences are the stake verification in front and the payout
 * behind; everything this exercises is shared.
 *
 *   node scripts/loadtest/concurrency.js --pairs 8
 *   node scripts/loadtest/concurrency.js --pairs 8 --stagger 250
 *
 * `--stagger` spaces the joins out. The difference between staggered and
 * simultaneous runs is itself the finding: see docs/LOAD_TESTING.md.
 */

const {
  redis,
  mongo,
  VirtualPlayer,
  ping,
  summarize,
} = require("./lib/harness");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const PAIRS = Number(arg("pairs", 4));
const STAGGER_MS = Number(arg("stagger", 0));
const URL = arg("url", process.env.LOAD_URL || "http://127.0.0.1:5000");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!(await ping(URL))) {
    console.error(`No server responding at ${URL}. Start one: npm start`);
    process.exit(2);
  }

  const r = redis();
  const conn = await mongo();
  const GameSession = conn.collection("gamesessions");

  // Start from a clean queue. A pool entry left behind by an earlier run would
  // pair a live player with a dead socket and muddy every number below.
  const poolKey = "matchmaking:human:0";
  const leftovers = await r.llen(poolKey);
  if (leftovers) console.log(`clearing ${leftovers} stale pool entries`);
  await r.del(poolKey);

  const runId = `conc-${Date.now()}`;
  const sessionsBefore = await GameSession.countDocuments({});
  const players = [];
  for (let i = 0; i < PAIRS * 2; i++) {
    players.push(new VirtualPlayer(i, { runId, answerDelayMs: 400 }));
  }

  console.log(
    `\n${PAIRS} pairs (${players.length} players) → ${URL}` +
      (STAGGER_MS ? `, ${STAGGER_MS}ms stagger` : ", simultaneous joins")
  );

  const t0 = Date.now();
  await Promise.all(players.map((p) => p.connect(URL, r)));
  console.log(`all connected in ${Date.now() - t0}ms`);

  const games = players.map((p) => p.playToCompletion(240000));
  for (const p of players) {
    p.joinPracticeHuman();
    if (STAGGER_MS) await sleep(STAGGER_MS);
  }
  await Promise.all(games);

  // ── invariants ────────────────────────────────────────────────────────────
  const failures = [];
  const matchCounts = players.map(
    (p) => p.events.filter((e) => e.name === "matchFound").length
  );
  const doubleMatched = players.filter((_, i) => matchCounts[i] > 1);
  if (doubleMatched.length) {
    failures.push(
      `${doubleMatched.length}/${players.length} players received MORE THAN ONE ` +
        `matchFound (counts: ${[...new Set(matchCounts)]
          .sort()
          .join(",")}) — ` +
        `they were paired into several rooms at once`
    );
  }
  const unmatched = players.filter((_, i) => matchCounts[i] === 0);
  if (unmatched.length) {
    failures.push(`${unmatched.length} players were never matched at all`);
  }

  const rooms = new Set();
  for (const p of players)
    for (const e of p.events)
      if (e.name === "matchFound") rooms.add(e.payload.gameRoomId);
  if (rooms.size !== PAIRS) {
    failures.push(
      `expected ${PAIRS} rooms for ${PAIRS} pairs, server created ${rooms.size}`
    );
  }

  const unfinished = players.filter((p) => !p.gameOver);
  if (unfinished.length)
    failures.push(`${unfinished.length} players never reached gameOver`);

  const withErrors = players.filter((p) => p.errors.length);
  if (withErrors.length) {
    const kinds = {};
    for (const p of withErrors)
      for (const e of p.errors) kinds[e.event] = (kinds[e.event] || 0) + 1;
    failures.push(
      `${withErrors.length} players saw errors: ${JSON.stringify(kinds)}`
    );
  }

  const sessionsAfter = await GameSession.countDocuments({});
  const created = sessionsAfter - sessionsBefore;
  if (created !== PAIRS) {
    failures.push(
      `GameSession rows created: ${created}, expected ${PAIRS} ` +
        `(one per pair — extras mean duplicate matches reached the database)`
    );
  }

  // ── report ────────────────────────────────────────────────────────────────
  const matchLatency = players
    .filter((p) => p.matchedAt && p.connectedAt)
    .map((p) => p.matchedAt - p.connectedAt);
  const gameDuration = players
    .filter((p) => p.finishedAt && p.matchedAt)
    .map((p) => p.finishedAt - p.matchedAt);

  console.log(`\n── results ──────────────────────────────────────────────`);
  console.log(`  rooms created     ${rooms.size} (expected ${PAIRS})`);
  console.log(`  GameSession rows  ${created} (expected ${PAIRS})`);
  console.log(
    `  finished games    ${players.length - unfinished.length}/${
      players.length
    }`
  );
  console.log(`  ${summarize("match latency", matchLatency)}`);
  console.log(`  ${summarize("game duration", gameDuration)}`);

  if (failures.length) {
    console.log(`\n  ✗ ${failures.length} INVARIANT FAILURE(S)`);
    for (const f of failures) console.log(`    - ${f}`);
  } else {
    console.log(`\n  ✓ all invariants held`);
  }

  await Promise.all(players.map((p) => p.close(r)));
  await r.quit();
  await conn.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(2);
});
