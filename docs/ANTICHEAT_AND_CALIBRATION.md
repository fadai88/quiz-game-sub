# Anti-cheat, calibration & match-tuning — reference

A durable reference for the anti-cheat / integrity system and the LLM-calibration
tooling. All components below are built and committed. Most are **OFF by default**
and safe until you turn them on. Nothing here auto-seizes funds.

> Threat model: real-money trivia + frontier LLMs is near-worst-case — short
> multiple-choice recall is the easiest thing to automate, and the client is
> adversary-controlled. Winning design = prevention (raise the cost) + detection
> (catch what gets through). Goal is **negative EV via withhold-and-review**,
> never auto-accusation.

## Data pipeline (built)

| Component | File(s) | What it does |
|---|---|---|
| Per-answer telemetry | `models/AnswerTelemetry.js`, `services/telemetry.js` | One row per human answer/timeout: response time, correct, question id, mode, stake, **selectedOption, ip, socketId, userAgent** (for collusion/multi-account clustering), plus untrusted client signals. Fire-and-forget; never affects gameplay. Human-only. |
| Client context signals | `public/game.js` | Per-question tab-visibility / focus-blur / copy events, attached to `submitAnswer`. Untrusted (spoofable), catches same-device cheats only. |
| Human difficulty | `models/QuestionStats.js`, `services/questionStats.js` | Empirical per-question correct-rate / timeout-rate / avg response, → difficulty bucket. Cron every 6h. Manual: `node scripts/recompute-question-stats.js`. |
| LLM calibration | `models/QuestionCalibration.js`, `scripts/calibrate-questions.js` | Runs each question through an LLM (Claude or OpenAI), records correct/incorrect per `(questionId, model)`. |
| Discriminator seeding | `services/discriminators.js`, `gameService.sampleMatchQuestions()` | Optionally forces "hard for LLMs" questions into real-money matches. **OFF** (`DISCRIMINATOR_SEED_COUNT=0`). |
| Risk score | `models/PlayerRisk.js`, `services/riskScore.js` | Per-wallet suspicion from distributions (timing uniformity, accuracy, LLM-alignment, speed, IP clustering). Review-only. Cron daily. Manual: `node scripts/compute-player-risk.js`. |
| Auto-hold | `gameService.settlePotGame()` | If `RISK_AUTOHOLD=true`, a flagged winner's payout is HELD for review (never seized). Fails open. **OFF** by default. |
| Answer-key review | `scripts/answer-review.js` | Lists questions where models disagree with the stored answer (likely wrong keys) → `data/answer-review.md` (gitignored, private). |
| Calibration integrity | `scripts/check-calibration-integrity.js` | Reports orphaned/drifted calibration rows; `--repair` fixes answer-key drift free, `--prune` deletes orphans. |
| **Device attestation** | `services/attestation.js`, `routes/attestation.js`, `models/DeviceAttestation.js` | Proves a staked match comes from the real app binary on a genuine, unrooted device (Play Integrity). Gates staked joins in `socket/index.js`. **OFF** (`STAKED_REQUIRES_ATTESTATION=false`). |

### Device attestation — the prevention lever

Everything above is *detection*. Attestation is the one piece that stops an
attack rather than recording it: the web client is fully adversary-controlled, so
a headless browser, a DOM scraper or an LLM in a second tab is indistinguishable
from a real player. A native app that passes platform attestation makes that
whole cheap, scalable class stop working. It does **not** stop a second phone
pointed at the screen — this raises cost, it does not close the hole.

Flow, run by the app immediately before each staked join:

```
POST /api/attest/nonce   → single-use nonce (Redis, 2-min TTL)
   app asks Play Integrity for a token bound to that nonce
POST /api/attest/verify  → verdicts checked, session marked attested, device recorded
   staked join → assertStakedClientAllowed() reads the session's attestation
```

Design notes worth remembering:

- **Fresh per stake, not per login.** A session is "attested" only for
  `ATTESTATION_MAX_AGE_MS` (5 min), so a captured token is worthless later.
- **Fails CLOSED**, unlike `RISK_AUTOHOLD`: a verification error refuses entry.
  No funds are at risk in that direction, only a match that didn't start. The
  cost is that a provider outage stalls staked play, so
  `STAKED_REQUIRES_ATTESTATION=false` is the one-line kill switch.
- **`deviceId` is not a hardware id.** It is the app's install secret, hashed. A
  device seen with many wallets is still a much stronger multi-account signal
  than IP clustering (households and VPNs share IPs; devices don't). Feeding it
  into `services/riskScore.js` is a later phase.
- **Auth transport.** The app has no cookie jar, so it authenticates with
  `Authorization: Bearer <sessionToken>` (HTTP) and `handshake.auth.token`
  (socket). Same `session:<token>` record as the web cookie — one session model.
  `POST /api/auth/login` returns the token in the body only for callers sending
  `X-Client-Type: native`.
- **The `mock` provider is refused in production.** `ATTESTATION_PROVIDER`
  defaults to `mock`, which trusts whatever the client sends, and `/api/attest`
  is mounted unconditionally. Without this guard a production deployment left on
  the default would let anyone POST a hand-written payload and become "attested"
  — inheriting staking access and the reCAPTCHA exemption below.
- **reCAPTCHA exemption.** reCAPTCHA cannot run at the app's `https://localhost`
  origin, so a server-verified attestation is accepted in its place for staked
  joins. Both that exemption and the stake gate key off the same
  `isSessionAttested()` predicate, so "attested" cannot mean two different
  things. See `docs/MOBILE_APP.md`.

## Config flags (all in `.env`; defaults keep old behaviour)

| Flag | Default | Meaning |
|---|---|---|
| `QUESTIONS_PER_MATCH` | `10` | Questions per match (more ⇒ skill dominates). [1-50] |
| `TIEBREAK_MODE` | `response_time` | `response_time` (current) or `sudden_death` (extra question until tie breaks) |
| `SUDDEN_DEATH_MAX_ROUNDS` | `5` | Cap before sudden-death falls back to response_time |
| `DISCRIMINATOR_SEED_COUNT` | `0` (OFF) | Force N AI-discriminator questions into real-money matches |
| `DISCRIMINATOR_MODEL` | `claude-haiku-4-5-20251001` | Which calibration defines "hard for LLMs" |
| `RISK_AUTOHOLD` | `false` (OFF) | Auto-hold flagged winners' payouts for review |
| `ANSWER_TELEMETRY` | on | Set `false` to disable telemetry writes |
| `STAKED_REQUIRES_ATTESTATION` | `false` (OFF) | Staked play requires an attested native client. Also the kill switch |
| `STAKED_WEB_MAX_BET_USDC` | unset | Soft rollout: unattested web may stake up to this (USDC display units). Unset ⇒ no web staking once the gate is on |
| `ATTESTATION_PROVIDER` | `mock` | `google` (Play Integrity) \| `apple` (phase 3) \| `mock` (dev/tests) |
| `ATTESTATION_MAX_AGE_MS` | `300000` | How fresh an attestation must be at a staked join |
| `ATTESTATION_REQUIRE_PLAY_RECOGNIZED` | `true` | Set `false` for sideloaded beta builds (they report `UNRECOGNIZED_VERSION`) |
| `ANDROID_PACKAGE_NAME` | — | Expected package in the integrity verdict |
| `GOOGLE_PLAY_INTEGRITY_CREDENTIALS` | — | Service-account JSON, inline or a path |
| `ANDROID_APP_URL` | — | Shown by the web client when staking needs the app |

## Calibration state (as of 2026-08)

Bank: 11,512 questions. Calibrated:
- **Haiku 4.5** — 100%, ~93.7% correct.
- **Sonnet 5** — 100%, ~94.0% correct.
- **gpt-4o-mini** — ~61% (rate-limited by a shared OpenAI account; resumable — re-run when the OpenAI Codex CLI isn't running).

Disagreement (both Claude models, full coverage): 345 both-wrong (strongest discriminators), 347 only-Sonnet-wrong (data-quality suspects).

## How to run the calibration script

```bash
# Claude (default provider)
node scripts/calibrate-questions.js --model claude-sonnet-5 --batch 20 --concurrency 8
# OpenAI (provider auto-detected from model name; needs OPENAI_API_KEY + credits)
node scripts/calibrate-questions.js --model gpt-4o-mini --batch 10
# Guaranteed-complete finish (single mode never drops answers)
node scripts/calibrate-questions.js --model <id> --batch 1 --concurrency 8
```
Notes: keyed by `(questionId, model)` so each model adds a column. **Resumable**
(re-run to continue). Batch mode is fast but some models drop answers in large
batches — finish stragglers with `--batch 1`. Reads `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` from `.env`; never logs keys.

## Question identity — why calibration survives edits now

Calibration is expensive (an LLM call per question per model) and is referenced
by `questionId`, as are `QuestionStats` and `AnswerTelemetry`. Question `_id`s
are therefore **derived from question content** — `sha256(question + options)`,
truncated to 12 bytes — in `scripts/import-questions.js`.

`correctAnswer` is deliberately **excluded** from the hash: fixing a wrong answer
key preserves the question's identity and keeps its calibration, while editing
the wording or options mints a new id, which is correct — that is a different
question and its old calibration is meaningless.

> **Incident, 2026-08-25.** Before this, ids were generated fresh on every
> import. An answer-key fix + re-import detached **all 30,075 calibration rows**
> (verified: 0 of 300 sampled rows resolved to a live question). Nothing errored:
> `services/discriminators.js` fails soft, so `$in: discIds` simply matched
> nothing and every match played with zero discriminators, while the risk score's
> `aiAlignment` signal silently contributed zero. The rows are unrecoverable —
> a calibration row stores no question text, so it cannot be re-linked.
>
> Guards added since: the import previews `preserved / new / removed` before
> writing (and `--dry-run`), `getDiscriminatorIds()` logs an **error** when its
> ids resolve to no live questions, and `check-calibration-integrity.js` reports
> the state on demand.

After changing questions, always:

```bash
node scripts/import-questions.js data/quiz.json quiz --dry-run  # preview id churn
node scripts/import-questions.js data/quiz.json quiz
node scripts/check-calibration-integrity.js --repair            # free drift fix
```

## Answer-key review

```bash
node scripts/answer-review.js   # → data/answer-review.md (private, gitignored)
```
Tier 1 = all models picked the same different option (likeliest wrong key). It's
a *suspects* list — human-review each; models are sometimes wrong (e.g. dates).
Fix real errors in `quiz.txt` → rebuild via the quiz_db pipeline → re-import.

## Recommended rollout (keep it safe)

1. Run with `DISCRIMINATOR_SEED_COUNT=0` and `RISK_AUTOHOLD=false` — let telemetry
   and `PlayerRisk` accumulate from real games.
2. Periodically run `compute-player-risk.js`; eyeball high scorers — are they
   actually suspicious, or just good? Tune constants in `services/riskScore.js`.
3. Review `answer-review.md` and fix wrong answer keys (matters double for
   real-money — a wrong key can make the *right* player lose a staked match).
4. Only then consider enabling discriminator seeding / auto-hold. Even enabled,
   auto-hold is review-only (held pots go to the WithheldPayout operator worklist).

## Still open (need real players or product decisions, not more code)

- Adaptive per-question timers (data pipeline ready via `QuestionStats.avgResponseMs`).
- Collusion analysis from `selectedOption` (opponents' identical answer patterns).
- Extra risk features: account age, win rate, ROI, repeated-win triggers.
- **Build and test the Android app on a real device.** The shell, both native
  plugins and the whole client wiring are written (`mobile/`, see
  `docs/MOBILE_APP.md`) but have never been compiled — there was no Android
  toolchain in the dev environment. Nothing is proven until an APK runs.
- iOS App Attest (`apple` provider is stubbed).
- Feeding `DeviceAttestation.wallets` into `services/riskScore.js` clustering.
- **Store policy** — Apple and Google both treat real-money gaming as a
  restricted category needing licensed-entity status and per-region approval;
  crypto-stake apps are routinely rejected. Sits alongside the legal gate.
- Skill-based matchmaking (containment + skill-predominance argument).

See also `docs/MAINNET_LAUNCH_CHECKLIST.md` (legal is the #1 launch gate).
