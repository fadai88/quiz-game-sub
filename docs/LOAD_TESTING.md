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

## Finding: simultaneous joins pair the same players many times

**Status: open. Found 2026-09-14. Reproduces every run.**

`concurrency.js` checks invariants, not just latency — a throughput test would
have passed this server while it was quietly pairing people two to eight times
over.

Same load, same code, the only variable is whether joins arrive together:

| Run | Rooms (expect 4) | GameSession rows | Players finishing |
|---|---|---|---|
| 4 pairs, 300ms stagger | 4 ✓ | 4 ✓ | 8/8 ✓ |
| 4 pairs, simultaneous | **8** | **8** | **1/8** |

In the failing run two players received **seven and eight** `matchFound` events
each, five players were never matched at all, and the survivors logged 37
`answerError`s. It is byte-for-byte reproducible.

### Why

Matchmaking claims players with a non-atomic read-modify-write. Both the practice
path (`socket/index.js`, `joinPracticeGame`) and the **staked** path
(`joinHumanMatchmaking`) have the same shape:

```js
await addToMatchmakingPool(betAmount, {...});     // LPUSH
const pool = await getMatchmakingPool(betAmount); // LRANGE
if (pool.length >= 2) {
  const p1 = pool[0], p2 = pool[1];
  await removeFromMatchmakingPool(betAmount, p1.socketId);  // LREM
  await removeFromMatchmakingPool(betAmount, p2.socketId);  // LREM
  ... createGameRoom / GameSession.create / startGame ...
}
```

Every handler that runs before the `LREM`s land reads the same pool and picks the
same two entries. Eight concurrent joins means eight handlers pairing whichever
two players happen to be oldest — hence one player matched eight times and five
never matched, and hence rooms and `GameSession` rows at twice the expected
count. Each duplicate room then runs its own question loop against sockets that
are joined to several rooms while `socket.roomId` points at only one, so answers
for every other room are rejected as "Question not found" and those games never
finish.

The root cause is one discarded value: `removeFromMatchmakingPool`
(`services/roomManager.js`) ignores what `LREM` returns and reports success
either way. `LREM` is atomic and returns the number of elements removed, so it is
already a perfectly good claim check — exactly one caller can get `1` for a given
entry. That signal is thrown away, so nothing can tell the handler that won from
the seven that lost.

### Scope

Reproduced on the free practice path. The staked path is **the same code shape**
and has no additional guard — its extra liveness re-check runs after the same
racing `LREM`s and passes, because both sockets are alive. It was not reproduced
directly: that needs a funded devnet wallet per virtual player, since pot mode
verifies an on-chain stake before touching the pool. Treat it as affected until
shown otherwise; a duplicate room on the staked path means two `GameSession`
rows and two settlement attempts for a single pair of stakes.

A secondary effect: a failed run leaves entries behind in
`matchmaking:human:0`, so a later player can be paired with a dead socket. The
runner clears the pool before starting for this reason.

### Fix sketch (not applied)

Return the `LREM` count from `removeFromMatchmakingPool` and treat `0` as "another
handler already claimed this player" — bail out and re-queue anyone already
taken. That makes the claim atomic with no lock and no new dependency, because
`LREM` is already atomic. A Lua script doing pop-two-or-nothing is the stronger
version and the better answer if matchmaking grows any more rules.

Whatever the fix, `concurrency.js --pairs 4` is the regression test: it fails
reliably today and must pass afterwards.

## Still to build

- **Soak** — hours of continuous waves; watch RSS, room counts, orphaned rooms,
  timer drift, handle leaks.
- **Payment throughput** — many queued payouts/refunds at once; assert no
  double-send and no stuck queue. Needs devnet.
- **Kill-test recovery** — SIGKILL mid-game, repeatedly; assert every stake is
  refunded on reboot and nothing double-pays. Needs devnet for the money half;
  the room-recovery half can run free.

These were deliberately not built yet: they would be measuring a baseline in
which matchmaking does not reliably produce one room per pair.
