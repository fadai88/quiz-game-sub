# Runbooks

What to do when something goes wrong in production. Every step here is tied to
what the code actually does; file references are given so a step can be checked
before it is trusted at 3am. Checklist §F requires these before launch.

Conventions:

- `mongosh "$MONGODB_URI"` opens the production database. Collections used here:
  `paymentqueues`, `withheldpayouts`, `gamesessions`.
- Admin endpoints need an admin session: log in through the app with a wallet
  listed in `ADMIN_WALLETS`, then send its `sessionToken` cookie
  (`-b "sessionToken=…"` in the curl examples).
- Alerts go to `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL`. **Without one of
  them, alerts only reach the console.** Wire one before launch and check that it
  fires.

## Alert → runbook

| Alert | Fires when | Runbook |
|---|---|---|
| `FAILED_PAYOUTS` | a payment has failed 5 times and stopped retrying (checked every 10 min, `jobs/cronJobs.js`) | [1](#1-stuck-or-failed-payouts) |
| `STUCK_PAYMENTS` | a payment has been `processing` for over 30 min | [1](#1-stuck-or-failed-payouts) |
| `REFUND_FAILED` | an on-chain refund could not even be **queued** (e.g. DB down), `services/refunds.js` | [1](#1-stuck-or-failed-payouts) |
| `LOW_TREASURY_SOL` / `LOW_TREASURY_USDC` | balance below `MIN_TREASURY_SOL` (default 0.05) / `MIN_TREASURY_USDC` (default 50), checked every 10 min | [2](#2-treasury-refill) |
| `PAYOUT_BLOCKED` | a winner's pot was withheld (fraud flag, missing dependency, staked bot game) | [3](#3-withheld-payouts) |
| `REDIS_RECONNECT` / `MONGO_RECONNECT` | 3 reconnects in 5 min | check the provider status; if the server crashes, [4b](#4b-unplanned-crash) applies |
| `ORPHANED_PLAYER` | a player's disconnect could not be matched to a room | informational; check the logs if it repeats |

---

## 1. Stuck or failed payouts

**How payments move** (`models/PaymentQueue.js`, `services/PaymentProcessor.js`).
Every payout and refund is a `PaymentQueue` row:

`pending` → `processing` → `completed`, or → `failed` (with `attempts` incremented).

The processor runs every 60 s. It retries a `failed` row while `attempts < 5`,
once its last attempt is 5 minutes old, and reclaims a `processing` row whose
`lastAttemptAt` is over 5 minutes old (its worker died). After 5 attempts a row stops retrying and `FAILED_PAYOUTS` fires.

**The one rule that prevents double payment:** a row with a `broadcastSignature`
may already have paid. Before sending that transaction, the processor stored its
signature. On every retry, the processor first re-checks that signature
on-chain, and builds a new transfer only once the old one is provably expired. **Never
send money by hand for a row that has a `broadcastSignature` until you have
checked that signature on an explorer.**

### Steps

1. **List the problem rows**
   ```js
   db.paymentqueues.find(
     { $or: [ { status: "failed", attempts: { $gte: 5 } },
              { status: "processing", lastAttemptAt: { $lt: new Date(Date.now() - 30*60*1000) } } ] },
     { recipientWallet: 1, amount: 1, gameId: 1, status: 1, attempts: 1,
       errorMessage: 1, broadcastSignature: 1, "metadata.type": 1 })
   ```
   `amount` is in atomic units (1 USDC = 1,000,000). `metadata.type: "refund"`
   marks a refund. Refund `gameId`s follow the patterns in `services/refunds.js`
   (`refund:<roomId>:<wallet>`, `refund:pool:…`, `refund:stake:…`).

2. **Read `errorMessage` and fix the cause first.** Common ones:
   - *Treasury low on SOL / insufficient funds* → [runbook 2](#2-treasury-refill), then step 4.
   - *RPC errors / timeouts* → check the RPC provider; rows retry on their own
     while `attempts < 5`.
   - *Invalid recipient* → the wallet is wrong; it does not retry usefully. Decide
     case by case, and note it on the row.

3. **If the row has a `broadcastSignature`**, look it up on an explorer for the
   right network:
   - **Confirmed** → the money arrived. Mark it done; do not resend:
     ```js
     db.paymentqueues.updateOne({ _id: ObjectId("…") },
       { $set: { status: "completed", errorMessage: "confirmed on-chain manually: <sig>" } })
     ```
   - **Failed or not found** → it will never land once its blockhash expires (a
     couple of minutes). Continue to step 4.

4. **Retry through the processor.** Prefer this to a manual transfer: it
   re-checks any `broadcastSignature` itself.
   ```js
   db.paymentqueues.updateOne({ _id: ObjectId("…") },
     { $set: { status: "failed", attempts: 0 } })
   ```
   It is picked up once its last attempt is 5 minutes old (so within about 6
   minutes). Watch for `completed`.

   **Never run `PaymentQueue.cleanupOldPendings()`.** It deletes unpaid
   `pending` rows after 24 h, which silently cancels money owed.

5. **Manual transfer (last resort).** Only after step 3 shows no landed
   transaction. Send from the treasury, then **immediately** mark the row
   `completed` with the signature in `errorMessage`, so the processor cannot send
   it again.

**`REFUND_FAILED`** means no row was ever created, so nothing will retry. The
alert carries `walletAddress`, `amount`, `refundKey` and `reason`. After fixing
the cause (usually Mongo), insert the refund by hand with that exact `refundKey`
as its `gameId`. The unique index then guarantees it cannot also be queued by an
automatic path.

---

## 2. Treasury refill

**Why it matters:** every payout and refund pays Solana fees in SOL from the
treasury, and creating a recipient's USDC account costs a little more. **Crash
recovery queues refunds that also need SOL** (checklist §F). If USDC runs out,
winners and refunds cannot be paid.

### Steps

1. Check the balances: the alert includes them, or look up
   `TREASURY_WALLET_ADDRESS` on an explorer.
2. Send SOL and/or USDC **to `TREASURY_WALLET_ADDRESS` on the right network**
   from your funding wallet. Double-check the address against the env. A
   devnet/mainnet mix-up is the classic mistake.
3. Confirm the deposit on an explorer.
4. Payments resume by themselves: rows with `attempts < 5` retry within about 6
   minutes. Rows that hit 5 attempts while the treasury was empty need
   [runbook 1, step 4](#steps).
5. If alerts fire too early or too late, tune `MIN_TREASURY_SOL` /
   `MIN_TREASURY_USDC` (read at boot; restart to apply).

---

## 3. Withheld payouts

When a winner's pot is held back, `settlePotGame` writes a `WithheldPayout` row
and `PAYOUT_BLOCKED` fires. Reasons (`models/WithheldPayout.js`): `fraud` (risk
flags), `unavailable` (a dependency was down at payout time), `error` (queueing
failed), `staked_bot_game` (backstop: a bot should never be in a staked game).
**Nothing happens to the money until an operator resolves it.**

### Steps

1. **List the pending holds**
   ```bash
   curl -s -b "sessionToken=…" "https://<host>/api/admin/withheld-payouts?status=pending_review"
   ```
   Each row has `walletAddress`, `stakeAmount` (the winner's own stake),
   `intendedPayout`, `reason`, `flags`, `suspicionScore` and `roomId`.

2. **Investigate.** For `fraud`, review the player's telemetry and risk score
   (anti-cheat policy: withhold and review, never auto-seize). For `unavailable`
   or `error`, the game was usually fine and something on the payment side
   wasn't.

3. **Resolve** with one of three actions:
   ```bash
   curl -s -X POST -b "sessionToken=…" -H "Content-Type: application/json" \
     -d '{"action":"release","note":"reviewed, legitimate"}' \
     "https://<host>/api/admin/withheld-payouts/<id>/resolve"
   ```
   | action | effect |
   |---|---|
   | `release` | queues the full withheld payout on-chain (treasury → winner) |
   | `refund` | returns only the winner's own stake on-chain |
   | `deny` | closes the hold with no money movement (confirmed abuse) |

   Each record can be resolved only once: two operators cannot both act on it.
   If the money step fails, the hold returns to `pending_review` and can be
   retried. A released or refunded payment then follows [runbook 1](#1-stuck-or-failed-payouts)
   like any other.

---

## 4. Restarts

### 4a. Planned restart (deploy)

**Drain mode** stops new games from starting, so a deploy interrupts as few
games as possible (`utils/maintenance.js`). Games already in progress carry on.

1. **Turn drain on**
   ```bash
   curl -s -X POST -b "sessionToken=…" -H "Content-Type: application/json" \
     -d '{"enabled":true}' https://<host>/api/admin/maintenance
   ```
   New games are rejected (`socket/index.js`) and the client stops offering
   stakes.
2. **Wait for games to finish.** A match takes about a minute.
   ```bash
   curl -s -b "sessionToken=…" https://<host>/api/admin/maintenance   # → {"draining":true,"activeGames":N}
   ```
   Deploy when `activeGames` is 0. If one is stuck, deploying anyway is safe: it
   is refunded on boot (step 4).
3. **Deploy / restart.**
4. **Check recovery in the new instance's log.** Restart recovery runs on boot
   **before the server accepts connections** (`server.js`, `startServer`), so it
   can only see what the old instance left behind. Look for:
   ```
   [RESTART-RECOVERY] done — games:N game-refunds:M waiting-stakers:K pool-refunds:J
   ```
   After a clean drain, all four are usually 0. Refunds it queues are sent by the
   payment processor; watch them complete as in [runbook 1](#1-stuck-or-failed-payouts).
5. **Drain clears itself:** a fresh instance switches it off on boot. Confirm
   with `GET /api/maintenance` → `{"draining":false}`.

### 4b. Unplanned crash

Nothing needs doing to protect players' money: the next boot refunds every
in-flight stake (`services/restartRecovery.js`). It refunds each human player of
an unfinished staked game, and every staker still waiting in the queue, exactly
once. It does not refund a game whose winner payout was already queued, and
running it again, even from two instances at once, adds nothing. This is tested
in `tests-integration/restartRecovery.js` and `scripts/loadtest/killtest.js`.

1. Restart the server, and find out why it crashed.
2. Check the `[RESTART-RECOVERY] done` line, as in 4a step 4.
3. **The treasury must have SOL** for the refunds to be sent ([runbook 2](#2-treasury-refill)).
4. Games that ran past 15 minutes without finishing are refunded by the
   safety-net job every 5 minutes, using the same refund keys, so nothing is paid
   twice.

---

## 5. Key or secret compromise

Act in this order: stop the damage, rotate, then investigate.

### Treasury key (the critical one)

The key is stored in AWS Secrets Manager (secret `wallet_secret_key`, region
`eu-north-1`, `aws-secrets-integration.js`) and **cached in memory for 24 h**. At
boot, the server checks that it matches `TREASURY_WALLET_ADDRESS` and refuses to
start if it doesn't.

1. **Turn drain on** (4a step 1) so no new stakes arrive at the compromised
   wallet.
2. **Move the remaining funds out now**, using the compromised key, to a fresh
   wallet you control. This is a race with the attacker.
3. **Stop the server.** This stops the payment processor signing with the old
   key, so in-flight payouts pause rather than fail.
4. Generate a new keypair. Store its secret in the AWS secret, set
   `TREASURY_WALLET_ADDRESS` to the new address, and fund it ([runbook 2](#2-treasury-refill)).
5. **Restart.** The startup key check confirms the secret and the address match.
   Pending `PaymentQueue` rows are paid from the new treasury; they record only
   the recipient. **Rows with a `broadcastSignature` from the old treasury: check
   each on an explorer** ([runbook 1](#1-stuck-or-failed-payouts), step 3) before
   letting them retry.
6. Rotate the AWS credentials that could read the secret, and review who had
   access.

### `SESSION_SECRET`

It signs the browser session cookie. Rotating it invalidates every browser
cookie, but **the native app sends its raw token, which is unaffected**. To log
everyone out, also delete the session records in Redis (`session:*` and
`session:wallet:*`). Then restart.

### Other secrets

| Secret | Action |
|---|---|
| Mongo / Redis passwords | rotate at the provider, update the env, restart |
| `ADMIN_WALLETS` member compromised | remove it from `ADMIN_WALLETS`, restart, review recent `/api/admin/*` actions in the logs (drain toggles and withheld resolutions name the admin wallet) |
| Server RPC key (`SOLANA_RPC_URL`) | rotate at the RPC provider, update the env, restart |
| `CLIENT_RPC_URL` | public by design (the browser uses it); rotate only if it is being abused |
| reCAPTCHA secret, webhook URLs, `EMAIL_PASS` | rotate at the provider, update the env, restart |

Checklist §E lists the secrets already known to need rotation before launch.
