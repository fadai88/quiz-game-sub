# Load, soak and concurrency testing

`scripts/loadtest/` drives the real server with many simultaneous players. It
exists because §G of `MAINNET_LAUNCH_CHECKLIST.md` was entirely untested, and
because the failure it found on its first run is invisible to any test that
plays one game at a time.

```bash
npm start                                              # in one terminal
node scripts/loadtest/concurrency.js --pairs 4         # in another
node scripts/loadtest/concurrency.js --pairs 4 --stagger 300
```

## How it drives the server

Two things are worth knowing before reading a result.

**Sessions are seeded, not logged in.** A virtual player writes the same two
Redis keys `POST /api/auth/login` writes, then connects with the token in
`handshake.auth` — the transport the native app uses. Everything after the
handshake is real: the auth middleware reads the record and
`validateSocketSession` re-reads it on every game event. What this skips is the
challenge/signature exchange, which is deliberately capped at 5 logins per minute
per IP. Load testing the login path is a separate exercise.

**Every player gets its own loopback address.** The server rate limits per IP as
well as per wallet (`joinPracticeGame` 10/min, `submitAnswer` 20/30s), and
exceeding the IP budget does not throttle — it writes `blocklist:<ip>` for ten
minutes and disconnects. Virtual players sharing 127.0.0.1 would stop being a
load test about a minute in. So each binds to a distinct address in 127.0.0.0/8,
which Linux routes entirely to loopback. The server sees distinct peers, the
limiters behave as they would for real users, and **no production limit is
weakened for the test's convenience.**

Matches are free practice games (`betAmount 0`). That is the same matchmaking
pool, room lifecycle, question loop, Redis writes and settlement path as a staked
game — pot mode adds stake verification in front and payout behind, but
everything exercised here is shared code.

## Fixed: simultaneous joins paired the same players many times

**Found 2026-09-14, fixed the same day. `concurrency.js` is the end-to-end
regression test; since 2026-09-26 it is also caught in CI by
`tests/roomManager.claimPair.js` (a fake Redis that interleaves commands, so the
old read-then-remove claim fails it) and `tests-integration/matchmakingClaim.js` (the
real Lua script against a real Redis, in its own CI job).**

`concurrency.js` checks invariants, not just latency — a throughput test would
have passed this server while it was quietly pairing people two to eight times.

Before the fix, same load and same code, with only the join timing varying:

| Run | Rooms (expect 4) | GameSession rows | Players finishing |
|---|---|---|---|
| 4 pairs, 300ms stagger | 4 ✓ | 4 ✓ | 8/8 ✓ |
| 4 pairs, simultaneous | **8** | **8** | **1/8** |

Two players received **seven and eight** `matchFound` events each, five were
never matched, and the survivors logged 37 `answerError`s.

After the fix, every configuration passes:

| Run | Rooms | GameSession rows | Players finishing | Match latency p95 |
|---|---|---|---|---|
| 4 pairs, simultaneous (×3) | 4 ✓ | 4 ✓ | 8/8 ✓ | ~90ms |
| 20 pairs, simultaneous | 20 ✓ | 20 ✓ | 40/40 ✓ | 89ms |
| 40 pairs, simultaneous | 40 ✓ | 40 ✓ | 80/80 ✓ | 164ms |

### What was wrong

Matchmaking claimed players with a non-atomic read-modify-write. Both the
practice path and the **staked** path had the same shape: `LPUSH` yourself,
`LRANGE` the pool, take the first two entries, `LREM` them, build a room. Every
handler that ran before those `LREM`s landed read the same pool and picked the
same two players, so each one built a room of its own.

Each duplicate room then ran its own question loop against sockets joined to
several rooms while `socket.roomId` pointed at only one, so answers for every
other room came back "Question not found" and those games never finished.

### The fix, and two wrong turns worth recording

The claim is now atomic: `claimTwoFromMatchmakingPool` in
`services/roomManager.js` runs a two-line Lua script that pops two entries, or
puts the first one back and takes nothing. Redis executes it as a single step, so
a pair belongs to exactly one handler and there is no race left to referee.

Getting there took two failed attempts, both of which the harness caught:

1. **Return the `LREM` count and let losers bail.** This fixed the duplicate
   rooms outright — no more double `matchFound` at any scale — but a handler that
   lost simply gave up, leaving the players it had not taken queued with nobody
   to pair them. At 20 pairs that produced 8 rooms and 24 stranded players.
2. **Pop one player at a time, retrying.** Worse, and instructively so: with
   several handlers popping at once they each ended up holding one player, every
   one of them then saw an empty queue, and they all put their player back and
   gave up. Forty players, zero rooms, and not a single error logged anywhere.
   Everyone picked up one chopstick and nobody ate.

Both failures looked healthy from the server's side, which is the argument for
invariant checks over throughput numbers.

`removeFromMatchmakingPool` still exists for targeted removals (disconnect, stale
entries, "already in queue") and now also reports whether **this** caller is the
one that removed the player, rather than claiming success either way. The
disconnect path uses that: a player who was already matched must not also be
refunded as a queue-leaver.

### Staked path

`joinHumanMatchmaking` had the identical flaw and takes the identical fix. It was
never reproduced directly — pot mode verifies an on-chain stake before touching
the pool, which needs a funded devnet wallet per virtual player — so the staked
path is **fixed by inspection and covered only indirectly**, through shared code
exercised by the practice runs. Proving it needs the devnet payment scenario
below.

Two things are deliberately different there, because money is involved: the only
claim-time filter is whether a socket is alive (judging players against an
eligibility snapshot taken before they joined would have dropped late arrivals,
and a dropped player in pot mode is a collected stake with no game and no
refund), and any claimed player who loses their partner is put back in the queue
rather than discarded.

## Kill-test recovery: two bugs in the seconds after a restart

**Found and fixed 2026-09-26. `killtest.js` is the regression test.**

```bash
node scripts/loadtest/killtest.js --pairs 3    # owns the server; stop npm start first
```

It starts the server itself, lets `--pairs` practice games get two questions in
with one more player left waiting in the queue, SIGKILLs it, and boots it again.
A fresh pair joins the instant the port answers, which is what real clients'
auto-reconnect does. Then it kills and boots once more to check idempotency. It
asserts: every killed room is gone from Redis and `active:rooms`, every killed
session is `refunded` with an `endTime`, no payment is queued for a practice game,
the waiting player's dead queue entry is cleared, the new pair plays a complete
game that recovery leaves alone, and the second recovery changes nothing.

This is the **room-recovery half**. The money half (a staked room queues exactly
one on-chain refund per player) needs funded devnet wallets and is still open.

Both bugs sat in the window between the port opening and startup finishing, and
neither one logged an error:

1. **Recovery swept up live games.** `recoverInFlightOnStartup` treats every room
   and `active` session it finds as abandoned, but it ran from the Mongo `open`
   handler, after the AWS treasury-secret fetch, while the port was already
   open. A pair that joined in that window had its room deleted and its session
   marked `refunded` mid-game (`games:4` reported for 3 killed games). In pot mode
   that is a live staked game torn down under the players. **Fix:** `startServer`
   now awaits Mongo and recovery before `listen`. Recovery only needs Redis and
   Mongo, and only *queues* refunds; the PaymentProcessor sends them once config
   is up.
2. **Early sockets lost their rooms.** The Redis socket adapter was installed on
   a 1s timer *after* `listen`. `io.adapter()` gives every namespace a fresh
   adapter, discarding room memberships, so any socket connected in that first
   second was matched, received question 1, and then nothing: every later
   question went to an empty room and timed out. **Fix:** the adapter is awaited
   before handlers are registered and before `listen`. The timer existed "so
   redisClient is ready", but Redis had already been awaited and pinged by then.

Recovery also now clears dead entries from the free practice queue (pass 3 used
to return early outside pot mode). They were never paid, but they sat there until
two live joins happened to claim them.

## Soak: concurrent room writes were overwriting each other

**Found and fixed 2026-09-28. `soak.js` found it; `tests-integration/roomWrites.js`
is the regression test.**

```bash
node scripts/loadtest/soak.js --minutes 10               # smoke run
node scripts/loadtest/soak.js --minutes 240 --pairs 8    # the real thing
```

`soak.js` owns the server (it reads `/proc/<pid>` for memory and open file
descriptors) and plays wave after wave of practice games with fresh sockets each
wave. Players skip about one question in seven (`--skip`), so the 10s question
timeout fires and its lateness can be read from the server's `[QTIMING]` lines.
Every wave is checked for the same invariants as `concurrency.js`, and samples are
written to `logs/soak-<run>.json` as the run goes. At the end it fails on:
rooms or queue entries left behind, sessions not `completed`, file descriptors
not back to their warmed-up level, steady RSS growth (trend **and** total, so GC
noise on a short run cannot trip it), and question timeouts firing late or
getting later with uptime.

Its first run failed on leftovers: about one room per wave came back after the
game had ended and sat in Redis for an hour, outside `active:rooms`.

### What was wrong

`atomicRoomUpdate` protected its read-modify-write with `WATCH`/`MULTI`/`EXEC`.
`WATCH` state belongs to the **connection**, and the server has one shared Redis
connection. Any caller's `EXEC` or `UNWATCH` cleared every other caller's watches,
so concurrent updates committed blindly over each other. At the end of a wave,
every player disconnects at once, after `gameOver` is emitted and before
`deleteGameRoom` runs (it waits on a Mongo write in between). Each disconnect
handler updates the room, and one of those writes landed after the delete.

The leftover room was the visible symptom. The worse one does not show in any
log. Measured against a real Redis on one connection, before the fix:

| | Result |
|---|---|
| Two simultaneous updates to one room | **one lost, 200 of 200 trials** |
| An update racing a delete | **room recreated, 148 of 200** |

In a game, two simultaneous updates to one room are two players answering the
same question within a few milliseconds of each other. One answer, and its
point, could vanish: in a staked game, the wrong winner. The window widens with
a hosted Redis's round-trip time.

### The fix

Every room hash now carries a `version` field. `atomicRoomUpdate` reads the room
and its version in one `HGETALL`, applies the change, and writes it back with a
Lua compare-and-set that succeeds only if the room still exists and the version
is unchanged. Otherwise it retries from a fresh read, or throws `not found` if
the room is gone. `updateGameRoom`'s plain writes use a script that also bumps
the version, so a concurrent atomic update re-reads rather than overwriting
them, and it refuses to recreate a room that no longer exists. Every caller
writes back a room it has just read or created, so no caller relied on that.
The interfaces and the game's behavior are unchanged.

After the fix: 0 of 200 lost, 0 of 200 recreated.

### The 4-hour run (2026-09-28)

`--minutes 240 --pairs 8`, after the fix: **157 waves, 1,256 games.**

| Check | Result |
|---|---|
| Wave invariants | 0 failures |
| Leftover rooms / queue entries | none; 1,256 of 1,256 sessions `completed` |
| Open file descriptors | 42 at start, 42 at end |
| RSS | trend ~4 MB/h; 125–150MB in the first hour, then a 155–160MB plateau with one-wave GC spikes to 180MB |
| Question-timeout drift | p50 3ms, p95 5ms; p95 6ms in the first quarter, 5ms in the last |
| HTTP latency | 4ms early, 4ms late |

The run failed exactly one check: one timeout fired **1,919,907ms** (32 minutes)
late. The machine slept for 32 minutes between waves 92 and 93, freezing the
server and the harness together, and a question timer due during the sleep
fired on wake. That is the host, not the server, but the script could not tell
them apart. It now can: a 1s heartbeat in the harness notices a host pause (a
tick more than `--pause-threshold-ms`, default 5s, late). Timeouts whose wait
overlaps a pause are left out of the drift checks, and waves the host paused in
report their problems without failing. Both are listed in the verdict, and
pauses are saved in the samples file. Leftover, session and fd checks are never
excused. Verified by freezing the harness and server together with
`SIGSTOP`/`SIGCONT` for 30s mid-run. Frozen between questions, the overlapping
timeouts are set aside and the run passes. Frozen mid-game, the players' sockets
time out on wake and that wave's 8 players never see `gameOver`. The wave is
reported, not failed. The abandoned games still ran to completion on the server,
and every session ended `completed` with no leftover rooms, which is itself a
useful result for the continue-on-disconnect model.

## Still to build
- **Payment throughput** — many queued payouts/refunds at once; assert no
  double-send and no stuck queue. Needs devnet.
- **Kill-test recovery, money half** — a staked room killed mid-game must queue
  exactly one on-chain refund per player, and a game whose payout was already
  queued must not also be refunded. Needs devnet.

The matchmaking race blocked these: they would have been measuring a baseline in
which matchmaking did not reliably produce one room per pair. That is fixed, so
they are now the next thing to build.
