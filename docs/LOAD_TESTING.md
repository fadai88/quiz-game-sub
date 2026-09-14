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

**Found 2026-09-14, fixed the same day. `concurrency.js` is the regression test.**

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

## Still to build

- **Soak** — hours of continuous waves; watch RSS, room counts, orphaned rooms,
  timer drift, handle leaks.
- **Payment throughput** — many queued payouts/refunds at once; assert no
  double-send and no stuck queue. Needs devnet.
- **Kill-test recovery** — SIGKILL mid-game, repeatedly; assert every stake is
  refunded on reboot and nothing double-pays. Needs devnet for the money half;
  the room-recovery half can run free.

The matchmaking race blocked these: they would have been measuring a baseline in
which matchmaking did not reliably produce one room per pair. That is fixed, so
they are now the next thing to build.
