"use strict";

/**
 * scripts/loadtest/killtest.js
 *
 * §G "kill-test recovery": SIGKILL the server in the middle of live games, boot
 * it again, and check that restart recovery leaves the world in the state
 * services/restartRecovery.js promises — every in-flight room gone, every
 * in-flight session marked `refunded`, nothing paid twice, and the server fit to
 * host new games straight away.
 *
 * This is the room-recovery half, which needs no money. The games are free
 * practice matches (betAmount 0), so the refund branch is exercised only as far
 * as "a practice game queues no payment". The on-chain half — a staked room that
 * must queue exactly one refund per player — needs funded devnet wallets and is
 * a separate scenario.
 *
 * Unlike concurrency.js, this script OWNS the server process: it has to be able
 * to kill it. It refuses to run if something is already listening on the port.
 *
 *   node scripts/loadtest/killtest.js --pairs 3
 *
 * Phases:
 *   A  play `pairs` games plus one lone player left waiting in the queue; once
 *      every game is at least `--at` questions in, SIGKILL.
 *   B  boot again. A fresh pair joins the moment the port answers, as real
 *      clients' auto-reconnect would, and must get a game that recovery does
 *      not tear down. Two bugs lived in that window, both caught here: recovery
 *      ran after listen and swept the new game up as "in-flight", and the Redis
 *      socket adapter was installed on a timer after listen, silently dropping
 *      the rooms of every socket that connected first.
 *   C  SIGKILL again and boot a third time. Recovery must be a no-op for
 *      everything B already settled: idempotency across repeated crashes.
 */

const { spawn } = require("child_process");
const path = require("path");
const { redis, mongo, VirtualPlayer, ping } = require("./lib/harness");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const PAIRS = Number(arg("pairs", 3));
const KILL_AT_QUESTION = Number(arg("at", 2));
const PORT = Number(arg("port", process.env.PORT || 5000));
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "../..");
const POOL_KEY = "matchmaking:human:0";
const RECOVERY_DONE = /\[RESTART-RECOVERY\] done/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

// ─── the server under test ───────────────────────────────────────────────────

class ServerProcess {
  constructor(label) {
    this.label = label;
    this.output = "";
    this.child = null;
    this.exited = null;
  }

  start() {
    this.child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (buf) => (this.output += buf.toString());
    this.child.stdout.on("data", collect);
    this.child.stderr.on("data", collect);
    this.exited = new Promise((r) => this.child.once("exit", r));
  }

  async waitListening() {
    await waitFor(() => ping(URL), 60000, `${this.label} to listen`);
  }

  async waitRecovery() {
    await waitFor(
      () => RECOVERY_DONE.test(this.output),
      90000,
      `${this.label} restart recovery to finish`
    );
    return this.output.match(/\[RESTART-RECOVERY\] done[^\n]*/)[0];
  }

  async kill(signal = "SIGKILL") {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill(signal);
    await this.exited;
  }

  tail(lines = 40) {
    return this.output.split("\n").slice(-lines).join("\n");
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function roomsOf(players) {
  const rooms = new Set();
  for (const p of players)
    for (const e of p.events)
      if (e.name === "matchFound") rooms.add(e.payload.gameRoomId);
  return [...rooms];
}

async function paymentsTouching(PaymentQueue, roomIds, wallets) {
  const or = [];
  for (const id of roomIds) {
    or.push({ gameId: id });
    or.push({ gameId: { $regex: `^refund:${id}:` } });
  }
  for (const w of wallets) {
    or.push({ gameId: { $regex: `^refund:pool:${w}:` } });
    or.push({ walletAddress: w });
  }
  if (!or.length) return [];
  return PaymentQueue.find({ $or: or }).toArray();
}

async function main() {
  if (await ping(URL)) {
    console.error(
      `Something is already listening on ${URL}. This test must own the ` +
        `server process so it can kill it — stop that one first.`
    );
    process.exit(2);
  }

  const r = redis();
  const conn = await mongo();
  const GameSession = conn.collection("gamesessions");
  const PaymentQueue = conn.collection("paymentqueues");

  const failures = [];
  const check = (ok, msg) => {
    if (!ok) failures.push(msg);
    console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
  };

  // Start clean: an entry left in the queue by an earlier run would pair with
  // our lone waiter and change the scenario under test.
  await r.del(POOL_KEY);

  const runId = `kill-${Date.now()}`;
  const everyone = [];
  const servers = [];
  const newPlayer = (i) => {
    const p = new VirtualPlayer(i, { runId, answerDelayMs: 400 });
    everyone.push(p);
    return p;
  };

  try {
    // ── Phase A: live games, then SIGKILL ────────────────────────────────────
    console.log(
      `\nA  ${PAIRS} practice games + 1 lone queued player; SIGKILL at question ${KILL_AT_QUESTION}`
    );
    const a = new ServerProcess("server A");
    servers.push(a);
    a.start();
    await a.waitListening();
    // Recovery from whatever an earlier run left must not overlap our games.
    await a.waitRecovery();

    const players = [];
    for (let i = 0; i < PAIRS * 2; i++) players.push(newPlayer(i));
    const loner = newPlayer(PAIRS * 2);
    await Promise.all([...players, loner].map((p) => p.connect(URL, r)));

    for (const p of players) p.joinPracticeHuman();
    await waitFor(
      () => players.every((p) => p.questionsSeen >= KILL_AT_QUESTION),
      60000,
      `every game to reach question ${KILL_AT_QUESTION}`
    );
    // Only now queue the loner: joining earlier would let them pair with
    // someone and leave a different player stranded.
    loner.joinPracticeHuman();
    await waitFor(
      async () =>
        (await r.lrange(POOL_KEY, 0, -1)).some((e) => e.includes(loner.wallet)),
      10000,
      "the lone player to be queued"
    );

    const killedRooms = roomsOf(players);
    const pre = await GameSession.find({ roomId: { $in: killedRooms } })
      .project({ roomId: 1, status: 1 })
      .toArray();
    const liveRoomKeys = await Promise.all(
      killedRooms.map((id) => r.exists(`room:${id}`))
    );

    console.log(`   pre-kill state`);
    check(
      killedRooms.length === PAIRS,
      `${killedRooms.length} rooms in play (expected ${PAIRS})`
    );
    check(
      liveRoomKeys.every(Boolean),
      `every room is live in Redis before the kill`
    );
    check(
      pre.length === PAIRS && pre.every((s) => s.status === "active"),
      `${
        pre.filter((s) => s.status === "active").length
      }/${PAIRS} sessions active before the kill`
    );

    const killedAt = Date.now();
    await a.kill("SIGKILL");
    console.log(`   SIGKILL sent; server A gone`);
    // The players' sockets die with it. That is the point, not a failure.
    await Promise.all([...players, loner].map((p) => p.close(null)));

    // ── Phase B: reboot, with a fresh pair racing recovery ──────────────────
    console.log(`\nB  reboot; a fresh pair joins the instant the port answers`);
    const b = new ServerProcess("server B");
    servers.push(b);
    b.start();

    const early = [newPlayer(PAIRS * 2 + 1), newPlayer(PAIRS * 2 + 2)];
    await b.waitListening();
    const listeningAt = Date.now();
    const recoveredBeforeJoin = RECOVERY_DONE.test(b.output);
    await Promise.all(early.map((p) => p.connect(URL, r)));
    const earlyGames = early.map((p) => p.playToCompletion(240000));
    for (const p of early) p.joinPracticeHuman();

    const recoveryLineB = await b.waitRecovery();
    console.log(
      `   port answered ${listeningAt - killedAt}ms after the kill; ` +
        `recovery ${recoveredBeforeJoin ? "had already" : "had NOT yet"} ` +
        `finished when the pair joined`
    );
    console.log(`   ${recoveryLineB.trim()}`);
    await Promise.all(earlyGames);

    console.log(`   recovery of the killed games`);
    const roomKeysAfter = await Promise.all(
      killedRooms.map((id) => r.exists(`room:${id}`))
    );
    check(
      roomKeysAfter.every((x) => !x),
      `no killed room survives in Redis (${
        roomKeysAfter.filter(Boolean).length
      } left)`
    );
    const active = await r.smembers("active:rooms");
    check(
      killedRooms.every((id) => !active.includes(id)),
      `no killed room is still listed in active:rooms`
    );

    const post = await GameSession.find({
      roomId: { $in: killedRooms },
    }).toArray();
    check(
      post.length === PAIRS,
      `one session per killed room (${post.length} for ${PAIRS})`
    );
    check(
      post.every((s) => s.status === "refunded" && s.endTime),
      `every killed session marked refunded with an endTime ` +
        `(${post.map((s) => s.status).join(",")})`
    );

    const payments = await paymentsTouching(
      PaymentQueue,
      killedRooms,
      [...players, loner].map((p) => p.wallet)
    );
    check(
      payments.length === 0,
      `no payment queued for a practice game or practice queuer ` +
        `(${payments.length} found)`
    );

    console.log(`   the pair that joined the instant the port answered`);
    const earlyRooms = roomsOf(early);
    check(
      earlyRooms.length === 1 &&
        early.every(
          (p) => p.events.filter((e) => e.name === "matchFound").length === 1
        ),
      `paired with each other, once (rooms: ${earlyRooms.length})`
    );
    check(
      early.every((p) => p.gameOver),
      `game played to completion (${
        early.filter((p) => p.gameOver).length
      }/2 reached gameOver)`
    );
    check(
      early.every((p) => !p.errors.length),
      `no errors seen: ${JSON.stringify(
        early.flatMap((p) => p.errors.map((e) => e.event))
      )}`
    );
    const earlySession = earlyRooms.length
      ? await GameSession.findOne({ roomId: earlyRooms[0] })
      : null;
    check(
      earlySession && earlySession.status !== "refunded",
      `its session was not swept up by recovery (status: ${earlySession?.status})`
    );
    const pool = await r.lrange(POOL_KEY, 0, -1);
    check(
      !pool.some((e) => e.includes(loner.wallet)),
      `the lone player's dead queue entry is gone (pool size ${pool.length})`
    );

    // ── Phase C: crash again; recovery must be idempotent ───────────────────
    console.log(
      `\nC  SIGKILL again and reboot: recovery must not redo B's work`
    );
    const endTimesB = new Map(
      post.map((s) => [s.roomId, s.endTime && s.endTime.getTime()])
    );
    const paymentsBeforeC = await PaymentQueue.countDocuments({});
    await Promise.all(early.map((p) => p.close(r)));
    await b.kill("SIGKILL");

    const c = new ServerProcess("server C");
    servers.push(c);
    c.start();
    await c.waitListening();
    const recoveryLineC = await c.waitRecovery();
    console.log(`   ${recoveryLineC.trim()}`);

    const postC = await GameSession.find({
      roomId: { $in: killedRooms },
    }).toArray();
    check(
      postC.every(
        (s) =>
          s.status === "refunded" &&
          s.endTime &&
          s.endTime.getTime() === endTimesB.get(s.roomId)
      ),
      `killed sessions untouched by the second recovery (same status and endTime)`
    );
    const earlySessionC = earlyRooms.length
      ? await GameSession.findOne({ roomId: earlyRooms[0] })
      : null;
    check(
      earlySessionC && earlySessionC.status === earlySession?.status,
      `the finished game's session is unchanged (${earlySessionC?.status})`
    );
    check(
      (await PaymentQueue.countDocuments({})) === paymentsBeforeC,
      `no payment rows added by the second recovery`
    );
  } catch (e) {
    failures.push(`harness error: ${e.message}`);
    console.error(`\n  harness error: ${e.message}`);
    for (const p of everyone)
      console.error(
        `   player ${p.index}: connected=${!!p.socket?.connected} ` +
          `seen=${p.questionsSeen} sent=${p.answersSent} ` +
          `events=${p.events.map((ev) => ev.name).join(",")}`
      );
    const last = servers[servers.length - 1];
    if (last) {
      console.error(`\n── ${last.label} output (tail) ──\n${last.tail()}`);
      const dump = path.join(ROOT, "logs", `killtest-${runId}.log`);
      require("fs").writeFileSync(dump, last.output);
      console.error(`\n  full server output: ${dump}`);
    }
  } finally {
    await Promise.all(everyone.map((p) => p.close(r)));
    for (const s of servers) await s.kill("SIGTERM").catch(() => {});
    await r.del(POOL_KEY).catch(() => {});
    await r.quit();
    await conn.close();
  }

  if (failures.length) {
    console.log(`\n  ✗ ${failures.length} FAILURE(S)`);
    for (const f of failures) console.log(`    - ${f}`);
  } else {
    console.log(`\n  ✓ recovery held every invariant across two crashes`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(2);
});
