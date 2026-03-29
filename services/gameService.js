/**
 * services/gameService.js
 * Core game-flow orchestration: question rounds, bot turns, game-over logic.
 */

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const context = require('../context');
const User = require('../models/User');
const GameSession = require('../models/GameSession');
const { shuffleArray } = require('../utils/helpers');
const { GAME_MODES } = require('../config/constants');
const {
    getGameRoom, updateGameRoom, deleteGameRoom, atomicRoomUpdate, logGameRoomsState,
} = require('./roomManager');
const { TriviaBot, chooseBotName, determineBotDifficulty } = require('./botService');
const { updatePlayerStats, refundToVirtualBalance } = require('./playerService');
const { acquireIdempotencyLock } = require('../utils/idempotency');

// Quiz model is expected to be in models/Quiz — adjust path if different
const Quiz = require('../models/Quiz');

// ─── Abort with refund ────────────────────────────────────────────────────────

async function abortGameWithRefund(roomId, reason) {
    try {
        const room = await getGameRoom(roomId);
        if (!room) return;

        for (const player of room.players.filter(p => !p.isBot)) {
            await refundToVirtualBalance(player.username, room.betAmount, reason);
        }

        await GameSession.findOneAndUpdate(
            { roomId },
            { status: 'refunded', endTime: new Date(), refundReason: reason }
        );
        logger.info(`💰 Refunded and aborted room ${roomId} due to: ${reason}`);
    } catch (err) {
        logger.error(`Failed to process abort refund for room ${roomId}:`, err);
    }
}

// ─── Start game (human vs human) ─────────────────────────────────────────────

async function startGame(roomId) {
    const io = context.io;
    logger.info(`Attempting to start game in room ${roomId}`);
    let room = await getGameRoom(roomId);
    if (!room || room.gameStarted) {
        if (room?.gameStarted) logger.info(`Game already started in room ${roomId}, skipping`);
        return;
    }

    room.players.forEach(p => (p.score = 0));
    await updateGameRoom(roomId, room);

    try {
        const humanPlayer = room.players.find(p => !p.isBot);
        let matchStage = [];
        if (humanPlayer) {
            const user = await User.findOne({ walletAddress: humanPlayer.username });
            if (user?.recentQuestions?.length > 0) {
                const recentIds = user.recentQuestions.map(id => new mongoose.Types.ObjectId(id));
                matchStage = [{ $match: { _id: { $nin: recentIds } } }];
            }
        }

        const rawQuestions = await Quiz.aggregate([...matchStage, { $sample: { size: 7 } }]);
        logger.info(`Fetched ${rawQuestions.length} questions for room ${roomId}`);

        room.questions = rawQuestions.map((question) => {
            const tempId = `${roomId}-${uuidv4()}`;
            const shuffledOptions = shuffleArray([...question.options]);
            const shuffledCorrectAnswer = shuffledOptions.indexOf(question.options[question.correctAnswer]);
            if (shuffledCorrectAnswer === -1) throw new Error('Question shuffle failed');
            const questionData = {
                tempId, _id: question._id,
                question: question.question, options: question.options,
                correctAnswer: question.correctAnswer,
                shuffledOptions, shuffledCorrectAnswer,
            };
            room.questionIdMap.set(tempId, questionData);
            return questionData;
        });

        await updateGameRoom(roomId, room);

        // Verify shuffle data persisted
        const verifyRoom = await getGameRoom(roomId);
        if (!verifyRoom.questions[0]?.shuffledOptions) {
            throw new Error('Redis shuffle data not persisted');
        }

        io.to(roomId).emit('gameStart', {
            players: room.players.map(p => ({
                username: p.username, score: p.score, isBot: p.isBot || false,
                difficulty: p.isBot ? p.difficultyLevelString : undefined,
            })),
            questionCount: room.questions.length,
        });
        await startNextQuestion(roomId);
    } catch (error) {
        logger.error('Error starting game:', { error });
        io.to(roomId).emit('gameError', 'Failed to start the game. Please try again.');
    }
}

// ─── Start single-player game (vs bot) ───────────────────────────────────────

async function startSinglePlayerGame(roomId) {
    const io = context.io;
    const redisClient = context.redisClient;
    logger.info('Starting single player game with bot for room:', roomId);
    let room = await getGameRoom(roomId);
    if (!room || room.roomMode !== 'bot') return;

    try {
        const humanPlayer = room.players.find(p => !p.isBot);
        let matchStage = [];
        if (humanPlayer) {
            const user = await User.findOne({ walletAddress: humanPlayer.username });
            if (user?.recentQuestions?.length > 0) {
                const recentIds = user.recentQuestions.map(id => new mongoose.Types.ObjectId(id));
                matchStage = [{ $match: { _id: { $nin: recentIds } } }];
            }
        }

        const rawQuestions = await Quiz.aggregate([...matchStage, { $sample: { size: 7 } }]);
        room.questions = rawQuestions.map((question) => {
            const tempId = `${roomId}-${uuidv4()}`;
            const shuffledOptions = shuffleArray([...question.options]);
            const shuffledCorrectAnswer = shuffledOptions.indexOf(question.options[question.correctAnswer]);
            if (shuffledCorrectAnswer === -1) throw new Error('Question shuffle failed');
            const questionData = {
                tempId, _id: question._id,
                question: question.question, options: question.options,
                correctAnswer: question.correctAnswer,
                shuffledOptions, shuffledCorrectAnswer,
            };
            room.questionIdMap.set(tempId, questionData);
            return questionData;
        });

        const humanPlayers = room.players.filter(p => !p.isBot);
        if (humanPlayers.length === 0) {
            await deleteGameRoom(roomId); await logGameRoomsState(); return;
        }
        if (humanPlayers.length > 1) {
            room.roomMode = 'multiplayer'; room.gameStarted = true;
            await updateGameRoom(roomId, room);
            io.to(roomId).emit('gameStart', { players: room.players, questionCount: room.questions.length, singlePlayerMode: false });
            await startNextQuestion(roomId); return;
        }

        if (room.players.some(p => p.isBot)) {
            if (!room.gameStarted) {
                room.gameStarted = true; await updateGameRoom(roomId, room); await startNextQuestion(roomId);
            }
            return;
        }

        const difficultyString = await determineBotDifficulty(humanPlayers[0].username);
        const botName = chooseBotName();
        const bot     = new TriviaBot(botName, difficultyString);

        room.players.push({
            username: bot.username, difficultyLevelString: bot.difficultyLevelString,
            isBot: true, score: 0, totalResponseTime: 0, currentQuestionIndex: 0,
            answersGiven: [], answered: false, lastAnswer: null, lastResponseTime: null,
        });
        room.hasBot = true;
        await updateGameRoom(roomId, room);

        const verifyRoom = await getGameRoom(roomId);
        if (!verifyRoom.questions[0]?.shuffledOptions) throw new Error('Redis shuffle data not persisted');

        io.to(roomId).emit('botGameReady', { botName: bot.username, difficulty: bot.difficultyLevelString });
        io.to(roomId).emit('gameStart', {
            players: room.players.map(p => ({
                username: p.username, score: p.score, isBot: p.isBot || false,
                difficulty: p.isBot ? p.difficultyLevelString : undefined,
            })),
            questionCount: room.questions.length,
            singlePlayerMode: true, botOpponent: bot.username,
        });

        room.gameStarted = true;
        await updateGameRoom(roomId, room);
        await startNextQuestion(roomId);
        await logGameRoomsState();
    } catch (error) {
        logger.error('Error starting single player game with bot:', { error });
        io.to(roomId).emit('gameError', 'Failed to start the game. Please try again.');
        await deleteGameRoom(roomId);
    }
}

// ─── Question round ───────────────────────────────────────────────────────────

async function startNextQuestion(roomId) {
    const io = context.io;
    const redisClient = context.redisClient;
    let room = await getGameRoom(roomId);
    if (!room || room.isDeleted) return;

    if (room.players.filter(p => !p.isBot).length === 0) {
        room.isDeleted = true;
        await updateGameRoom(roomId, room);
        await redisClient.del(`room:${roomId}`);
        await logGameRoomsState();
        return;
    }

    room = await atomicRoomUpdate(roomId, async (latest) => {
        if (latest.isDeleted) return latest;
        const nextIndex = latest.currentQuestionIndex + 1;
        if (nextIndex >= latest.questions.length) { latest._shouldEndGame = true; return latest; }
        latest.currentQuestionIndex = nextIndex;
        latest.questionStartTime    = Date.now();
        latest.answersReceived      = 0;
        latest.players.forEach(p => { p.answered = false; p.lastAnswer = null; p.lastResponseTime = null; });
        return latest;
    });

    if (room._shouldEndGame) { await handleGameOver(room, roomId); return; }

    const currentQuestion = room.questions[room.currentQuestionIndex];
    if (!currentQuestion?.options || currentQuestion.correctAnswer === undefined) {
        await abortGameWithRefund(roomId, 'System Error: Invalid Question Data');
        io.to(roomId).emit('gameError', 'Game cancelled due to system error. Funds refunded.');
        await deleteGameRoom(roomId); return;
    }

    const QUESTION_DURATION = 10000;
    const questionEndsAt    = room.questionStartTime + QUESTION_DURATION;
    let { shuffledOptions, shuffledCorrectAnswer } = currentQuestion;

    if (!shuffledOptions?.length) {
        const originalQ = room.questions.find(q => q.tempId === currentQuestion.tempId);
        if (originalQ?.shuffledOptions?.length) {
            shuffledOptions = originalQ.shuffledOptions;
            shuffledCorrectAnswer = originalQ.shuffledCorrectAnswer;
        } else {
            await abortGameWithRefund(roomId, 'System Error: Lost Shuffle Data');
            io.to(roomId).emit('gameError', 'Critical system error. Game cancelled and funds refunded.');
            await deleteGameRoom(roomId); return;
        }
    }

    if (shuffledCorrectAnswer === undefined || shuffledCorrectAnswer === -1) {
        await abortGameWithRefund(roomId, 'System Error: Invalid Answer Configuration');
        io.to(roomId).emit('gameError', 'Game cancelled due to configuration error. Funds refunded.');
        await deleteGameRoom(roomId); return;
    }

    io.to(roomId).emit('clearQuestionUI');
    io.to(roomId).emit('nextQuestion', {
        questionId:     currentQuestion.tempId,
        question:       currentQuestion.question,
        options:        shuffledOptions,
        questionNumber: room.currentQuestionIndex + 1,
        totalQuestions: room.questions.length,
        questionEndsAt,
    });

    // Question timeout handler
    const timeoutForIndex = room.currentQuestionIndex;
    room.questionTimeout = setTimeout(async () => {
        try {
            const exists = await getGameRoom(roomId);
            if (!exists || exists.isDeleted) {
                logger.info(`Timeout fired for already-deleted room ${roomId}, skipping`);
                return;
            }

            const updatedRoom = await atomicRoomUpdate(roomId, async (latest) => {
                if (!latest || latest.isDeleted) return latest;
                // Stale timeout from a previous question — the round already completed early
                if (latest.currentQuestionIndex !== timeoutForIndex) {
                    latest._staleTimeout = true; return latest;
                }
                if (latest.players.filter(p => !p.isBot).length === 0) {
                    latest.isDeleted = true; latest._shouldStopGame = true; return latest;
                }
                latest._timedOutPlayers = [];
                latest.players.forEach(player => {
                    if (!player.answered && !player.isBot) {
                        player.answered = true; player.lastAnswer = -1;
                        player.lastResponseTime = Date.now() - latest.questionStartTime;
                        latest.answersReceived++;
                        latest._timedOutPlayers.push({ username: player.username, responseTime: player.lastResponseTime });
                    }
                });
                return latest;
            });

            if (updatedRoom._staleTimeout) return;

            if (updatedRoom._shouldStopGame) {
                await deleteGameRoom(roomId); await logGameRoomsState(); return;
            }
            updatedRoom._timedOutPlayers?.forEach(p => {
                io.to(roomId).emit('playerAnswered', { username: p.username, isBot: false, timedOut: true, responseTime: p.responseTime });
            });
            await completeQuestion(roomId);
        } catch (error) {
            if (error.message.includes('not found')) {
                logger.info(`Room ${roomId} gone by timeout, ignoring`);
                return;
            }
            logger.error(`Error in timeout handler for room ${roomId}:`, error);
        }
    }, QUESTION_DURATION);

    // Bot answer (async, non-blocking)
    const botData = room.players.find(p => p.isBot);
    if (botData) {
        (async () => {
            const bot = new TriviaBot(botData.username, botData.difficultyLevelString || 'MEDIUM');
            bot.score = botData.score || 0;
            bot.totalResponseTime   = botData.totalResponseTime   || 0;
            bot.currentQuestionIndex = botData.currentQuestionIndex || 0;
            bot.answersGiven = botData.answersGiven || [];
            try {
                const botAnswer = await bot.answerQuestion(currentQuestion.question, shuffledOptions, shuffledCorrectAnswer);
                const freshRoom = await getGameRoom(roomId);
                if (!freshRoom || freshRoom.isDeleted) return;
                const botIndex = freshRoom.players.findIndex(p => p.isBot);
                if (botIndex !== -1) {
                    freshRoom.players[botIndex] = {
                        ...freshRoom.players[botIndex], score: bot.score,
                        totalResponseTime: bot.totalResponseTime, currentQuestionIndex: bot.currentQuestionIndex,
                        answersGiven: bot.answersGiven, answered: true,
                        lastAnswer: botAnswer.answer, lastResponseTime: botAnswer.responseTime,
                    };
                    freshRoom.answersReceived++;
                    await updateGameRoom(roomId, freshRoom);
                }
                io.to(roomId).emit('playerAnswered', { username: bot.username, isBot: true, responseTime: botAnswer.responseTime, timedOut: false });
            } catch (error) {
                console.error(`Error processing bot answer in room ${roomId}:`, error);
                io.to(roomId).emit('gameError', 'Error processing bot response. Game ended.');
                await deleteGameRoom(roomId);
            }
        })();
    }
}

// ─── Round complete ───────────────────────────────────────────────────────────

async function completeQuestion(roomId) {
    const io = context.io;
    const redisClient = context.redisClient;
    let room = await getGameRoom(roomId);
    if (!room) { io.to(roomId).emit('gameError', 'Room not found'); return; }
    if (room.isDeleted) {
        if (room.questionTimeout) clearTimeout(room.questionTimeout);
        await redisClient.del(`room:${roomId}`);
        await logGameRoomsState(); return;
    }

    const lockKey = `completeQuestion:${roomId}:${room.currentQuestionIndex}`;
    const lockAcquired = await acquireIdempotencyLock(lockKey, 30);
    if (!lockAcquired) {
        logger.info(`completeQuestion: duplicate call blocked for room ${roomId} question ${room.currentQuestionIndex}`);
        return;
    }

    const humanPlayers = room.players.filter(p => !p.isBot);
    if (humanPlayers.length === 0) {
        if (room.questionTimeout) clearTimeout(room.questionTimeout);
        room.isDeleted = true;
        await updateGameRoom(roomId, room);
        await redisClient.del(`room:${roomId}`);
        await logGameRoomsState(); return;
    }

    const currentQuestion = room.questions[room.currentQuestionIndex];
    if (!currentQuestion?.shuffledOptions || currentQuestion.shuffledCorrectAnswer === undefined) {
        logger.error(`Invalid question data for room ${roomId}`);
        io.to(roomId).emit('gameError', 'Invalid question data');
        room.isDeleted = true;
        await updateGameRoom(roomId, room);
        await redisClient.del(`room:${roomId}`); return;
    }

    io.to(roomId).emit('roundComplete', {
        questionId:       currentQuestion.tempId,
        playerResults:    room.players.map(p => ({
            username:     p.username,
            isCorrect:    p.lastAnswer === currentQuestion.shuffledCorrectAnswer,
            answer:       p.lastAnswer ?? -1,
            responseTime: p.lastResponseTime || 0,
            isBot:        p.isBot || false,
        })),
        correctAnswerText: currentQuestion.shuffledOptions[currentQuestion.shuffledCorrectAnswer],
    });

    io.to(roomId).emit('scoreUpdate', room.players.map(p => ({
        username: p.username, score: p.score || 0,
        totalResponseTime: p.totalResponseTime || 0, isBot: p.isBot || false,
        difficulty: p.isBot ? p.difficultyLevelString : undefined,
    })));

    room.questionStartTime = null; room.roundStartTime = null;
    await updateGameRoom(roomId, room);

    if (room.playerLeft) { await handleGameOver(room, roomId); return; }

    if (room.currentQuestionIndex + 1 < room.questions.length) {
        setTimeout(() => startNextQuestion(roomId), 3000);
    } else {
        await handleGameOver(room, roomId);
    }
}

// ─── Game over ────────────────────────────────────────────────────────────────

async function handleGameOver(room, roomId) {
    const io = context.io;
    const sortedPlayers = [...room.players].sort((a, b) =>
        b.score !== a.score ? b.score - a.score : (a.totalResponseTime || 0) - (b.totalResponseTime || 0)
    );

    const botOpponent = room.players.some(p => p.isBot);
    const isSinglePlayerEncounter = room.roomMode === 'bot' || (sortedPlayers.length === 1 && !botOpponent);
    let winner = null;

    if (botOpponent) {
        const human = room.players.find(p => !p.isBot);
        const bot   = room.players.find(p => p.isBot);
        if (human && bot) {
            winner = human.score > bot.score ? human.username
                : bot.score > human.score   ? bot.username
                : (human.totalResponseTime || 0) <= (bot.totalResponseTime || 0) ? human.username : bot.username;
        } else {
            winner = (bot || human)?.username ?? null;
        }
    } else if (sortedPlayers.length >= 1) {
        winner = sortedPlayers[0].username;
    }

    try {
        await updatePlayerStats(room.players.map(p => ({
            username: p.username, score: p.score || 0,
            totalResponseTime: p.totalResponseTime || 0, isBot: p.isBot || false,
        })), { winner, botOpponent, betAmount: room.betAmount, gameMode: room.gameMode });

        // Update recent questions
        for (const player of room.players.filter(p => !p.isBot)) {
            const user = await User.findOne({ walletAddress: player.username });
            if (user) {
                const usedIds = room.questions.map(q => q._id.toString());
                user.recentQuestions = [...new Set([...(user.recentQuestions || []), ...usedIds])].slice(-20);
                await user.save();
            }
        }

        const gameMode = room.gameMode || 'practice';
        const basePayload = {
            players: sortedPlayers.map(p => ({
                username: p.username, score: p.score,
                totalResponseTime: p.totalResponseTime || 0, isBot: p.isBot || false,
            })),
            winner, singlePlayerMode: isSinglePlayerEncounter, botOpponent,
        };

        if (gameMode === GAME_MODES.PRACTICE) {
            for (const p of room.players.filter(pl => !pl.isBot)) {
                await User.findOneAndUpdate({ walletAddress: p.username }, { $inc: { practiceGamesPlayed: 1 } });
            }
            io.to(roomId).emit('gameOver', { ...basePayload, mode: 'practice', message: 'Upgrade to Premium to play tournaments with real prizes!' });

        } else if (gameMode === GAME_MODES.TOURNAMENT) {
            const ts = context.tournamentService;
            if (ts && room.tournamentId) {
                let winnerUserId = null, loserUserId = null;
                for (const player of room.players.filter(p => !p.isBot)) {
                    const user = await User.findOne({ walletAddress: player.username });
                    if (user) {
                        const result = player.username === winner ? 'win' : 'loss';
                        try {
                            await ts.updatePlayerScore(room.tournamentId, user._id, player.score || 0, result);
                            if (result === 'win')  winnerUserId = user._id;
                            if (result === 'loss') loserUserId  = user._id;
                        } catch (e) { logger.error(`Failed to update tournament score for ${player.username}:`, e); }
                    }
                }
                if (winnerUserId && loserUserId) {
                    try {
                        const { action } = await ts.processMatchResult(room.tournamentId, winnerUserId, loserUserId);
                        if (action === 'round_advanced')     io.emit('tournamentRoundAdvanced', { tournamentId: room.tournamentId });
                        if (action === 'tournament_complete') io.emit('tournamentComplete',      { tournamentId: room.tournamentId });
                    } catch (e) { logger.error('Failed to advance tournament round:', e); }
                }
            }
            io.to(roomId).emit('gameOver', { ...basePayload, mode: 'tournament', tournamentId: room.tournamentId, message: 'Tournament match complete!' });

        } else {
            io.to(roomId).emit('gameOver', { ...basePayload, betAmount: room.betAmount, message: 'Game complete' });
        }

        await GameSession.findOneAndUpdate({ roomId }, { status: 'completed', endTime: new Date() });
        await deleteGameRoom(roomId);
        await logGameRoomsState();
    } catch (error) {
        logger.error('Error handling game over:', { error });
        io.to(roomId).emit('gameError', 'An error occurred while ending the game.');
        try {
            await GameSession.findOneAndUpdate({ roomId }, { status: 'error', endTime: new Date(), refundReason: error.message });
        } catch {}
        await deleteGameRoom(roomId);
    }
}

module.exports = { startGame, startSinglePlayerGame, startNextQuestion, completeQuestion, handleGameOver, abortGameWithRefund };