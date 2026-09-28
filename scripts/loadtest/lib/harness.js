"use strict";

/**
 * scripts/loadtest/lib/harness.js
 *
 * Shared machinery for driving the real server with many simultaneous players.
 *
 * Two decisions here shape everything else, and both exist to keep the thing
 * under test honest:
 *
 * 1. SESSIONS ARE SEEDED, NOT LOGGED IN. A virtual player writes the same two
 *    Redis keys `POST /api/auth/login` writes, then connects with the token in
 *    `handshake.auth` — the path the native app uses. Everything after the
 *    handshake is the real code: the auth middleware reads the record, and
 *    `validateSocketSession` re-reads it on every game event. What this skips is
 *    the challenge/signature dance, which is rate limited to 5 logins a minute
 *    per IP by design. Load testing the login path is a separate exercise; this
 *    harness is about what happens once people are playing.
 *
 * 2. EVERY PLAYER GETS ITS OWN LOOPBACK ADDRESS. The server rate limits per IP
 *    as well as per wallet — `joinPracticeGame` is 10 a minute and
 *    `submitAnswer` 20 per 30s — and exceeding the IP budget does not just
 *    throttle, it writes `blocklist:<ip>` for ten minutes and disconnects. Ten
 *    virtual players sharing 127.0.0.1 would therefore stop being a load test
 *    about a minute in, and the result would say nothing about the server.
 *
 *    Rather than weaken a real production limit for the benefit of its own test,
 *    each player binds its socket to a distinct address in 127.0.0.0/8, which
 *    Linux routes to loopback in its entirety. The server sees distinct peers,
 *    the per-IP limiters behave exactly as they would for real users, and the
 *    code under test is the code that ships.
 */

const crypto = require("crypto");
const http = require("http");
const Redis = require("ioredis");
const mongoose = require("mongoose");
const { io } = require("socket.io-client");

require("dotenv").config();

const SESSION_TTL_SECONDS = 3600;

// ─── infrastructure ──────────────────────────────────────────────────────────

function redis() {
  return new Redis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
  });
}

async function mongo() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
  });
  return mongoose.connection;
}

// ─── identities ──────────────────────────────────────────────────────────────

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * A syntactically valid Solana address. It is never used to sign anything — the
 * harness plays free practice matches — but the server validates the shape, and
 * a wallet that cannot be told apart from a real one keeps the test honest about
 * what the indexes and logs will hold.
 */
function fakeWallet(tag) {
  const seed = crypto.createHash("sha256").update(String(tag)).digest();
  let out = "";
  for (let i = 0; i < 43; i++) out += BASE58[seed[i % seed.length] % 58];
  return out;
}

/** The address this player dials out from. 127.0.0.0/8 is all loopback. */
function loopbackFor(index) {
  // .0 and .1 are avoided: .1 is the host itself and would collide with
  // anything else on the machine, which is the collision we are here to dodge.
  const n = (index % 65000) + 2;
  return `127.0.${Math.floor(n / 254) % 254}.${(n % 254) + 1}`;
}

/**
 * Write the session records `POST /api/auth/login` would have written. Returns
 * the token to hand to the socket handshake.
 */
async function seedSession(r, walletAddress, ip) {
  const token = crypto.randomBytes(32).toString("hex");
  const userAgent = "quiz-loadtest/1.0";
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${ip}:${userAgent}`)
    .digest("hex");

  const sessionData = {
    walletAddress,
    fingerprint,
    timestamp: Date.now(),
    ip,
    userAgent,
    clientType: "web",
  };

  await r.set(
    `session:${token}`,
    JSON.stringify(sessionData),
    "EX",
    SESSION_TTL_SECONDS
  );
  await r.set(
    `session:wallet:${walletAddress}`,
    token,
    "EX",
    SESSION_TTL_SECONDS
  );
  return token;
}

async function clearSession(r, walletAddress, token) {
  await r.del(`session:${token}`, `session:wallet:${walletAddress}`);
}

// ─── the virtual player ──────────────────────────────────────────────────────

/**
 * One player: connects, queues for a free practice match against another human,
 * answers every question, and resolves when the game is over.
 *
 * Answers are deliberately not all correct. A match where both players score
 * identically ends in the tie-break path on every single game, which is a real
 * code path but a badly unrepresentative load profile.
 */
class VirtualPlayer {
  constructor(index, opts = {}) {
    this.index = index;
    this.wallet = fakeWallet(`${opts.runId || "load"}:${index}`);
    this.ip = loopbackFor(index);
    this.answerDelayMs = opts.answerDelayMs ?? 300;
    this.accuracy = opts.accuracy ?? 0.6;
    // Chance of letting a question run out instead of answering. Real players
    // do, and it is the only way a question's 10s timeout ever fires.
    this.skipRate = opts.skipRate ?? 0;
    this.events = [];
    this.errors = [];
    this.answersSent = 0;
    this.questionsSeen = 0;
    this.roomId = null;
    this.gameOver = null;
    this.connectedAt = null;
    this.matchedAt = null;
    this.finishedAt = null;
    this.socket = null;
    this.token = null;
  }

  async connect(url, r) {
    this.token = await seedSession(r, this.wallet, this.ip);

    this.socket = io(url, {
      transports: ["websocket"],
      auth: { token: this.token },
      reconnection: false,
      timeout: 20000,
      // engine.io passes this through to the underlying socket, which is what
      // gives this player its own source address and therefore its own per-IP
      // rate-limit budget.
      localAddress: this.ip,
      extraHeaders: { "user-agent": "quiz-loadtest/1.0" },
    });

    this.#wire();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`connect timeout (${this.wallet.slice(0, 8)})`)),
        20000
      );
      this.socket.on("connect", () => {
        clearTimeout(timer);
        this.connectedAt = Date.now();
        resolve();
      });
      this.socket.on("connect_error", (err) => {
        clearTimeout(timer);
        reject(new Error(`connect_error: ${err.message}`));
      });
    });
  }

  #wire() {
    const note = (name, payload) => {
      this.events.push({ at: Date.now(), name, payload });
    };

    this.socket.on("matchFound", (d) => {
      note("matchFound", d);
      this.matchedAt = Date.now();
      this.roomId = d.gameRoomId;
    });
    this.socket.on("matchmakingJoined", (d) => note("matchmakingJoined", d));
    this.socket.on("joinedRoom", (d) => {
      note("joinedRoom", d);
      this.roomId = d.roomId;
    });
    this.socket.on("gameStart", (d) => note("gameStart", d));
    this.socket.on("nextQuestion", (q) => {
      this.questionsSeen += 1;
      note("nextQuestion", { questionNumber: q.questionNumber });
      this.#answer(q);
    });
    this.socket.on("gameOver", (d) => {
      note("gameOver", d);
      this.finishedAt = Date.now();
      this.gameOver = d;
      if (this.resolveGame) this.resolveGame(d);
    });

    for (const bad of [
      "error",
      "gameError",
      "answerError",
      "matchmakingError",
      "joinGameFailure",
      "disconnect",
    ]) {
      this.socket.on(bad, (payload) => {
        // A disconnect after the game is over is the harness closing up, not a
        // failure; anything else is recorded and fails the run.
        if (bad === "disconnect" && this.finishedAt) return;
        this.errors.push({ at: Date.now(), event: bad, payload });
        note(bad, payload);
        if (this.resolveGame) this.resolveGame(null);
      });
    }
  }

  #answer(q) {
    if (Math.random() < this.skipRate) return;
    const wrong = Math.random() > this.accuracy;
    const choice = wrong ? Math.floor(Math.random() * 4) : 0;
    // A human does not answer instantly; a uniform delay would also make every
    // player in a match submit in lockstep, which is the one timing profile the
    // server will never actually see.
    const jitter = this.answerDelayMs * (0.5 + Math.random());
    setTimeout(() => {
      if (!this.socket.connected) return;
      this.answersSent += 1;
      this.socket.emit("submitAnswer", {
        roomId: this.roomId,
        questionId: q.questionId,
        answer: choice,
      });
    }, jitter);
  }

  joinPracticeHuman() {
    this.socket.emit("joinPracticeGame", { gameMode: "human" });
  }

  /** Resolves with the gameOver payload, or null if the game never finished. */
  playToCompletion(timeoutMs = 180000) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      this.resolveGame = done;
      const timer = setTimeout(() => {
        this.errors.push({ at: Date.now(), event: "timeout", payload: null });
        done(null);
      }, timeoutMs);
    });
  }

  async close(r) {
    try {
      if (this.socket) this.socket.close();
    } catch {}
    if (r && this.token)
      await clearSession(r, this.wallet, this.token).catch(() => {});
  }
}

// ─── server control ──────────────────────────────────────────────────────────

/**
 * Is a server already listening on this port? There is no /health route, so
 * this uses /api/config — public, cheap, and it only answers once the config
 * has actually initialized, which is the thing we want to wait for anyway.
 */
function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url}/api/config`, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

const RECOVERY_DONE = /\[RESTART-RECOVERY\] done[^\n]*/;
const OUTPUT_CAP = 1 << 20; // keep the last 1MB — soak runs go on for hours

/**
 * A server this script starts, and can kill. Scenarios that need to crash the
 * server or read its process stats own it this way; concurrency.js just talks
 * to whatever is already running.
 *
 * Output is kept as a capped tail for failure reports; `onLine` sees every line
 * as it arrives, for scenarios that mine the log (timer drift, recovery).
 */
class ServerProcess {
  constructor(label, { port, cwd, nodeArgs = [] }) {
    this.label = label;
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.cwd = cwd;
    this.nodeArgs = nodeArgs;
    this.output = "";
    this.recoveryLine = null;
    this.lineHandlers = [];
    this.child = null;
    this.exited = null;
  }

  onLine(fn) {
    this.lineHandlers.push(fn);
  }

  start() {
    const { spawn } = require("child_process");
    this.child = spawn(process.execPath, [...this.nodeArgs, "server.js"], {
      cwd: this.cwd,
      env: { ...process.env, PORT: String(this.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let partial = "";
    const collect = (buf) => {
      const text = buf.toString();
      this.output = (this.output + text).slice(-OUTPUT_CAP);
      const lines = (partial + text).split("\n");
      partial = lines.pop();
      for (const raw of lines) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
        if (!this.recoveryLine) {
          const m = line.match(RECOVERY_DONE);
          if (m) this.recoveryLine = m[0];
        }
        for (const fn of this.lineHandlers) fn(line);
      }
    };
    this.child.stdout.on("data", collect);
    this.child.stderr.on("data", collect);
    this.exited = new Promise((r) => this.child.once("exit", r));
  }

  get pid() {
    return this.child && this.child.pid;
  }

  async waitListening() {
    await waitFor(() => ping(this.url), 60000, `${this.label} to listen`);
  }

  async waitRecovery() {
    await waitFor(
      () => this.recoveryLine !== null,
      90000,
      `${this.label} restart recovery to finish`
    );
    return this.recoveryLine;
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

// ─── metrics ─────────────────────────────────────────────────────────────────

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length)
  );
  return sorted[idx];
}

function summarize(label, values) {
  if (!values.length) return `${label}: (none)`;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return (
    `${label}: n=${values.length} mean=${mean.toFixed(0)}ms ` +
    `p50=${percentile(values, 50)}ms p95=${percentile(values, 95)}ms ` +
    `max=${Math.max(...values)}ms`
  );
}

module.exports = {
  redis,
  mongo,
  fakeWallet,
  loopbackFor,
  seedSession,
  clearSession,
  VirtualPlayer,
  ServerProcess,
  ping,
  sleep,
  waitFor,
  percentile,
  summarize,
};
