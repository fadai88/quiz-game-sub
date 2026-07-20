# Devnet → Mainnet Launch Checklist

Real money moves on mainnet. Work top to bottom; do not skip Section F (pre-flight)
before taking traffic. Line references are to the state of the repo when this was
written — re-grep if code has moved.

Current deployment is **pot mode** (`MONETIZATION=pot`), **devnet**, `NODE_ENV=development`.

---

## A. Environment variables (`.env`)

| Variable | Current (devnet) | Mainnet action |
|---|---|---|
| `NODE_ENV` | `development` | **`production`** — flips on cookie `secure`, HSTS, MongoDB TLS, and the FATAL startup gates below. |
| `USDC_MINT_ADDRESS` | `Gh9Zw…KGtKJr` (devnet USDC) | **`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`** (mainnet USDC). |
| `TREASURY_WALLET_ADDRESS` | `NoyR3n…DTp4` | Your **mainnet** treasury pubkey. Address is network-agnostic, so you *can* keep the same keypair — but decide whether you want a fresh treasury separate from devnet testing. Must match the AWS-stored key (see Section C). |
| `SOLANA_RPC_URL` | devnet Helius | Your **mainnet server** endpoint (line 4 in `.env` already has one, commented). Privileged — stays server-side. |
| `CLIENT_RPC_URL` | devnet Helius (same key as server) | A **separate, client-scoped** mainnet endpoint. **Never reuse the `SOLANA_RPC_URL` key here** — this value is served to browsers via `/api/config`. |
| `ALLOWED_ORIGINS` | **missing** | **Required** — `https://your-prod-domain`. `server.js:86` FATAL-exits in production if unset (no localhost CORS fallback). |
| `RECAPTCHA_SITE_KEY` / `RECAPTCHA_SECRET_KEY` | `6LeDS1IqA…` | Confirm these are registered for the **production domain** (reCAPTCHA keys are domain-scoped) and rotate the secret (Section E). |
| `MONGODB_URI` | — | Production Atlas cluster; rotate its password (Section E). Production forces TLS (`server.js:195`). |
| `REDIS_URL` **or** `REDIS_PASSWORD` | — | Required in production (`config/constants.js:74`). Use an authenticated instance. |
| `SESSION_SECRET` | set | Required in production (`server.js:75`). Rotate if it ever left your control (Section E). |
| `ENABLE_RECAPTCHA` | `true` | Must stay `true` — production FATAL-exits otherwise (`config/constants.js:66`). |
| `ENABLE_USDC_PAYMENTS` | `true` | Keep `true`. |
| `MONETIZATION` | `pot` | Confirm intended (`pot` vs `subscription`). |
| `PROGRAM_ID` | `DpEXv5…` | **Not read by any runtime code** — the payment flow is plain SPL USDC transfers + memo, not the Anchor program. Safe to ignore for launch unless you wire the on-chain program in later. |

---

## B. Hardcoded client values (change these in source)

These are baked into shipped JS as fallbacks/defaults and won't be fixed by env vars alone.

- [ ] **`public/game-init.js:39-40`** — `TREASURY_WALLET` hardcoded to `NoyR3n…`. This is the pre-`/api/config` fallback; set it to your **mainnet treasury**. (Its `USDC_MINT` at line 37 is already the mainnet mint `EPjF…`.) In pot mode `/api/config` overrides these once loaded, but this is the value used during the load gap and if config fetch fails.
- [ ] **`public/game.js:607`** — RPC fallback default is `https://api.devnet.solana.com`. Change to `https://api.mainnet-beta.solana.com` so a config-load failure doesn't drop the client onto the wrong network.
- [ ] **`public/subscription.js:28`** — same devnet RPC fallback → mainnet. **Only if you run subscription mode**; this file also hardcodes the **devnet** USDC mint at line 17 (`Gh9Zw…`) and treasury at line 20–22, none of which are fed by `/api/config`. For a pot-mode launch, `subscription.js` is not served, so this is a no-op.
- [ ] **`middleware/securityHeaders.js:41`** — CSP `connect-src` already whitelists mainnet Helius + `api.mainnet-beta.solana.com`. If your mainnet RPC uses a **different provider/hostname**, add it here or the browser will block the connection.

---

## C. Treasury & on-chain prerequisites

- [ ] The **AWS Secrets Manager** treasury key (`wallet_secret_key`) must correspond to `TREASURY_WALLET_ADDRESS`. Add the L3 init assertion (`assert keypair.publicKey.equals(TREASURY_WALLET)` in `server.js` `initializeConfig`) so a mismatch fails fast instead of silently signing from the wrong wallet.
- [ ] Treasury needs a **mainnet USDC associated token account (ATA)** holding enough USDC to cover payouts (winner gets 1.8× their stake; treasury keeps the 0.2× rake, so it must be able to front the winnings until stakes settle).
- [ ] Fund the treasury with **SOL** for fees + ATA creation. `PaymentProcessor.queuePayment` refuses to run below **~0.005 SOL** (`services/PaymentProcessor.js:110`). Keep a buffer.
- [ ] Confirm **`VALID_BET_AMOUNTS_USDC`** = `[3, 10, 15, 20, 30]` (`utils/usdcUtils.js:16`) is the intended real-money stake ladder. These become actual dollars.
- [ ] Lock down IAM on the treasury secret (least privilege) and enable **CloudTrail** on secret reads. Prefer an IAM role over static AWS keys; if static `AWS_ACCESS_KEY_ID`/`SECRET` ever existed in `.env`, rotate them.

---

## D. What `NODE_ENV=production` turns on (verify each works)

- [ ] **Cookies** get `secure: true` (`config/constants.js:103`) — the app must be served over **HTTPS end-to-end**, or sessions silently break.
- [ ] **HSTS** header is sent only when the request is HTTPS via a **trusted proxy** — set `TRUSTED_PROXY_IPS` to your reverse-proxy/load-balancer IPs (`middleware/trustedProxy.js`), or IP rate-limits and `X-Forwarded-*` handling misbehave.
- [ ] **MongoDB TLS** is enforced (`server.js:195`) — Atlas is fine; a non-TLS Mongo will fail to connect.
- [ ] Startup **FATAL gates** all satisfied: `ENABLE_RECAPTCHA=true`, `RECAPTCHA_SECRET_KEY`, Redis auth, `SESSION_SECRET`, `ALLOWED_ORIGINS`.

---

## E. Secrets to rotate before launch

- [ ] **reCAPTCHA secret** — it was written to a log file (finding M2); treat as compromised. Rotate in the Google reCAPTCHA console and delete the offending `logs/audit-*.log`.
- [ ] **Devnet Helius RPC key** (`961d5e62…`) — was public in client source; rotate it (low impact, devnet).
- [ ] **If `.env` ever left your sole control** (shared/pasted/backed up): rotate `SESSION_SECRET` (forces re-login), the prod **MongoDB** password, `REDIS_PASSWORD`, and `EMAIL_PASS`.
- [ ] **Treasury key** — do **not** rotate absent evidence of compromise (rotating means migrating all treasury funds). Harden access instead (Section C).

---

## F. Pre-flight verification (run before taking traffic)

- [ ] `npm test` (or `npx mocha tests/*.js --exit`) green — note `tests/gameService.timeout.js` has a **pre-existing** failure (`markUnansweredPlayersTimedOut` missing) unrelated to launch.
- [ ] Boot the server with the production `.env` and confirm **no FATAL exits** and `✅ Config initialized successfully`.
- [ ] Hit **`GET /api/config`** and verify `rpcUrl`, `usdcMint` (mainnet `EPjF…`), `treasuryWallet` are all the mainnet values — this is what the browser trusts.
- [ ] Do **one real end-to-end stake** for the smallest amount on mainnet: stake → match (or forfeit) → confirm the **payout lands on-chain** and `PaymentQueue` shows `completed`.
- [ ] Verify a **withheld** path writes a `WithheldPayout` row and the admin endpoints (`GET/POST /api/admin/withheld-payouts`) work with an `ADMIN_WALLETS` account.
- [ ] Confirm `ADMIN_WALLETS` contains your **mainnet** admin wallet(s).

---

## G. Post-launch smoke test

- [ ] Treasury SOL + USDC balances draining/refilling as expected; set a **low-balance alert**.
- [ ] Alerts firing to a channel you watch (`config/alerts.js`) — especially `FAILED_PAYOUTS`, `REFUND_FAILED`, `PAYOUT_BLOCKED`.
- [ ] Spot-check logs contain **no secrets** and reasonable PII hygiene (`logs/` is now untracked).
- [ ] Watch the first N games for stuck rooms / orphaned players / refund correctness.

---

### Quick grep to re-find hardcoded network values
```bash
grep -rniE "devnet|Gh9ZwEmdLJ8|NoyR3nErDpw4|api\.devnet\.solana" \
  public/ routes/ services/ middleware/ config/ server.js --include=*.js | grep -v vendor/
```
