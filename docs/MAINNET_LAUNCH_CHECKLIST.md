# Devnet → Mainnet Launch Checklist

Real money moves on mainnet. Nothing below is optional theatre — each item has
burned a real project somewhere. Line references drift as code moves; re-grep.

**Current state:** pot mode (`MONETIZATION=pot`), **devnet**, `NODE_ENV=development`.

**Honest readiness note (2026-07):** the code's security/correctness is in good
shape (verified payments, idempotent payouts, restart refund recovery, on-chain
refunds, drain mode). It is **not** the same as "ready to take uncapped real
money": it has never run on mainnet, still has **no load/soak testing**, and the
Android app (`docs/MOBILE_APP.md`) has never been compiled. Coverage has grown to
10 test files / 120 assertions, but socket auth, matchmaking, transaction
verification and restart recovery remain uncovered. Prefer a **phased launch**
(Section I).

---

## 0. Legal & compliance — DO THIS FIRST (non-code, can be a showstopper)

A "stake USDC, winner takes the pot" game is very likely **gambling** or
regulated **skill-gaming** in many jurisdictions. Code cannot fix this.

- [ ] Get a **lawyer's written read** for every market you'll accept players from.
- [ ] Determine if you need a **license** (can take months) or must restrict to
      skill-gaming-permitted regions.
- [ ] **Geo-block** prohibited jurisdictions (IP + wallet-level if required).
- [ ] **Terms of Service**, privacy policy, responsible-gaming disclosures.
- [ ] **Age verification** if required.
- [ ] **KYC/AML** if stakes/volumes cross reporting thresholds.
- [ ] Tax/withholding obligations on winnings.

> Do not process a single real-money game until this section has legal sign-off.

---

## A. Environment variables (`.env` / Railway variables)

| Variable | Current (devnet) | Mainnet action |
|---|---|---|
| `NODE_ENV` | `development` | **`production`** — flips on secure cookies, HSTS, Mongo TLS, and FATAL startup gates (Section D). |
| `USDC_MINT_ADDRESS` | `Gh9Zw…KGtKJr` (devnet) | **`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`** (mainnet USDC). |
| `TREASURY_WALLET_ADDRESS` | `NoyR3n…DTp4` | Your **mainnet** treasury pubkey. **Must match the AWS-stored key** — the server now asserts this at boot and exits if it doesn't (Section C). |
| `SOLANA_RPC_URL` | devnet Helius | **Mainnet server** endpoint. Privileged — never sent to browsers. |
| `CLIENT_RPC_URL` | devnet Helius | A **separate, client-scoped** mainnet endpoint (served to browsers via `/api/config`). Never reuse the server key. |
| `ALLOWED_ORIGINS` | **missing** | **Required** — `https://your-domain`. Production FATAL-exits if unset. |
| `RECAPTCHA_SITE_KEY` / `RECAPTCHA_SECRET_KEY` | `6LeDS1IqA…` | Keys registered for the **production domain**; rotate the secret (Section E). |
| `MONGODB_URI` | — | Production Atlas cluster; **rotate its password** (Section E). Prod forces TLS. |
| `REDIS_URL` **or** `REDIS_PASSWORD` | — | Required in production. Use an authenticated instance. |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | (unset → verify) | Leave unset/`true`. **Setting it `false` now FATAL-exits in production.** For a private-CA Redis, use `REDIS_CA_CERT` instead. |
| `REDIS_CA_CERT` | — | Optional PEM (CA cert) for a private-CA/self-signed Redis; escaped `\n` is normalized. |
| `SESSION_SECRET` | set | Required in production; rotate if it ever left your control (Section E). |
| `ENABLE_RECAPTCHA` | `true` | Must stay `true` — production FATAL-exits otherwise. |
| `ENABLE_USDC_PAYMENTS` | `true` | Keep `true`. |
| `MONETIZATION` | `pot` | Confirm intended. |
| `TRUSTED_PROXY_IPS` | — | Set to your reverse-proxy/LB IPs (Section D) so IP rate-limits + `X-Forwarded-*` are trustworthy. |
| `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL` | — | Set at least one so alerts actually reach you (Section F). |
| `MIN_TREASURY_SOL` / `MIN_TREASURY_USDC` | defaults | Tune the low-balance alert thresholds (Section F). |
| `PROGRAM_ID` | `DpEXv5…` | Not read by runtime code (flow is plain SPL transfers + memo). Ignore unless you wire the Anchor program in. |

---

## B. Hardcoded client values (change in source, not just env)

- [ ] **`public/game-init.js`** — `TREASURY_WALLET` hardcoded fallback (`NoyR3n…`) → mainnet treasury. (`USDC_MINT` there is already mainnet.) Used during the pre-`/api/config` load gap and if config fetch fails.
- [ ] **`public/game.js`** — RPC fallback default `https://api.devnet.solana.com` → `https://api.mainnet-beta.solana.com`.
- [ ] **`public/subscription.js`** — devnet RPC + hardcoded devnet mint/treasury. **No-op for pot mode** (not served); fix only if you run subscription mode.
- [ ] **`middleware/securityHeaders.js`** — CSP `connect-src` already whitelists mainnet Helius + `api.mainnet-beta.solana.com`. Add your mainnet RPC host if it differs, or the browser blocks it.
- [ ] Re-grep for stragglers (command at the bottom).

---

## C. Treasury: keys, funding, and solvency

- [ ] **Key ↔ address match** — now enforced at boot (`server.js` `initializeConfig` asserts `TREASURY_KEYPAIR.publicKey == TREASURY_WALLET`). A mismatch fails startup; make sure the AWS secret is the mainnet treasury's key.
- [ ] **Mainnet USDC ATA** for the treasury, funded enough to **front winnings** (winner gets 1.8× their stake; the pot is 2× so the house nets a 0.2× rake, but the treasury pays the winner before/independently of settling).
- [ ] **SOL for fees** — every payout **and every refund** is now an on-chain tx (refund recovery, drain-refunds, matchmaking-failure refunds all queue on-chain). `PaymentProcessor` refuses below **~0.005 SOL**. Keep a healthy buffer and auto-alert (Section F).
- [ ] **Solvency plan** — model a bad run (many consecutive wins) and ensure the treasury can't go insolvent mid-payout. Decide a **max concurrent exposure** and cap stakes/users accordingly at launch.
- [ ] **`VALID_BET_AMOUNTS_USDC`** = `[3, 10, 15, 20, 30]` (`utils/usdcUtils.js`) — confirm this is the intended real-money ladder. Consider starting **lower** (e.g. `[1]`) for the beta.
- [ ] **IAM least-privilege** on the AWS secret; enable **CloudTrail** on secret reads; prefer an IAM role over static keys.

---

## D. What `NODE_ENV=production` turns on (verify each)

- [ ] **Secure cookies** — the app must be **HTTPS end-to-end** or sessions silently break.
- [ ] **HSTS** only over HTTPS via a trusted proxy — set `TRUSTED_PROXY_IPS`.
- [ ] **MongoDB TLS** enforced — Atlas is fine.
- [ ] **Startup FATAL gates** satisfied: `ENABLE_RECAPTCHA=true`, `RECAPTCHA_SECRET_KEY`, Redis auth, `SESSION_SECRET`, `ALLOWED_ORIGINS`, treasury-key match, and **`REDIS_TLS_REJECT_UNAUTHORIZED` not `false`**.

---

## E. Secrets to rotate before launch

- [ ] **reCAPTCHA secret** — was written to a log file; treat as compromised. Rotate + delete the offending `logs/audit-*.log`.
- [ ] **Devnet Helius RPC key** (`961d5e62…`) — was public in client source; rotate (low impact).
- [ ] **If `.env` ever left your control:** rotate `SESSION_SECRET` (forces re-login), prod **MongoDB** password, `REDIS_PASSWORD`, `EMAIL_PASS`.
- [ ] **Treasury key** — do **not** rotate absent evidence of compromise (rotating means migrating all funds); harden access instead.

---

## F. Operational readiness (monitoring, alerts, runbooks)

- [ ] **Wire alerts** — set `SLACK_WEBHOOK_URL` or `DISCORD_WEBHOOK_URL`; without one, alerts only hit the console. Confirm they fire to a channel you watch.
- [ ] Watch especially: `FAILED_PAYOUTS`, `REFUND_FAILED`, `PAYOUT_BLOCKED`, low-treasury (SOL/USDC), stuck payments, Mongo/Redis reconnects.
- [ ] **Treasury balance dashboard/alert** (SOL + USDC), tuned via `MIN_TREASURY_SOL` / `MIN_TREASURY_USDC`.
- [ ] **Runbooks** (write these before launch):
  - Stuck/failed payouts (inspect `PaymentQueue`, retry, manual send).
  - Treasury refill (SOL and USDC) procedure.
  - **Withheld payouts** — resolve via `GET/POST /api/admin/withheld-payouts` (refund / release / deny).
  - **Planned restart** — enable drain, wait, redeploy (Section H).
  - Key/secret compromise response.
- [ ] **Know the recovery behaviors:**
  - **Crash/restart** → the server auto-refunds every in-flight stake on next boot (`restartRecovery`) — **requires treasury SOL**.
  - **Planned restart** → drain first (below) so few/no games are interrupted.
- [ ] Confirm **`ADMIN_WALLETS`** contains your **mainnet** admin wallet(s).
- [ ] Decide **single vs multi-instance**. Payment claims are now atomic (safe for multi-instance), but multi-instance is **untested** — if single-instance, it's a SPOF; plan restarts/failover.

---

## G. Load & soak testing (currently NONE — do before real traffic)

- [ ] **Concurrency test** matchmaking + full game loop under N simultaneous games (races, Redis contention, socket churn).
- [ ] **Payment throughput** — queue many payouts/refunds; confirm no double-send, no stuck queue, treasury fee burn is sustainable.
- [ ] **Soak test** — run for hours; watch for memory leaks, orphaned rooms, timer drift, reconnect storms.
- [ ] **Kill-test recovery** — hard-kill the server mid-game repeatedly; confirm every stake is refunded on reboot and nothing double-pays.
- [ ] Expand **automated tests** beyond the current 4 files (socket auth, matchmaking, tx verification, restart recovery are uncovered).

---

## H. Pre-flight verification (immediately before taking traffic)

- [ ] `npm test` → **120/120 green** (10 test files).
- [ ] `node scripts/check-calibration-integrity.js` → no orphaned rows. Orphans
      mean discriminator seeding and the risk score's `aiAlignment` signal are
      silently doing nothing (see `docs/ANTICHEAT_AND_CALIBRATION.md`).
- [ ] Boot with the production `.env`; confirm **no FATAL exits**, `🔑 Treasury key verified`, and `✅ Config initialized successfully`.
- [ ] `GET /api/config` returns mainnet `rpcUrl`, `usdcMint` (`EPjF…`), `treasuryWallet`.
- [ ] **One real end-to-end mainnet stake** at the smallest amount: stake → match/forfeit → **payout lands on-chain**, `PaymentQueue` shows `completed`.
- [ ] **Refund path**: force a matchmaking failure (or a restart mid-queue) and confirm the stake comes **back on-chain**.
- [ ] **Drain mode**: `POST /api/admin/maintenance {enabled:true}` → new games rejected + client blocks staking; `GET /api/admin/maintenance` shows `activeGames`; a redeploy clears it.
- [ ] **Withheld flow**: verify a `WithheldPayout` row is created and the admin resolve endpoints work.

---

## I. Phased launch plan (recommended over a single cutover)

1. **Closed beta** — mainnet, **tiny stakes** (e.g. `$1`), a small **invited** group, heavy monitoring, for 1–2 weeks. Watch treasury flows, refund correctness, stuck rooms, payout success.
2. **Widen** — raise stakes/users gradually only after the beta behaves cleanly.
3. **Open** — remove the invite gate once you've seen real-money stability and legal is fully cleared.

Keep a **max concurrent exposure cap** through phase 1–2 so a bug or a bad run can't exceed a loss you can absorb.

---

## J. Post-launch monitoring (first days)

- [ ] Treasury SOL + USDC trending as expected; low-balance alerts arriving.
- [ ] Payout success rate ~100%; investigate any `failed`/stuck `PaymentQueue` rows.
- [ ] No stranded stakes (spot-check that every abandoned/failed game got refunded).
- [ ] Logs contain **no secrets** and reasonable PII hygiene.
- [ ] Watch for stuck rooms / orphaned players / reconnect issues in the first N games.

---

### Re-find hardcoded network values
```bash
grep -rniE "devnet|Gh9ZwEmdLJ8|NoyR3nErDpw4|api\.devnet\.solana|961d5e62" \
  public/ routes/ services/ middleware/ config/ server.js --include=*.js | grep -v vendor/
```
