"use strict";

/**
 * scripts/loadtest/soak.js
 *
 * §G soak test: play wave after wave of practice games against one server for a
 * long time, and watch for the things that only show up with time — memory that
 * grows and never comes back, rooms and sessions left behind, file handles that
 * leak with socket churn, and question timers that drift as the process ages.
 *
 * Like killtest.js it OWNS the server (it needs the pid to read /proc), so it
 * refuses to run if something is already listening on the port.
 *
 *   node scripts/loadtest/soak.js --minutes 10              # smoke run
 *   node scripts/loadtest/soak.js --minutes 240 --pairs 8   # the real thing
 *
 * Each wave connects `--pairs` pairs with fresh sockets, plays them to the end,
 * disconnects them, and samples the server. Players sometimes let a question
 * run out (`--skip`), so the 10s question timeout fires and its drift can be
 * measured from the server's [QTIMING] log lines. Samples are written to
 * logs/soak-<run>.json as the run goes, so a long run can be inspected (or
 * plotted) before it ends.
 *
 * What fails the run:
 *   - any wave invariant: a pair not getting exactly one room, a game not
 *     finishing, a player seeing an error
 *   - leftovers once the last wave settles: rooms in Redis, active:rooms
 *     entries, queue entries, or this run's sessions not `completed`
 *   - open file descriptors not returning to their warmed-up level
 *   - memory growing steadily: RSS trend above --rss-mb-per-hour AND total
 *     growth above --rss-growth-mb (both, so GC noise on a short run cannot
 *     trip it alone)
 *   - timer drift: any question timeout firing more than --max-drift-ms late,
 *     or the late-run p95 drift exceeding the early-run p95 by more than that
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  redis,
  mongo,
  VirtualPlayer,
  ServerProcess,
  ping,
  sleep,
  percentile,
} = require("./lib/harness");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const MINUTES = Number(arg("minutes", 10));
const PAIRS = Number(arg("pairs", 6));
const GAP_MS = Number(arg("gap", 2000));
const SKIP = Number(arg("skip", 0.15));
const WARMUP_WAVES = Number(arg("warmup", 3));
const RSS_MB_PER_HOUR = Number(arg("rss-mb-per-hour", 30));
const RSS_GROWTH_MB = Number(arg("rss-growth-mb", 64));
const FD_SLACK = Number(arg("fd-slack", 16));
const MAX_DRIFT_MS = Number(arg("max-drift-ms", 250));
const PORT = Number(arg("port", process.env.PORT || 5000));
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "../..");
const POOL_KEY = "matchmaking:human:0";
const QUESTION_MS = 10000;

// ─── process and Redis sampling ──────────────────────────────────────────────

function rssMb(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  return Number(status.match(/VmRSS:\s+(\d+)/)[1]) / 1024;
}

function openFds(pid) {
  return fs.readdirSync(`/proc/${pid}/fd`).length;
}

async function countKeys(r, pattern) {
  let cursor = "0";
  let n = 0;
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    n += keys.length;
  } while (cursor !== "0");
  return n;
}

// A cheap stand-in for event-loop lag: a public route with no I/O behind it.
function httpLatency() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const req = http.get(`${URL}/api/config`, (res) => {
      res.resume();
      res.on("end", () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
    });
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// Least-squares slope of y over x.
function slope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : 0;
}

const fmt = (v, unit = "ms") => (v === null ? "-" : `${Math.round(v)}${unit}`);

// ─── one wave ────────────────────────────────────────────────────────────────

async function playWave(r, runId, wave) {
  // Wallets repeat across waves (one per seat) so the run does not mint an
  // ever-growing set of identities; sockets and sessions are new every wave,
  // which is the churn a handle leak would show up under.
  const players = Array.from(
    { length: PAIRS * 2 },
    (_, i) =>
      new VirtualPlayer(i, {
        runId: `${runId}:seat`,
        answerDelayMs: 400,
        skipRate: SKIP,
      })
  );
  await Promise.all(players.map((p) => p.connect(URL, r)));
  const games = players.map((p) => p.playToCompletion(240000));
  for (const p of players) p.joinPracticeHuman();
  await Promise.all(games);

  const problems = [];
  const counts = players.map(
    (p) => p.events.filter((e) => e.name === "matchFound").length
  );
  if (counts.some((c) => c !== 1))
    problems.push(`matchFound counts ${[...new Set(counts)].join(",")}`);
  const rooms = new Set();
  for (const p of players)
    for (const e of p.events)
      if (e.name === "matchFound") rooms.add(e.payload.gameRoomId);
  if (rooms.size !== PAIRS)
    problems.push(`${rooms.size} rooms for ${PAIRS} pairs`);
  const unfinished = players.filter((p) => !p.gameOver).length;
  if (unfinished) problems.push(`${unfinished} players never reached gameOver`);
  const errs = players.flatMap((p) => p.errors.map((e) => e.event));
  if (errs.length) problems.push(`errors: ${[...new Set(errs)].join(",")}`);

  await Promise.all(players.map((p) => p.close(r)));
  return { rooms: [...rooms], problems };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (await ping(URL)) {
    console.error(
      `Something is already listening on ${URL}. The soak test must own the ` +
        `server process to read its memory and handles — stop that one first.`
    );
    process.exit(2);
  }

  const r = redis();
  const conn = await mongo();
  const GameSession = conn.collection("gamesessions");
  await r.del(POOL_KEY);

  const runId = `soak-${Date.now()}`;
  const outFile = path.join(ROOT, "logs", `${runId}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const server = new ServerProcess("soak server", { port: PORT, cwd: ROOT });
  const drift = []; // { at, ms }
  server.onLine((line) => {
    const m = line.match(/\[QTIMING\].*TIMEOUT fired: elapsedMs=(\d+)/);
    if (m) drift.push({ at: Date.now(), ms: Number(m[1]) - QUESTION_MS });
  });

  const samples = [];
  const waveFailures = [];
  const allRooms = [];
  let aborted = null;
  const stopAt = Date.now() + MINUTES * 60000;
  let t0;

  const sample = async (wave) => {
    const lat = [];
    for (let i = 0; i < 5; i++) lat.push(await httpLatency());
    const s = {
      wave,
      at: Date.now(),
      minutes: (Date.now() - t0) / 60000,
      rssMb: rssMb(server.pid),
      fds: openFds(server.pid),
      activeRooms: await r.scard("active:rooms"),
      roomKeys: await countKeys(r, "room:*"),
      queued: await r.llen(POOL_KEY),
      httpP50: percentile(
        lat.filter((x) => x !== null),
        50
      ),
      driftSamples: drift.length,
    };
    samples.push(s);
    fs.writeFileSync(
      outFile,
      JSON.stringify({ runId, args: process.argv.slice(2), samples }, null, 1)
    );
    return s;
  };

  const onSignal = () => {
    aborted = "interrupted";
  };
  process.once("SIGINT", onSignal);

  try {
    server.start();
    await server.waitListening();
    await server.waitRecovery();
    t0 = Date.now();

    console.log(
      `\nsoak: ${MINUTES} min, ${PAIRS} pairs/wave, skip ${SKIP}, pid ${server.pid}` +
        `\n      samples → ${path.relative(ROOT, outFile)}\n`
    );
    const base = await sample(0);
    console.log(
      `  start       rss=${fmt(base.rssMb, "MB")} fds=${base.fds} ` +
        `rooms=${base.activeRooms} roomKeys=${base.roomKeys}`
    );

    let wave = 0;
    while (Date.now() < stopAt && !aborted) {
      wave++;
      const { rooms, problems } = await playWave(r, runId, wave);
      allRooms.push(...rooms);
      if (problems.length) waveFailures.push({ wave, problems });
      await sleep(GAP_MS);
      const s = await sample(wave);
      const recent = drift.slice(-PAIRS * 10).map((d) => d.ms);
      console.log(
        `  wave ${String(wave).padStart(4)}  t=${s.minutes.toFixed(1)}m ` +
          `rss=${fmt(s.rssMb, "MB")} fds=${s.fds} rooms=${s.activeRooms} ` +
          `queued=${s.queued} http=${fmt(s.httpP50)} ` +
          `drift p95=${fmt(percentile(recent, 95))}` +
          (problems.length ? `  ✗ ${problems.join("; ")}` : "")
      );
      if (server.child.exitCode !== null) {
        aborted = `server exited (code ${server.child.exitCode})`;
      }
    }

    // Let the last room teardowns land before judging leftovers.
    await sleep(5000);
    const end = await sample(wave);

    // ── verdicts ─────────────────────────────────────────────────────────────
    const failures = [];
    const check = (ok, msg) => {
      if (!ok) failures.push(msg);
      console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
    };
    console.log(
      `\n── verdict after ${wave} waves, ${end.minutes.toFixed(1)} min ──`
    );
    if (aborted) check(false, `run ended early: ${aborted}`);

    check(
      waveFailures.length === 0,
      `every wave held its invariants (${waveFailures.length} failed` +
        (waveFailures.length
          ? `: first at wave ${
              waveFailures[0].wave
            } — ${waveFailures[0].problems.join("; ")}`
          : "") +
        ")"
    );

    check(
      end.roomKeys === base.roomKeys && end.activeRooms === base.activeRooms,
      `no rooms left behind (room keys ${base.roomKeys}→${end.roomKeys}, ` +
        `active:rooms ${base.activeRooms}→${end.activeRooms})`
    );
    check(end.queued === 0, `matchmaking queue empty (${end.queued})`);

    const sessions = await GameSession.aggregate([
      { $match: { roomId: { $in: allRooms } } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]).toArray();
    const byStatus = Object.fromEntries(sessions.map((s) => [s._id, s.n]));
    check(
      (byStatus.completed || 0) === allRooms.length,
      `every session completed (${allRooms.length} rooms: ${JSON.stringify(
        byStatus
      )})`
    );

    const warm = samples.filter((s) => s.wave >= WARMUP_WAVES && s !== end);
    const warmBase = warm.length ? warm[0] : base;
    check(
      end.fds <= warmBase.fds + FD_SLACK,
      `file descriptors back to their warmed-up level ` +
        `(${warmBase.fds} after warm-up → ${end.fds}, slack ${FD_SLACK})`
    );

    const trend = slope(
      warm.map((s) => s.minutes / 60),
      warm.map((s) => s.rssMb)
    );
    const growth = end.rssMb - warmBase.rssMb;
    check(
      !(trend > RSS_MB_PER_HOUR && growth > RSS_GROWTH_MB),
      `no steady memory growth (trend ${trend.toFixed(1)} MB/h over ` +
        `${warm.length} samples, ${growth.toFixed(1)} MB since warm-up; ` +
        `fails only if > ${RSS_MB_PER_HOUR} MB/h AND > ${RSS_GROWTH_MB} MB)`
    );

    const d = drift.map((x) => x.ms);
    const q = Math.max(1, Math.floor(d.length / 4));
    const earlyP95 = percentile(d.slice(0, q), 95);
    const lateP95 = percentile(d.slice(-q), 95);
    check(
      d.length > 0,
      `question timeouts observed (${d.length}) — drift is measurable`
    );
    if (d.length) {
      check(
        Math.max(...d) <= MAX_DRIFT_MS,
        `no timeout fired more than ${MAX_DRIFT_MS}ms late ` +
          `(p50 ${percentile(d, 50)}ms, p95 ${percentile(
            d,
            95
          )}ms, max ${Math.max(...d)}ms)`
      );
      check(
        lateP95 - earlyP95 <= MAX_DRIFT_MS,
        `drift not worsening with uptime (p95 first quarter ${earlyP95}ms → last quarter ${lateP95}ms)`
      );
    }

    const httpEarly = percentile(
      warm
        .slice(0, Math.max(1, Math.floor(warm.length / 4)))
        .map((s) => s.httpP50),
      50
    );
    const httpLate = percentile(
      warm
        .slice(-Math.max(1, Math.floor(warm.length / 4)))
        .map((s) => s.httpP50),
      50
    );
    console.log(
      `  · http latency (event-loop proxy): early ${fmt(
        httpEarly
      )} → late ${fmt(httpLate)} (reported, not judged)`
    );

    console.log(
      failures.length
        ? `\n  ✗ ${failures.length} FAILURE(S)`
        : `\n  ✓ soak held every invariant`
    );
    console.log(`  samples: ${path.relative(ROOT, outFile)}`);
    process.exitCode = failures.length ? 1 : 0;
  } catch (e) {
    console.error(`\n  harness error: ${e.message}`);
    console.error(`\n── server output (tail) ──\n${server.tail()}`);
    process.exitCode = 2;
  } finally {
    await server.kill("SIGTERM").catch(() => {});
    await r.del(POOL_KEY).catch(() => {});
    await r.quit();
    await conn.close();
  }
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(2);
});
