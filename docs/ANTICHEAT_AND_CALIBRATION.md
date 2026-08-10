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
- Native app + device attestation; restrict web to low stakes (biggest prevention win).
- Skill-based matchmaking (containment + skill-predominance argument).

See also `docs/MAINNET_LAUNCH_CHECKLIST.md` (legal is the #1 launch gate).
