/**
 * services/gameService.js
 * Core game-flow orchestration: question rounds, bot turns, game-over logic.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const logger = require("../logger");
const context = require("../context");
const User = require("../models/User");
const GameSession = require("../models/GameSession");
const WithheldPayout = require("../models/WithheldPayout");
const { shuffleArray } = require("../utils/helpers");
const {
  GAME_MODES,
  POT_MULTIPLIERS,
  FRAUD_SUSPICION_THRESHOLD,
  QUESTIONS_PER_MATCH,
  TIEBREAK_MODE,
  TIEBREAK_MODES,
  SUDDEN_DEATH_MAX_ROUNDS,
  DISCRIMINATOR_SEED_COUNT,
  isRiskAutoholdEnabled,
  isPotMode,
} = require("../config/constants");
const { calculateWinnings, formatUSDC } = require("../utils/usdcUtils");
const { trackPayoutBlocked, trackFailedPayout } = require("../config/alerts");
const {
  getGameRoom,
  updateGameRoom,
  deleteGameRoom,
  atomicRoomUpdate,
  logGameRoomsState,
} = require("./roomManager");
const {
  TriviaBot,
  chooseBotName,
  determineBotDifficulty,
} = require("./botService");
const { updatePlayerStats } = require("./playerService");
const { queueOnChainRefund } = require("./refunds");
const {
  acquireIdempotencyLock,
  releaseIdempotencyLock,
} = require("../utils/idempotency");

// Quiz model is expected to be in models/Quiz — adjust path if different
const Quiz = require("../models/Quiz");
const PracticeQuiz = require("../models/PracticeQuiz");
const telemetry = require("./telemetry");
const { getDiscriminatorIds } = require("./discriminators");
// Imported as a namespace (not destructured) so tests can stub computePlayerRisk.
const riskScore = require("./riskScore");

// Pick the question bank for a room. Free practice games draw from the separate
// PracticeQuiz collection; every real game — staked, ranked, or tournament —
// uses the main Quiz bank, so the paid pool is never served in free play.
// Ordering matters: a staked room is real even though createGameRoom defaults an
// option-less room's gameMode to "practice" (e.g. the legacy joinGame path).
function questionBankForRoom(room) {
  const staked = Number(room?.betAmount) > 0;
  const mode = room?.gameMode;
  if (staked || mode === GAME_MODES.RANKED || mode === GAME_MODES.TOURNAMENT) {
    return Quiz;
  }
  if (mode === GAME_MODES.PRACTICE || room?.isPractice === true) {
    return PracticeQuiz;
  }
  return Quiz; // safe default: never serve the practice bank to an unclassified game
}

// Sample the question set for a match. Normally a plain random $sample of
// QUESTIONS_PER_MATCH. When DISCRIMINATOR_SEED_COUNT > 0, force that many
// "AI-discriminator" questions (hard for LLMs) into a real-money match and fill
// the rest from non-discriminator questions. `matchStage` carries the
// recent-questions exclusion. Falls back to a plain sample for practice games,
// when seeding is off, or when no discriminators are available — so the default
// (seed count 0) behaves exactly like the previous plain $sample.
async function sampleMatchQuestions(room, matchStage) {
  const bank = questionBankForRoom(room);
  const total = QUESTIONS_PER_MATCH;
  const seed = DISCRIMINATOR_SEED_COUNT;

  // Seeding only applies to the calibrated real-money bank (Quiz).
  if (!(seed > 0 && seed < total && bank === Quiz)) {
    return bank.aggregate([...matchStage, { $sample: { size: total } }]);
  }

  const discIds = await getDiscriminatorIds();
  if (!discIds.length) {
    return bank.aggregate([...matchStage, { $sample: { size: total } }]);
  }

  const seedQs = await bank.aggregate([
    ...matchStage,
    { $match: { _id: { $in: discIds } } },
    { $sample: { size: seed } },
  ]);
  const usedIds = seedQs.map((q) => q._id);
  const restQs = await bank.aggregate([
    ...matchStage,
    { $match: { _id: { $nin: [...discIds, ...usedIds] } } },
    { $sample: { size: total - seedQs.length } },
  ]);
  return shuffleArray([...seedQs, ...restQs]);
}

// ─── Abort with refund ────────────────────────────────────────────────────────

async function abortGameWithRefund(roomId, reason) {
  try {
    const room = await getGameRoom(roomId);
    if (!room) return;

    for (const player of room.players.filter((p) => !p.isBot)) {
      await queueOnChainRefund(
        player.username,
        room.betAmount,
        `refund:${roomId}:${player.username}`,
        reason
      );
    }

    await GameSession.findOneAndUpdate(
      { roomId },
      { status: "refunded", endTime: new Date(), refundReason: reason }
    );
    logger.info(`💰 Refunded and aborted room ${roomId} due to: ${reason}`);
  } catch (err) {
    logger.error(`Failed to process abort refund for room ${roomId}:`, err);
  }
}

// ─── Pot settlement ───────────────────────────────────────────────────────────

/**
 * Settle a pot-mode game by queueing the winner's payout.
 *
 * Ported from the pre-refactor monolith (server.js @ 9e0f96d), which paid the
 * winner a multiple of their own stake: 1.8× against a human (both players
 * staked, so the pot is 2× and the house keeps a 10% rake) or 1.5× against a
 * bot (no second stake — the treasury funds it).
 *
 * Payouts are withheld rather than sent when the winner's play looks automated;
 * an on-chain transfer cannot be clawed back, so anything suspicious is flagged
 * for review instead. A missing botDetector or paymentProcessor is treated the
 * same way: never pay out when the checks that gate the payout aren't running.
 *
 * @returns {Promise<{paymentId: string|null, withheld: boolean, withheldReason: string|null}>}
 */
// Escrow / audit record for a withheld pot. Idempotent per room (unique roomId),
// so a duplicate settlement cannot create a second row. Writing this never moves
// funds and never changes the payout outcome — a failure here is logged and
// swallowed. It exists so a withheld pot becomes an operator worklist item
// instead of being silently kept in the treasury (M1).
async function recordWithheldPayout({
  roomId,
  walletAddress,
  stakeAmount,
  intendedPayout = null,
  reason,
  flags = [],
  suspicionScore = null,
}) {
  try {
    await WithheldPayout.findOneAndUpdate(
      { roomId },
      {
        $setOnInsert: {
          roomId,
          walletAddress,
          stakeAmount,
          intendedPayout,
          reason,
          flags,
          suspicionScore,
          status: "pending_review",
        },
      },
      { upsert: true, new: false }
    );
    logger.info(
      `[PAYOUT] Withheld pot recorded for review — room ${roomId}, winner ${walletAddress}, reason ${reason}, stake ${formatUSDC(
        stakeAmount
      )}`
    );
  } catch (err) {
    logger.error(`[PAYOUT] Failed to record withheld pot for room ${roomId}:`, {
      error: err.message,
    });
  }
}

async function settlePotGame(roomId, room, winner, botOpponent) {
  const outcome = { paymentId: null, withheld: false, withheldReason: null };

  // Bots never get paid, and a game with no winner has nothing to settle.
  const winnerIsHuman =
    winner && !room.players.some((p) => p.username === winner && p.isBot);
  if (!winnerIsHuman) return outcome;

  // No stake, nothing to pay. Free bot/practice rooms are created with
  // betAmount 0 and must never reach the payment queue.
  if (!room.betAmount || room.betAmount <= 0) return outcome;

  // Winnings this game would have paid — recorded on every withhold so an
  // operator can see what was owed when resolving the held pot.
  const intendedPayout = Number(
    calculateWinnings(
      room.betAmount,
      botOpponent
        ? POT_MULTIPLIERS.BOT_OPPONENT
        : POT_MULTIPLIERS.HUMAN_OPPONENT
    )
  );

  // Defense-in-depth: a staked bot game pays 1.5× from the treasury with no
  // opposing stake to fund it, so it must not exist in pot mode — the bot-
  // routing socket events (joinGame / switchToBot / requestBotGame) are gated to
  // enforce this. If a staked bot game still reaches settlement, a gate was
  // bypassed: refuse the payout and flag for manual review rather than draining
  // the treasury.
  if (botOpponent) {
    logger.error(
      `[PAYOUT] Refusing treasury-funded bot payout for a staked pot game — winner ${winner}, room ${roomId}. This path should be unreachable; a bot-routing gate was bypassed.`
    );
    await trackPayoutBlocked(winner, {
      message: `Staked bot game reached settlement in pot mode (gate bypass)`,
      walletAddress: winner,
      roomId,
      betAmount: room.betAmount,
    });
    await recordWithheldPayout({
      roomId,
      walletAddress: winner,
      stakeAmount: room.betAmount,
      intendedPayout,
      reason: "staked_bot_game",
    });
    outcome.withheld = true;
    outcome.withheldReason = "staked_bot_game";
    return outcome;
  }

  const botDetector = context.botDetector;
  const paymentProcessor = context.paymentProcessor;

  if (!botDetector || !paymentProcessor) {
    const missing = !botDetector ? "botDetector" : "paymentProcessor";
    logger.error(
      `[PAYOUT] ${missing} unavailable — withholding payout for ${winner} in room ${roomId}`
    );
    await trackPayoutBlocked(winner, {
      message: `Payout withheld: ${missing} unavailable`,
      walletAddress: winner,
      roomId,
      betAmount: room.betAmount,
    });
    await recordWithheldPayout({
      roomId,
      walletAddress: winner,
      stakeAmount: room.betAmount,
      intendedPayout,
      reason: "unavailable",
    });
    outcome.withheld = true;
    outcome.withheldReason = "unavailable";
    return outcome;
  }

  const suspicionScore = botDetector.getSuspicionScore(winner);
  logger.info(`[SECURITY] Audit for winner ${winner}: Score ${suspicionScore}`);

  if (suspicionScore >= FRAUD_SUSPICION_THRESHOLD) {
    const botAnalysis = botDetector.getBotAnalysis(winner);
    const flags = botAnalysis.flags || [];
    logger.warn(
      `🚨 FRAUD DETECTED: Withholding payout for ${winner}. Score: ${suspicionScore}. Flags: ${JSON.stringify(
        flags
      )}`
    );

    await User.findOneAndUpdate(
      { walletAddress: winner },
      {
        $set: {
          isFlagged: true,
          flagReason: `Bot Score ${suspicionScore}: ${flags.join(",")}`,
        },
      }
    );

    await trackPayoutBlocked(winner, {
      message: `Payout blocked for bot behavior: ${winner}`,
      walletAddress: winner,
      roomId,
      suspicionScore,
      flags,
      betAmount: room.betAmount,
    });
    await recordWithheldPayout({
      roomId,
      walletAddress: winner,
      stakeAmount: room.betAmount,
      intendedPayout,
      reason: "fraud",
      flags,
      suspicionScore,
    });

    outcome.withheld = true;
    outcome.withheldReason = "fraud";
    return outcome;
  }

  // Risk-score auto-hold (opt-in via RISK_AUTOHOLD). A second, distribution-based
  // gate: hold the payout for review when the winner's telemetry risk score is
  // flagged. Fails OPEN — insufficient data (<MIN_ANSWERS) never flags, and any
  // error pays out normally, so a scoring bug can never wrongly withhold funds.
  if (isRiskAutoholdEnabled()) {
    try {
      const risk = await riskScore.computePlayerRisk(winner);
      if (risk && risk.flagged) {
        const flags = Object.keys(risk.signals || {}).filter(
          (k) => risk.signals[k] >= 0.5
        );
        logger.warn(
          `🚩 RISK AUTO-HOLD: withholding payout for ${winner} in room ${roomId}. ` +
            `Score ${risk.score}. Signals ${JSON.stringify(risk.signals)}`
        );
        await User.findOneAndUpdate(
          { walletAddress: winner },
          {
            $set: {
              isFlagged: true,
              flagReason: `Risk score ${risk.score}: ${flags.join(",")}`,
            },
          }
        );
        await trackPayoutBlocked(winner, {
          message: `Payout auto-held for review: risk score ${risk.score}`,
          walletAddress: winner,
          roomId,
          suspicionScore: risk.score,
          flags,
          betAmount: room.betAmount,
        });
        await recordWithheldPayout({
          roomId,
          walletAddress: winner,
          stakeAmount: room.betAmount,
          intendedPayout,
          reason: "risk_score",
          flags,
          suspicionScore: risk.score,
        });
        outcome.withheld = true;
        outcome.withheldReason = "risk_score";
        return outcome;
      }
    } catch (err) {
      logger.error(
        `[PAYOUT] Risk auto-hold check failed for ${winner} in room ${roomId} — paying out (fail open):`,
        { error: err.message }
      );
    }
  }

  const multiplier = botOpponent
    ? POT_MULTIPLIERS.BOT_OPPONENT
    : POT_MULTIPLIERS.HUMAN_OPPONENT;
  const winningAmount = calculateWinnings(room.betAmount, multiplier);

  try {
    const queuedPayment = await paymentProcessor.queuePayment(
      winner,
      Number(winningAmount),
      roomId, // roomId doubles as the gameId for idempotency
      room.betAmount,
      { botOpponent, singlePlayerMode: room.roomMode === "bot" }
    );
    outcome.paymentId = queuedPayment._id.toString();
    logger.info(
      `Payout queued for ${winner}: Payment ID ${
        outcome.paymentId
      }, Amount ${formatUSDC(winningAmount)}`
    );
  } catch (error) {
    // The stake is already collected, so a failed queue must not look like a
    // completed game — surface it and let the caller tell the player.
    logger.error(`[PAYOUT] Failed to queue payout for ${winner}:`, { error });
    await trackFailedPayout({
      message: `Failed to queue payout for ${winner}`,
      walletAddress: winner,
      roomId,
      betAmount: room.betAmount,
      error: error.message,
    });
    await recordWithheldPayout({
      roomId,
      walletAddress: winner,
      stakeAmount: room.betAmount,
      intendedPayout,
      reason: "error",
    });
    outcome.withheld = true;
    outcome.withheldReason = "error";
  }

  return outcome;
}

// ─── Start game (human vs human) ─────────────────────────────────────────────

async function startGame(roomId) {
  const io = context.io;
  logger.info(`Attempting to start game in room ${roomId}`);

  // Atomically claim the game start — prevents duplicate startGame calls
  // (e.g. one from matchmaking and one from playerReady firing concurrently)
  const claimedRoom = await atomicRoomUpdate(roomId, async (latest) => {
    if (!latest || latest.gameStarted) {
      latest._alreadyStarted = true;
      return latest;
    }
    latest.gameStarted = true;
    latest.players.forEach((p) => (p.score = 0));
    return latest;
  });

  if (!claimedRoom || claimedRoom._alreadyStarted) {
    if (claimedRoom?._alreadyStarted)
      logger.info(`Game already started in room ${roomId}, skipping`);
    return;
  }

  let room = claimedRoom;
  try {
    const humanPlayer = room.players.find((p) => !p.isBot);
    let matchStage = [];
    if (humanPlayer) {
      const user = await User.findOne({ walletAddress: humanPlayer.username });
      if (user?.recentQuestions?.length > 0) {
        const recentIds = user.recentQuestions.map(
          (id) => new mongoose.Types.ObjectId(id)
        );
        matchStage = [{ $match: { _id: { $nin: recentIds } } }];
      }
    }

    const rawQuestions = await sampleMatchQuestions(room, matchStage);
    logger.info(`Fetched ${rawQuestions.length} questions for room ${roomId}`);

    room.questions = rawQuestions.map((question) => {
      const tempId = `${roomId}-${uuidv4()}`;
      const shuffledOptions = shuffleArray([...question.options]);
      const shuffledCorrectAnswer = shuffledOptions.indexOf(
        question.options[question.correctAnswer]
      );
      if (shuffledCorrectAnswer === -1)
        throw new Error("Question shuffle failed");
      const questionData = {
        tempId,
        _id: question._id,
        question: question.question,
        options: question.options,
        correctAnswer: question.correctAnswer,
        shuffledOptions,
        shuffledCorrectAnswer,
      };
      room.questionIdMap.set(tempId, questionData);
      return questionData;
    });

    await updateGameRoom(roomId, room);

    // Verify shuffle data persisted
    const verifyRoom = await getGameRoom(roomId);
    if (!verifyRoom.questions[0]?.shuffledOptions) {
      throw new Error("Redis shuffle data not persisted");
    }

    io.to(roomId).emit("gameStart", {
      players: room.players.map((p) => ({
        username: p.username,
        score: p.score,
        isBot: p.isBot || false,
        difficulty: p.isBot ? p.difficultyLevelString : undefined,
      })),
      questionCount: room.questions.length,
    });
    await startNextQuestion(roomId);
  } catch (error) {
    logger.error("Error starting game:", { error });
    io.to(roomId).emit(
      "gameError",
      "Failed to start the game. Please try again."
    );
  }
}

// ─── Start single-player game (vs bot) ───────────────────────────────────────

async function startSinglePlayerGame(roomId) {
  const io = context.io;
  const redisClient = context.redisClient;
  logger.info("Starting single player game with bot for room:", roomId);
  let room = await getGameRoom(roomId);
  if (!room || room.roomMode !== "bot") return;

  try {
    const humanPlayer = room.players.find((p) => !p.isBot);
    let matchStage = [];
    if (humanPlayer) {
      const user = await User.findOne({ walletAddress: humanPlayer.username });
      if (user?.recentQuestions?.length > 0) {
        const recentIds = user.recentQuestions.map(
          (id) => new mongoose.Types.ObjectId(id)
        );
        matchStage = [{ $match: { _id: { $nin: recentIds } } }];
      }
    }

    const rawQuestions = await sampleMatchQuestions(room, matchStage);
    room.questions = rawQuestions.map((question) => {
      const tempId = `${roomId}-${uuidv4()}`;
      const shuffledOptions = shuffleArray([...question.options]);
      const shuffledCorrectAnswer = shuffledOptions.indexOf(
        question.options[question.correctAnswer]
      );
      if (shuffledCorrectAnswer === -1)
        throw new Error("Question shuffle failed");
      const questionData = {
        tempId,
        _id: question._id,
        question: question.question,
        options: question.options,
        correctAnswer: question.correctAnswer,
        shuffledOptions,
        shuffledCorrectAnswer,
      };
      room.questionIdMap.set(tempId, questionData);
      return questionData;
    });

    const humanPlayers = room.players.filter((p) => !p.isBot);
    if (humanPlayers.length === 0) {
      await deleteGameRoom(roomId);
      await logGameRoomsState();
      return;
    }
    if (humanPlayers.length > 1) {
      room.roomMode = "multiplayer";
      room.gameStarted = true;
      await updateGameRoom(roomId, room);
      io.to(roomId).emit("gameStart", {
        players: room.players,
        questionCount: room.questions.length,
        singlePlayerMode: false,
      });
      await startNextQuestion(roomId);
      return;
    }

    if (room.players.some((p) => p.isBot)) {
      if (!room.gameStarted) {
        room.gameStarted = true;
        await updateGameRoom(roomId, room);
        await startNextQuestion(roomId);
      }
      return;
    }

    const difficultyString = await determineBotDifficulty(
      humanPlayers[0].username
    );
    const botName = chooseBotName();
    const bot = new TriviaBot(botName, difficultyString);

    room.players.push({
      username: bot.username,
      difficultyLevelString: bot.difficultyLevelString,
      isBot: true,
      score: 0,
      totalResponseTime: 0,
      currentQuestionIndex: 0,
      answersGiven: [],
      answered: false,
      lastAnswer: null,
      lastResponseTime: null,
    });
    room.hasBot = true;
    await updateGameRoom(roomId, room);

    const verifyRoom = await getGameRoom(roomId);
    if (!verifyRoom.questions[0]?.shuffledOptions)
      throw new Error("Redis shuffle data not persisted");

    io.to(roomId).emit("botGameReady", {
      botName: bot.username,
      difficulty: bot.difficultyLevelString,
    });
    io.to(roomId).emit("gameStart", {
      players: room.players.map((p) => ({
        username: p.username,
        score: p.score,
        isBot: p.isBot || false,
        difficulty: p.isBot ? p.difficultyLevelString : undefined,
      })),
      questionCount: room.questions.length,
      singlePlayerMode: true,
      botOpponent: bot.username,
    });

    room.gameStarted = true;
    await updateGameRoom(roomId, room);
    await startNextQuestion(roomId);
    await logGameRoomsState();
  } catch (error) {
    logger.error("Error starting single player game with bot:", { error });
    io.to(roomId).emit(
      "gameError",
      "Failed to start the game. Please try again."
    );
    await deleteGameRoom(roomId);
  }
}

// ─── Question round ───────────────────────────────────────────────────────────

// Charge every unanswered human the full time that elapsed on the question. Ties
// break on the LOWER totalResponseTime, so if a timeout didn't add to the total,
// not answering a hard question would beat answering it slowly. Bots are timed
// separately. Mutates `room` in place; returns [{ username, responseTime }] for
// the players that were timed out (for the playerAnswered emit).
function markUnansweredPlayersTimedOut(room, now) {
  const elapsed = now - room.questionStartTime;
  const timedOut = [];
  for (const player of room.players) {
    if (player.isBot || player.answered) continue;
    player.answered = true;
    player.lastAnswer = -1;
    player.lastResponseTime = elapsed;
    player.totalResponseTime = (player.totalResponseTime || 0) + elapsed;
    room.answersReceived++;
    timedOut.push({ username: player.username, responseTime: elapsed });
  }
  return timedOut;
}

async function startNextQuestion(roomId) {
  const io = context.io;
  const redisClient = context.redisClient;
  let room = await getGameRoom(roomId);
  if (!room || room.isDeleted) return;

  if (room.players.filter((p) => !p.isBot).length === 0) {
    room.isDeleted = true;
    await updateGameRoom(roomId, room);
    await redisClient.del(`room:${roomId}`);
    await logGameRoomsState();
    return;
  }

  room = await atomicRoomUpdate(roomId, async (latest) => {
    if (latest.isDeleted) return latest;
    const nextIndex = latest.currentQuestionIndex + 1;
    if (nextIndex >= latest.questions.length) {
      latest._shouldEndGame = true;
      return latest;
    }
    latest.currentQuestionIndex = nextIndex;
    latest.questionStartTime = Date.now();
    latest.answersReceived = 0;
    latest.players.forEach((p) => {
      p.answered = false;
      p.lastAnswer = null;
      p.lastResponseTime = null;
    });
    return latest;
  });

  if (room._shouldEndGame) {
    await handleGameOver(room, roomId);
    return;
  }

  const currentQuestion = room.questions[room.currentQuestionIndex];
  if (
    !currentQuestion?.options ||
    currentQuestion.correctAnswer === undefined
  ) {
    await abortGameWithRefund(roomId, "System Error: Invalid Question Data");
    io.to(roomId).emit(
      "gameError",
      "Game cancelled due to system error. Funds refunded."
    );
    await deleteGameRoom(roomId);
    return;
  }

  const QUESTION_DURATION = 10000;
  const questionEndsAt = room.questionStartTime + QUESTION_DURATION;
  let { shuffledOptions, shuffledCorrectAnswer } = currentQuestion;

  if (!shuffledOptions?.length) {
    const originalQ = room.questions.find(
      (q) => q.tempId === currentQuestion.tempId
    );
    if (originalQ?.shuffledOptions?.length) {
      shuffledOptions = originalQ.shuffledOptions;
      shuffledCorrectAnswer = originalQ.shuffledCorrectAnswer;
    } else {
      await abortGameWithRefund(roomId, "System Error: Lost Shuffle Data");
      io.to(roomId).emit(
        "gameError",
        "Critical system error. Game cancelled and funds refunded."
      );
      await deleteGameRoom(roomId);
      return;
    }
  }

  if (shuffledCorrectAnswer === undefined || shuffledCorrectAnswer === -1) {
    await abortGameWithRefund(
      roomId,
      "System Error: Invalid Answer Configuration"
    );
    io.to(roomId).emit(
      "gameError",
      "Game cancelled due to configuration error. Funds refunded."
    );
    await deleteGameRoom(roomId);
    return;
  }

  io.to(roomId).emit("clearQuestionUI");
  io.to(roomId).emit("nextQuestion", {
    questionId: currentQuestion.tempId,
    question: currentQuestion.question,
    options: shuffledOptions,
    questionNumber: room.currentQuestionIndex + 1,
    totalQuestions: room.questions.length,
    questionEndsAt,
  });

  // [QTIMING] Diagnostic: how much of the 10s window is already gone by the time
  // the question actually reaches players. `questionStartTime` (the client's
  // countdown anchor) is stamped before the Redis write + validation above, so a
  // large emitDelayMs means players see fewer than 10s on their screen. Remove
  // once the question-timer investigation is closed.
  const emitDelayMs = Date.now() - room.questionStartTime;
  logger.info(
    `[QTIMING] room=${roomId} q=${room.currentQuestionIndex} emitted: ` +
      `startTime=${room.questionStartTime} emitDelayMs=${emitDelayMs} ` +
      `clientVisibleMs=${Math.max(0, questionEndsAt - Date.now())}`
  );

  // Question timeout handler
  const timeoutForIndex = room.currentQuestionIndex;
  room.questionTimeout = setTimeout(async () => {
    try {
      const exists = await getGameRoom(roomId);
      if (!exists || exists.isDeleted) {
        logger.info(
          `Timeout fired for already-deleted room ${roomId}, skipping`
        );
        return;
      }

      const updatedRoom = await atomicRoomUpdate(roomId, async (latest) => {
        if (!latest || latest.isDeleted) return latest;
        // Stale timeout from a previous question — the round already completed early
        if (latest.currentQuestionIndex !== timeoutForIndex) {
          latest._staleTimeout = true;
          return latest;
        }
        if (latest.players.filter((p) => !p.isBot).length === 0) {
          latest.isDeleted = true;
          latest._shouldStopGame = true;
          return latest;
        }
        latest._timedOutPlayers = markUnansweredPlayersTimedOut(
          latest,
          Date.now()
        );
        return latest;
      });

      if (updatedRoom._staleTimeout) return;

      if (updatedRoom._shouldStopGame) {
        await deleteGameRoom(roomId);
        await logGameRoomsState();
        return;
      }
      // [QTIMING] Diagnostic: actual elapsed time when the timeout fires. Should
      // be ~10000ms; a value well under 10000 means the round ended early on the
      // server. Remove once the question-timer investigation is closed.
      const elapsedMs = Date.now() - updatedRoom.questionStartTime;
      logger.info(
        `[QTIMING] room=${roomId} q=${timeoutForIndex} TIMEOUT fired: ` +
          `elapsedMs=${elapsedMs} (expected ~10000)`
      );
      const timedOutQuestion = updatedRoom.questions?.[timeoutForIndex];
      updatedRoom._timedOutPlayers?.forEach((p) => {
        io.to(roomId).emit("playerAnswered", {
          username: p.username,
          isBot: false,
          timedOut: true,
          responseTime: p.responseTime,
        });
        // Log the timeout as telemetry — "which questions people fail to answer
        // in time" is a difficulty signal, and cheaters rarely time out.
        telemetry.logAnswer({
          wallet: p.username,
          roomId,
          questionId: timedOutQuestion?._id,
          questionIndex: timeoutForIndex,
          gameMode: updatedRoom.roomMode,
          betAmount: updatedRoom.betAmount,
          responseTimeMs: p.responseTime,
          isCorrect: false,
          timedOut: true,
        });
      });
      await completeQuestion(roomId);
    } catch (error) {
      if (error.message.includes("not found")) {
        logger.info(`Room ${roomId} gone by timeout, ignoring`);
        return;
      }
      logger.error(`Error in timeout handler for room ${roomId}:`, error);
    }
  }, QUESTION_DURATION);

  // Bot answer (async, non-blocking)
  const botData = room.players.find((p) => p.isBot);
  if (botData) {
    (async () => {
      // Capture the question index before the bot's think delay so we can
      // discard the answer if the question has already advanced.
      const questionIndexAtStart = room.currentQuestionIndex;
      const bot = new TriviaBot(
        botData.username,
        botData.difficultyLevelString || "MEDIUM"
      );
      bot.score = botData.score || 0;
      bot.totalResponseTime = botData.totalResponseTime || 0;
      bot.currentQuestionIndex = botData.currentQuestionIndex || 0;
      bot.answersGiven = botData.answersGiven || [];
      try {
        const botAnswer = await bot.answerQuestion(
          currentQuestion.question,
          shuffledOptions,
          shuffledCorrectAnswer
        );
        const botResult = await atomicRoomUpdate(roomId, async (r) => {
          if (!r || r.isDeleted) return r;
          // Discard stale bot answer if question has already moved on
          if (r.currentQuestionIndex !== questionIndexAtStart) {
            r._staleBotAnswer = true;
            return r;
          }
          const botIndex = r.players.findIndex((p) => p.isBot);
          if (botIndex === -1 || r.players[botIndex].answered) return r;
          r.players[botIndex] = {
            ...r.players[botIndex],
            score: bot.score,
            totalResponseTime: bot.totalResponseTime,
            currentQuestionIndex: bot.currentQuestionIndex,
            answersGiven: bot.answersGiven,
            answered: true,
            lastAnswer: botAnswer.answer,
            lastResponseTime: botAnswer.responseTime,
          };
          r.answersReceived++;
          return r;
        }).catch((err) => {
          if (err.message.includes("not found")) return null;
          throw err;
        });
        if (!botResult || botResult.isDeleted || botResult._staleBotAnswer)
          return;
        io.to(roomId).emit("playerAnswered", {
          username: bot.username,
          isBot: true,
          responseTime: botAnswer.responseTime,
          timedOut: false,
        });
        // If the human already answered, the bot completing last should end the round
        const allAnswered = botResult.players.every((p) => p.answered);
        if (
          allAnswered ||
          botResult.answersReceived >= botResult.players.length
        ) {
          await completeQuestion(roomId);
        }
      } catch (error) {
        console.error(`Error processing bot answer in room ${roomId}:`, error);
        io.to(roomId).emit(
          "gameError",
          "Error processing bot response. Game ended."
        );
        await deleteGameRoom(roomId);
      }
    })();
  }
}

// ─── Restart current question after a player reconnects ───────────────────────

async function restartCurrentQuestion(roomId) {
  const io = context.io;

  const room = await atomicRoomUpdate(roomId, async (r) => {
    if (!r.disconnectGracePeriod) {
      r._skipRestart = true;
      return r;
    }
    if (r.questionTimeout) {
      clearTimeout(r.questionTimeout);
      r.questionTimeout = null;
    }
    r.disconnectGracePeriod = false;
    r.questionStartTime = Date.now();
    r.answersReceived = 0;
    r.players.forEach((p) => {
      p.answered = false;
      p.lastAnswer = null;
      p.lastResponseTime = null;
    });
    return r;
  });

  if (!room || room._skipRestart) return;

  // The prior completeQuestion call (which bailed out) may have left a stale
  // lock — release it so the new timeout can call completeQuestion normally.
  const lockKey = `completeQuestion:${roomId}:${room.currentQuestionIndex}`;
  await releaseIdempotencyLock(lockKey);

  const currentQuestion = room.questions[room.currentQuestionIndex];
  if (!currentQuestion?.shuffledOptions) return;

  const QUESTION_DURATION = 10000;
  const questionEndsAt = room.questionStartTime + QUESTION_DURATION;
  const timeoutForIndex = room.currentQuestionIndex;

  io.to(roomId).emit("clearQuestionUI");
  io.to(roomId).emit("nextQuestion", {
    questionId: currentQuestion.tempId,
    question: currentQuestion.question,
    options: currentQuestion.shuffledOptions,
    questionNumber: room.currentQuestionIndex + 1,
    totalQuestions: room.questions.length,
    questionEndsAt,
  });

  room.questionTimeout = setTimeout(async () => {
    try {
      const exists = await getGameRoom(roomId);
      if (!exists || exists.isDeleted) return;

      const updatedRoom = await atomicRoomUpdate(roomId, async (latest) => {
        if (!latest || latest.isDeleted) return latest;
        if (latest.currentQuestionIndex !== timeoutForIndex) {
          latest._staleTimeout = true;
          return latest;
        }
        if (latest.players.filter((p) => !p.isBot).length === 0) {
          latest.isDeleted = true;
          latest._shouldStopGame = true;
          return latest;
        }
        latest._timedOutPlayers = markUnansweredPlayersTimedOut(
          latest,
          Date.now()
        );
        return latest;
      });

      if (updatedRoom._staleTimeout) return;
      if (updatedRoom._shouldStopGame) {
        await deleteGameRoom(roomId);
        await logGameRoomsState();
        return;
      }
      const timedOutQuestion = updatedRoom.questions?.[timeoutForIndex];
      updatedRoom._timedOutPlayers?.forEach((p) => {
        io.to(roomId).emit("playerAnswered", {
          username: p.username,
          isBot: false,
          timedOut: true,
          responseTime: p.responseTime,
        });
        // Log the timeout as telemetry — "which questions people fail to answer
        // in time" is a difficulty signal, and cheaters rarely time out.
        telemetry.logAnswer({
          wallet: p.username,
          roomId,
          questionId: timedOutQuestion?._id,
          questionIndex: timeoutForIndex,
          gameMode: updatedRoom.roomMode,
          betAmount: updatedRoom.betAmount,
          responseTimeMs: p.responseTime,
          isCorrect: false,
          timedOut: true,
        });
      });
      await completeQuestion(roomId);
    } catch (error) {
      if (error.message.includes("not found")) {
        logger.info(`Room ${roomId} gone by restarted timeout, ignoring`);
        return;
      }
      logger.error(
        `Error in restarted timeout handler for room ${roomId}:`,
        error
      );
    }
  }, QUESTION_DURATION);

  await updateGameRoom(roomId, {
    ...room,
    questionTimeout: room.questionTimeout,
  });
}

// ─── Round complete ───────────────────────────────────────────────────────────

async function completeQuestion(roomId) {
  const io = context.io;
  const redisClient = context.redisClient;
  let room = await getGameRoom(roomId);
  if (!room) {
    io.to(roomId).emit("gameError", "Room not found");
    return;
  }
  if (room.isDeleted) {
    if (room.questionTimeout) clearTimeout(room.questionTimeout);
    await redisClient.del(`room:${roomId}`);
    await logGameRoomsState();
    return;
  }

  const lockKey = `completeQuestion:${roomId}:${room.currentQuestionIndex}`;
  const lockAcquired = await acquireIdempotencyLock(lockKey, 30);
  if (!lockAcquired) {
    logger.info(
      `completeQuestion: duplicate call blocked for room ${roomId} question ${room.currentQuestionIndex}`
    );
    return;
  }

  // Re-read the room now that the lock is held so that any score writes
  // (e.g. a bot answer) that landed between the initial read and lock
  // acquisition are visible in the roundComplete / scoreUpdate events.
  room = await getGameRoom(roomId);
  if (!room || room.isDeleted) return;

  // A player disconnected and is in their grace period — game is paused.
  // Release the lock immediately so restartCurrentQuestion can re-acquire it.
  if (room.disconnectGracePeriod) {
    await releaseIdempotencyLock(lockKey);
    return;
  }

  const humanPlayers = room.players.filter((p) => !p.isBot);
  if (humanPlayers.length === 0) {
    if (room.questionTimeout) clearTimeout(room.questionTimeout);
    room.isDeleted = true;
    await updateGameRoom(roomId, room);
    await redisClient.del(`room:${roomId}`);
    await logGameRoomsState();
    return;
  }

  // Derive currentQuestion from the fresh room — not the pre-lock snapshot.
  const currentQuestion = room.questions[room.currentQuestionIndex];
  if (
    !currentQuestion?.shuffledOptions ||
    currentQuestion.shuffledCorrectAnswer === undefined
  ) {
    logger.error(`Invalid question data for room ${roomId}`);
    io.to(roomId).emit("gameError", "Invalid question data");
    room.isDeleted = true;
    await updateGameRoom(roomId, room);
    await redisClient.del(`room:${roomId}`);
    return;
  }

  io.to(roomId).emit("roundComplete", {
    questionId: currentQuestion.tempId,
    playerResults: room.players.map((p) => ({
      username: p.username,
      isCorrect: p.lastAnswer === currentQuestion.shuffledCorrectAnswer,
      answer: p.lastAnswer ?? -1,
      responseTime: p.lastResponseTime || 0,
      isBot: p.isBot || false,
    })),
    correctAnswerText:
      currentQuestion.shuffledOptions[currentQuestion.shuffledCorrectAnswer],
  });

  io.to(roomId).emit(
    "scoreUpdate",
    room.players.map((p) => ({
      username: p.username,
      score: p.score || 0,
      totalResponseTime: p.totalResponseTime || 0,
      isBot: p.isBot || false,
      difficulty: p.isBot ? p.difficultyLevelString : undefined,
    }))
  );

  room.questionStartTime = null;
  room.roundStartTime = null;
  await updateGameRoom(roomId, room);

  if (room.playerLeft) {
    await handleGameOver(room, roomId);
    return;
  }

  if (room.currentQuestionIndex + 1 < room.questions.length) {
    setTimeout(() => startNextQuestion(roomId), 3000);
  } else {
    await handleGameOver(room, roomId);
  }
}

// ─── Sudden-death tie-break ───────────────────────────────────────────────────

// Build one extra question for a sudden-death round (same shape as startGame),
// excluding every question already used in this match and, best-effort, the
// player's recent history. Returns null if none can be sampled.
async function buildSuddenDeathQuestion(room, roomId) {
  const usedIds = room.questions
    .map((q) => q._id)
    .filter(Boolean)
    .map((id) => new mongoose.Types.ObjectId(id));

  let recentIds = [];
  const humanPlayer = room.players.find((p) => !p.isBot);
  if (humanPlayer) {
    const user = await User.findOne({ walletAddress: humanPlayer.username });
    if (user?.recentQuestions?.length > 0) {
      recentIds = user.recentQuestions.map(
        (id) => new mongoose.Types.ObjectId(id)
      );
    }
  }

  let sampled = await questionBankForRoom(room).aggregate([
    { $match: { _id: { $nin: [...usedIds, ...recentIds] } } },
    { $sample: { size: 1 } },
  ]);
  // If recent-history exclusion emptied the pool, retry excluding only the
  // questions already used in THIS match — never repeat a question in one game.
  if (!sampled[0]) {
    sampled = await questionBankForRoom(room).aggregate([
      { $match: { _id: { $nin: usedIds } } },
      { $sample: { size: 1 } },
    ]);
  }
  const question = sampled[0];
  if (!question) return null;

  const shuffledOptions = shuffleArray([...question.options]);
  const shuffledCorrectAnswer = shuffledOptions.indexOf(
    question.options[question.correctAnswer]
  );
  if (shuffledCorrectAnswer === -1) return null;

  return {
    tempId: `${roomId}-${uuidv4()}`,
    _id: question._id,
    question: question.question,
    options: question.options,
    correctAnswer: question.correctAnswer,
    shuffledOptions,
    shuffledCorrectAnswer,
  };
}

// If TIEBREAK_MODE is "sudden_death" and the match is a genuine tie, append a
// tie-break question and resume the normal round loop instead of settling now.
// Returns true when it did so (caller must return without settling). Falls back
// (returns false → normal response-time tie-break) for bot games, non-ties,
// abandoned games, when the round cap is hit, or if no question can be sampled —
// guaranteeing the match always terminates.
async function maybeEnterSuddenDeath(room, roomId, gameOverLock) {
  if (TIEBREAK_MODE !== TIEBREAK_MODES.SUDDEN_DEATH) return false;
  if (room.playerLeft) return false; // someone walked — leaver forfeits, settle
  if (room.players.some((p) => p.isBot)) return false; // bot games unchanged
  if (room.players.filter((p) => !p.isBot).length < 2) return false;

  const maxScore = Math.max(...room.players.map((p) => p.score || 0));
  const leaders = room.players.filter((p) => (p.score || 0) === maxScore);
  if (leaders.length < 2) return false; // clear winner, no tie

  if ((room.suddenDeathRounds || 0) >= SUDDEN_DEATH_MAX_ROUNDS) {
    logger.info(
      `[SUDDEN-DEATH] room ${roomId} still tied after ${
        room.suddenDeathRounds || 0
      } round(s) — falling back to response-time tie-break`
    );
    return false;
  }

  const newQuestion = await buildSuddenDeathQuestion(room, roomId);
  if (!newQuestion) {
    logger.warn(
      `[SUDDEN-DEATH] room ${roomId}: no tie-break question available — falling back to response-time tie-break`
    );
    return false;
  }

  const updated = await atomicRoomUpdate(roomId, async (latest) => {
    if (!latest || latest.isDeleted || latest.playerLeft) {
      latest._suddenDeathAborted = true;
      return latest;
    }
    latest.questions.push(newQuestion);
    latest.questionIdMap.set(newQuestion.tempId, newQuestion);
    latest.suddenDeathRounds = (latest.suddenDeathRounds || 0) + 1;
    return latest;
  }).catch((err) => {
    logger.error(
      `[SUDDEN-DEATH] failed to append tie-break question for room ${roomId}:`,
      err
    );
    return null;
  });

  if (!updated || updated._suddenDeathAborted) return false;

  // Release the game-over lock so the NEXT handleGameOver (after this tie-break
  // question resolves) can acquire it and settle.
  await releaseIdempotencyLock(gameOverLock);

  context.io.to(roomId).emit("suddenDeath", {
    round: updated.suddenDeathRounds,
    message: "Tie! Sudden-death question — pull ahead to win.",
  });
  logger.info(
    `[SUDDEN-DEATH] room ${roomId}: entering round ${updated.suddenDeathRounds} (tie at score ${maxScore})`
  );

  await startNextQuestion(roomId);
  return true;
}

// ─── Game over ────────────────────────────────────────────────────────────────

async function handleGameOver(room, roomId) {
  const io = context.io;

  const gameOverLock = `gameOver:${roomId}`;
  const lockAcquired = await acquireIdempotencyLock(gameOverLock, 60);
  if (!lockAcquired) {
    logger.info(`handleGameOver: duplicate call blocked for room ${roomId}`);
    return;
  }

  // Opt-in sudden-death tie-break. If entered, we've appended a question and
  // resumed the round loop — do not settle now.
  if (await maybeEnterSuddenDeath(room, roomId, gameOverLock)) return;

  const sortedPlayers = [...room.players].sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : (a.totalResponseTime || 0) - (b.totalResponseTime || 0)
  );

  const botOpponent = room.players.some((p) => p.isBot);
  const isSinglePlayerEncounter =
    room.roomMode === "bot" || (sortedPlayers.length === 1 && !botOpponent);
  let winner = null;

  if (botOpponent) {
    const human = room.players.find((p) => !p.isBot);
    const bot = room.players.find((p) => p.isBot);
    if (human && bot) {
      winner =
        human.score > bot.score
          ? human.username
          : bot.score > human.score
          ? bot.username
          : (human.totalResponseTime || 0) <= (bot.totalResponseTime || 0)
          ? human.username
          : bot.username;
    } else {
      winner = (bot || human)?.username ?? null;
    }
  } else if (sortedPlayers.length >= 1) {
    winner = sortedPlayers[0].username;
  }

  try {
    // Tournament stats are updated inside processClaimedMatchResult after match validation
    if (room.gameMode !== GAME_MODES.TOURNAMENT) {
      await updatePlayerStats(
        room.players.map((p) => ({
          username: p.username,
          score: p.score || 0,
          totalResponseTime: p.totalResponseTime || 0,
          isBot: p.isBot || false,
        })),
        {
          winner,
          botOpponent,
          betAmount: room.betAmount,
          gameMode: room.gameMode,
        }
      );
    }

    // Update recent questions
    for (const player of room.players.filter((p) => !p.isBot)) {
      const user = await User.findOne({ walletAddress: player.username });
      if (user) {
        const usedIds = room.questions.map((q) => q._id.toString());
        user.recentQuestions = [
          ...new Set([...(user.recentQuestions || []), ...usedIds]),
        ].slice(-20);
        await user.save();
      }
    }

    const gameMode = room.gameMode || "practice";
    const basePayload = {
      players: sortedPlayers.map((p) => ({
        username: p.username,
        score: p.score,
        totalResponseTime: p.totalResponseTime || 0,
        isBot: p.isBot || false,
      })),
      winner,
      singlePlayerMode: isSinglePlayerEncounter,
      botOpponent,
    };

    if (gameMode === GAME_MODES.PRACTICE) {
      for (const p of room.players.filter((pl) => !pl.isBot)) {
        await User.findOneAndUpdate(
          { walletAddress: p.username },
          { $inc: { practiceGamesPlayed: 1 } }
        );
      }
      io.to(roomId).emit("gameOver", {
        ...basePayload,
        mode: "practice",
        message: "Upgrade to Premium to play tournaments with real prizes!",
      });
    } else if (gameMode === GAME_MODES.TOURNAMENT) {
      const ts = context.tournamentService;
      if (ts && room.tournamentId && room.matchId) {
        const tournamentLockKey = `tournamentGameOver:${room.matchId}`;
        const lockAcquired = await acquireIdempotencyLock(
          tournamentLockKey,
          60
        );
        if (!lockAcquired) {
          logger.info(
            `Tournament game over: duplicate processing blocked for match ${room.matchId}`
          );
        } else {
          let winnerUserId = null,
            loserUserId = null,
            winnerScore = 0,
            loserScore = 0;
          for (const player of room.players.filter((p) => !p.isBot)) {
            const user = await User.findOne({ walletAddress: player.username });
            if (user) {
              if (player.username === winner) {
                winnerUserId = user._id;
                winnerScore = player.score || 0;
              } else {
                loserUserId = user._id;
                loserScore = player.score || 0;
              }
            }
          }
          if (winnerUserId && loserUserId) {
            try {
              const { action, claimed } = await ts.processClaimedMatchResult(
                room.tournamentId,
                room.matchId,
                roomId,
                winnerUserId,
                loserUserId,
                winnerScore,
                loserScore
              );
              if (claimed) {
                await updatePlayerStats(
                  room.players.map((p) => ({
                    username: p.username,
                    score: p.score || 0,
                    totalResponseTime: p.totalResponseTime || 0,
                    isBot: p.isBot || false,
                  })),
                  {
                    winner,
                    botOpponent,
                    betAmount: room.betAmount,
                    gameMode: room.gameMode,
                  }
                );
                if (action === "round_advanced")
                  io.emit("tournamentRoundAdvanced", {
                    tournamentId: room.tournamentId,
                  });
                if (action === "tournament_complete")
                  io.emit("tournamentComplete", {
                    tournamentId: room.tournamentId,
                  });
              } else {
                logger.warn(
                  `[handleGameOver] Match ${room.matchId} not claimed for room ${roomId} — skipping stats`
                );
              }
            } catch (e) {
              logger.error("Failed to process tournament match result:", e);
            }
          }
        }
      }
      io.to(roomId).emit("gameOver", {
        ...basePayload,
        mode: "tournament",
        tournamentId: room.tournamentId,
        message: "Tournament match complete!",
      });
    } else if (isPotMode()) {
      const { paymentId, withheld, withheldReason } = await settlePotGame(
        roomId,
        room,
        winner,
        botOpponent
      );

      let message;
      if (withheldReason === "fraud") {
        message =
          "Victory under review. Account flagged for suspicious activity.";
      } else if (withheld) {
        message =
          "Your win is confirmed but the payout could not be queued. Support has been alerted — please contact us with this game ID.";
      } else if (paymentId) {
        message = `Payout queued! Check status with ID: ${paymentId}`;
      } else {
        message = "No payout required";
      }

      io.to(roomId).emit("gameOver", {
        ...basePayload,
        gameMode,
        betAmount: room.betAmount,
        paymentId,
        payoutWithheld: withheld,
        message,
      });
    } else {
      io.to(roomId).emit("gameOver", {
        ...basePayload,
        gameMode,
        betAmount: room.betAmount,
        message: "Game complete",
      });
    }

    await GameSession.findOneAndUpdate(
      { roomId },
      { status: "completed", endTime: new Date() }
    );
    await deleteGameRoom(roomId);
    await logGameRoomsState();
  } catch (error) {
    logger.error("Error handling game over:", { error });
    io.to(roomId).emit("gameError", "An error occurred while ending the game.");
    try {
      await GameSession.findOneAndUpdate(
        { roomId },
        { status: "error", endTime: new Date(), refundReason: error.message }
      );
    } catch {}
    await deleteGameRoom(roomId);
  }
}

module.exports = {
  startGame,
  startSinglePlayerGame,
  startNextQuestion,
  markUnansweredPlayersTimedOut,
  completeQuestion,
  handleGameOver,
  abortGameWithRefund,
  restartCurrentQuestion,
  settlePotGame,
};
