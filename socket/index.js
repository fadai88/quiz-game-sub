/**
 * socket/index.js
 * Registers the Socket.IO authentication middleware and all event handlers.
 *
 * Call registerSocketHandlers(io) once after io is created.
 * The io instance and redisClient are resolved via context.js.
 */

const cookie          = require('cookie');
const cookieSignature = require('cookie-signature');
const { PublicKey }   = require('@solana/web3.js');
const nacl            = require('tweetnacl');
const logger          = require('../logger');
const context         = require('../context');
const BotDetector     = require('../botDetector');
const User            = require('../models/User');
const GameSession     = require('../models/GameSession');
const { issueChallenge, consumeChallenge } = require('../utils/challengeStore');
const { getClientIpFromSocket } = require('../middleware/trustedProxy');

const redisService = require('../services/redisService');
const { SecurityLogger } = require('../utils/securityLogger');
const { verifyRecaptcha }              = require('../utils/helpers');
const { orphanedPlayerMetrics }        = require('../utils/idempotency');
const { alertManager, trackValidationFailure, trackRateLimitViolation, trackFailedTransaction, trackFailedLogin } = require('../config/alerts');

const {
    transactionSchema, submitAnswerSchema, playerReadySchema,
    switchToBotSchema, requestBotRoomSchema, requestBotGameSchema,
    leaveRoomSchema, matchFoundSchema, joinPracticeGameSchema, joinHumanMatchmakingSchema, joinTournamentGameSchema,
} = require('../config/schemas');

const {
    createGameRoom, getGameRoom, updateGameRoom, deleteGameRoom,
    atomicRoomUpdate, addToMatchmakingPool, removeFromMatchmakingPool,
    getMatchmakingPool, addWaitingRoom, getWaitingRoom, removeWaitingRoom,
    logGameRoomsState, logMatchmakingState,
} = require('../services/roomManager');

const { startGame, startSinglePlayerGame, completeQuestion, restartCurrentQuestion } = require('../services/gameService');
const { updatePlayerStats, findPlayerActiveRoom, handlePlayerLeftWin } = require('../services/playerService');
const { verifyAndValidateTransaction } = require('../services/transactionVerifier');
const { rateLimitEvent, rateLimitFailedRecaptcha, isBlocked: isBlockedFn } = require('../services/rateLimitService');

const SESSION_SECRET = process.env.SESSION_SECRET;

const botDetector = new BotDetector();

// Grace-period timers: walletAddress → NodeJS.Timeout
// Cancelled when the player reconnects within DISCONNECT_GRACE_MS.
const disconnectTimers = new Map();
const DISCONNECT_GRACE_MS = 12_000;

// ─── Socket.IO auth middleware ────────────────────────────────────────────────

function registerSocketAuthMiddleware(io) {
    io.use(async (socket, next) => {
        const startTime = Date.now();
        try {
            // Block-list check — must run before next() so blocked IPs cannot emit events
            const ip = getClientIpFromSocket(socket);
            try {
                const isBlocked = await context.redisClient.get(`blocklist:${ip}`);
                if (isBlocked) {
                    logger.warn(`Blocked IP attempting to connect: ${ip}`);
                    return next(new Error('Connection refused'));
                }
            } catch (err) {
                logger.error('Error checking IP blocklist in middleware:', { error: err?.message, ip });
                // fail open on Redis error so legitimate users aren't locked out
            }

            const incomingEvent = socket.handshake.auth?.event || '';
            if (incomingEvent === 'walletLogin') {
                return next();
            }

            const cookieHeader = socket.handshake.headers.cookie;
            if (!cookieHeader) {
                console.warn('[AUTH] No cookies in Socket.IO handshake');
                return next(new Error('Authentication required'));
            }

            const cookies = cookie.parse(cookieHeader);
            let sessionToken = cookies.sessionToken;
            if (!sessionToken) return next(new Error('No session cookie'));

            if (sessionToken.startsWith('s:')) {
                sessionToken = cookieSignature.unsign(sessionToken.slice(2), SESSION_SECRET);
                if (sessionToken === false) return next(new Error('Invalid session'));
            }

            const sessionDataStr = await context.redisClient.get(`session:${sessionToken}`);
            if (!sessionDataStr) return next(new Error('Session expired'));

            const sessionData = JSON.parse(sessionDataStr);
            socket.user = { walletAddress: sessionData.walletAddress, fingerprint: sessionData.fingerprint, sessionToken };
            SecurityLogger.socketAuthSuccess(sessionData.walletAddress, socket);
            next();
        } catch (error) {
            logger.error('[AUTH] Connection middleware error', {
                error: error.message, errorName: error.name, socketId: socket.id,
                duration: Date.now() - startTime,
            });
            next(new Error('Authentication failed'));
        }
    });
}

// ─── Session validator (used inside game event handlers) ─────────────────────

async function validateSocketSession(socket, eventName) {
    if (!socket.user?.walletAddress) {
        socket.emit('error', { message: 'Unauthorized: Please login first', code: 'AUTH_REQUIRED' });
        return false;
    }

    const { walletAddress } = socket.user;
    try {
        const currentToken = await context.redisClient.get(`session:wallet:${walletAddress}`);
        const session = currentToken ? await context.redisClient.get(`session:${currentToken}`) : null;
        if (!session) {
            socket.emit('error', { message: 'Session expired: Please login again', code: 'SESSION_EXPIRED' });
            socket.disconnect(true);
            return false;
        }
        // If this socket's session token no longer matches the active token for
        // the wallet (e.g. the user logged in on another device), kick it.
        if (socket.user.sessionToken && currentToken !== socket.user.sessionToken) {
            socket.emit('error', { message: 'Session superseded by a newer login. Please log in again.', code: 'SESSION_SUPERSEDED' });
            socket.disconnect(true);
            return false;
        }
        return true;
    } catch (error) {
        socket.emit('error', { message: 'Authentication error occurred', code: 'AUTH_ERROR' });
        return false;
    }
}

// ─── Main connection handler ──────────────────────────────────────────────────

function registerConnectionHandler(io) {
    io.on('connection', (socket) => {
        logger.info('New client connected:', socket.id);

        const connectionData = {
            ip: getClientIpFromSocket(socket),
            userAgent: socket.handshake.headers['user-agent'],
            timestamp: new Date(),
            sessionId: socket.id,
        };

        botDetector.trackConnection(connectionData.ip, connectionData.userAgent, socket.id);

        // Per-packet rate limiter (burst-friendly)
        socket.use(async (packet, next) => {
            try {
                if (packet.type === 0 || packet.type === 2) { next(); return; }

                const limiter = redisService.socketRateLimiter;
                if (!limiter) { next(); return; } // Redis not ready yet — fail open

                await limiter.consume(socket.id);
                next();
            } catch (err) {
                if (err?.msBeforeNext !== undefined) {
                    next(new Error('Rate limited'));
                } else {
                    logger.error('Socket packet middleware error:', { error: err?.message });
                    next(); // fail open on unexpected errors
                }
            }
        });

        // ── requestChallenge ───────────────────────────────────────────────────
        socket.on('requestChallenge', async ({ walletAddress } = {}) => {
            try {
                if (!walletAddress || typeof walletAddress !== 'string' ||
                    walletAddress.length < 32 || walletAddress.length > 44) {
                    return socket.emit('challengeError', 'Invalid wallet address');
                }

                const { nonce, issuedAt } = await issueChallenge(walletAddress);
                socket.emit('challenge', { nonce, issuedAt });
            } catch (error) {
                logger.error('[CHALLENGE] Failed to issue challenge:', { error: error.message });
                socket.emit('challengeError', 'Failed to generate challenge. Please try again.');
            }
        });

        // ── walletLogin ────────────────────────────────────────────────────────
        // Accepts: { walletAddress, signature, nonce, recaptchaToken, clientData }
        // NOTE: `message` is no longer accepted from the client.
        //       The server reconstructs it from the stored challenge (H3 fix).
        socket.on('walletLogin', async ({ walletAddress, signature, nonce, recaptchaToken, clientData, clientTime }) => {
            try {
                const clientIP = getClientIpFromSocket(socket);

                // ── Blocklist checks ──────────────────────────────────────────
                const isWalletBlocked = await context.redisClient.get(`blocklist:wallet:${walletAddress}`);
                if (isWalletBlocked) {
                    socket.emit('loginFailure', 'This wallet is temporarily blocked.');
                    return;
                }

                // ── Login rate limit ──────────────────────────────────────────
                const loginLimitKey = `login:${clientIP}`;
                const loginAttempts = await context.redisClient.incr(loginLimitKey);
                if (loginAttempts === 1) {
                    // First attempt — set the expiry (INCR on a new key has no TTL)
                    await context.redisClient.expire(loginLimitKey, 60);
                }
                if (loginAttempts > 5) {
                    SecurityLogger.rateLimitExceeded(clientIP, 'login', 5, '1 minute');
                    trackRateLimitViolation(clientIP, { eventName: 'login' });
                    return socket.emit('loginFailure', 'Too many login attempts. Please try again later.');
                }

                // ── reCAPTCHA ─────────────────────────────────────────────────
                let recaptchaResult;
                try {
                    recaptchaResult = await verifyRecaptcha(recaptchaToken);
                } catch (error) {
                    try { await rateLimitFailedRecaptcha(clientIP); } catch (rateError) {
                        console.warn(`reCAPTCHA rate limit hit for IP ${clientIP}:`, rateError.message);
                        return socket.emit('loginFailure', 'Too many failed verification attempts. Please try again later.');
                    }
                    return socket.emit('loginFailure', 'Verification failed. Please try again.');
                }

                // ── Fallback anomaly check (reCAPTCHA disabled) ───────────────
                if (process.env.ENABLE_RECAPTCHA !== 'true') {
                    const anomalies = [];
                    if (!clientData) anomalies.push('missing clientData');
                    else {
                        try {
                            if (clientData.timezone && !Intl.supportedValuesOf('timeZone').includes(clientData.timezone))
                                anomalies.push('invalid timezone');
                        } catch {}
                        if (clientData.screenResolution && !/^\d+x\d+$/.test(clientData.screenResolution))
                            anomalies.push('invalid resolution');
                    }
                    if (anomalies.length > 0)
                        return socket.emit('loginFailure', 'Invalid client information. Please try again.');
                }

                // ── Challenge validation (H3 fix) ─────────────────────────────
                let canonicalMessage;
                try {
                    canonicalMessage = await consumeChallenge(walletAddress, nonce);
                } catch (challengeError) {
                    logger.warn(`[LOGIN] Challenge validation failed for ${walletAddress}: ${challengeError.message}`);
                    SecurityLogger.log('challenge_validation_failed', {
                        walletAddress,
                        ip: clientIP,
                        reason: challengeError.message,
                    });
                    return socket.emit('loginFailure', challengeError.message);
                }

                // ── Wallet signature verification ─────────────────────────────
                try {
                    const publicKey      = new PublicKey(walletAddress);
                    const signatureBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
                    const messageBytes   = new TextEncoder().encode(canonicalMessage);
                    const verified       = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey.toBytes());

                    if (!verified) {
                        SecurityLogger.log('wallet_signature_invalid', { walletAddress, ip: clientIP });
                        trackFailedLogin(walletAddress, clientIP, { reason: 'invalid_signature' });
                        return socket.emit('loginFailure', 'Signature verification failed. Please try again.');
                    }
                } catch (error) {
                    logger.error('Wallet signature verification error:', error);
                    return socket.emit('loginFailure', 'Signature verification failed. Please try again.');
                }

                // ── Create / update user ──────────────────────────────────────
                let user = await User.findOne({ walletAddress });
                if (!user) {
                    user = await User.create({ walletAddress, registrationIP: clientIP, registrationDate: new Date() });
                } else {
                    user.lastLoginDate = new Date();
                    user.lastLoginIP   = clientIP;
                    await user.save();
                }

                socket.user = { walletAddress, socketId: socket.id };

                // ── Issue one-time verify token for HTTP /api/auth/login ──────
                const { v4: uuidv4 } = require('uuid');
                const verifyToken = uuidv4();
                // Key embeds the token so HTTP login can atomically consume it via DEL
                await context.redisClient.set(`verify:${walletAddress}:${verifyToken}`, '1', 'EX', 300);

                SecurityLogger.loginSuccess(walletAddress, { sessionId: verifyToken, fingerprint: clientData?.userAgent }, socket.handshake);
                socket.emit('loginSuccess', { walletAddress, verifyToken, virtualBalance: user.virtualBalance || 0, serverTime: Date.now(), clientTime: clientTime || null });
                logger.info(`Wallet login success: ${walletAddress}`);
            } catch (error) {
                logger.error('Error in walletLogin:', error);
                socket.emit('loginFailure', 'Login failed. Please try again.');
            }
        });

        // ── walletReconnect ────────────────────────────────────────────────────
        socket.on('walletReconnect', async (walletAddress) => {
            try {
                logger.info(`Wallet reconnect attempt: ${walletAddress}`);

                // Must already be authenticated and match the session wallet
                if (!socket.user?.walletAddress || socket.user.walletAddress !== walletAddress) {
                    socket.emit('reconnectFailure', 'Unauthorized');
                    return;
                }

                // Cancel any pending forfeit timer for this wallet
                if (disconnectTimers.has(walletAddress)) {
                    clearTimeout(disconnectTimers.get(walletAddress));
                    disconnectTimers.delete(walletAddress);
                    logger.info(`[DISCONNECT] Grace-period forfeit cancelled for ${walletAddress} (reconnected)`);
                }

                const user = await User.findOne({ walletAddress });
                if (!user) { socket.emit('reconnectFailure', 'User not found'); return; }

                socket.user = { walletAddress, socketId: socket.id };

                const activeGame = await findPlayerActiveRoom(walletAddress);
                if (activeGame) {
                    const { roomId, room } = activeGame;
                    socket.roomId = roomId;
                    await socket.join(roomId);

                    const playerIndex = room.players.findIndex(p => p.username === walletAddress);
                    if (playerIndex !== -1) {
                        room.players[playerIndex].socketId = socket.id;
                        await updateGameRoom(roomId, room);
                        orphanedPlayerMetrics.totalRestored++;
                    }

                    // If the question was paused during grace period, restart it
                    // fresh for both players now that the disconnected player is back.
                    if (room.disconnectGracePeriod) {
                        await restartCurrentQuestion(roomId);
                    }

                    const currentQ = room.gameStarted && room.questions.length > 0
                        ? room.questions[Math.max(0, room.currentQuestionIndex)] : null;

                    socket.emit('reconnectSuccess', {
                        walletAddress,
                        activeGame: {
                            roomId,
                            players: room.players,
                            currentQuestionIndex: room.currentQuestionIndex,
                            gameStarted: room.gameStarted,
                            currentQuestion: currentQ ? {
                                questionId: currentQ.tempId,
                                question:   currentQ.question,
                                options:    currentQ.shuffledOptions,
                                questionNumber: room.currentQuestionIndex + 1,
                                totalQuestions: room.questions.length,
                            } : null,
                        },
                        virtualBalance: user.virtualBalance || 0,
                    });
                    logger.info(`Reconnected ${walletAddress} to active game ${roomId}`);
                } else {
                    socket.emit('reconnectSuccess', { walletAddress, activeGame: null, virtualBalance: user.virtualBalance || 0 });
                }
            } catch (error) {
                logger.error('Error in walletReconnect:', error);
                socket.emit('reconnectFailure', 'Reconnect failed. Please try again.');
            }
        });

        // Socket is already connected at this point — join the per-wallet room directly.
        if (socket.user?.walletAddress) socket.join(`wallet:${socket.user.walletAddress}`);

        // ── Authenticated game events ──────────────────────────────────────────
        const gameEvents = [
            'joinGame', 'playerReady', 'joinPracticeGame', 'joinTournamentGame',
            'subscribe', 'joinHumanMatchmaking', 'joinBotGame', 'switchToBot',
            'leaveRoom', 'requestBotRoom', 'requestBotGame', 'submitAnswer',
        ];

        gameEvents.forEach(event => {
            socket.on(event, async (...args) => {
                try {
                    const isValid = await validateSocketSession(socket, event);
                    if (!isValid) return;
                    await handleGameEvent(socket, event, args);
                } catch (error) {
                    logger.error(`Error in ${event} handler:`, error);
                    socket.emit('error', { message: 'An error occurred', code: 'EVENT_ERROR' });
                }
            });
        });

        // ── disconnect ─────────────────────────────────────────────────────────
        socket.on('disconnect', async () => {
            logger.info('Client disconnected:', socket.id);
            const redisClient = context.redisClient;

            // 1. Remove from matchmaking pool
            if (socket.matchmakingPool) {
                try {
                    const removed = await removeFromMatchmakingPool(socket.matchmakingPool, socket.id);
                    if (removed) logger.info(`Player ${removed.walletAddress} removed from matchmaking pool`);
                    socket.matchmakingPool = null;
                    await logMatchmakingState();
                } catch (error) {
                    console.error(`Error in matchmaking cleanup for socket ${socket.id}:`, error);
                }
            }

            // 2. Handle active game room — defer forfeit by DISCONNECT_GRACE_MS so brief
            //    network blips don't immediately penalise the player.
            try {
                let roomId = socket.roomId;

                if (!roomId && socket.user?.walletAddress) {
                    logger.warn(`[DISCONNECT] No socket.roomId for ${socket.user.walletAddress}, searching Redis...`);
                    const activeGame = await findPlayerActiveRoom(socket.user.walletAddress);
                    if (activeGame) {
                        roomId = activeGame.roomId;
                        orphanedPlayerMetrics.totalOrphaned++;
                        alertManager.sendAlert({ severity: 'medium', category: 'orphaned_player',
                            message: `Orphaned player detected: ${socket.user.walletAddress} in room ${roomId}`,
                            details: { walletAddress: socket.user.walletAddress, socketId: socket.id, roomId } });
                    }
                }

                if (!roomId) { logger.info(`[DISCONNECT] No active room found for socket ${socket.id}`); return; }

                const initialRoom = await getGameRoom(roomId);
                if (!initialRoom || initialRoom.isDeleted) { socket.roomId = null; return; }

                let playerIndex = initialRoom.players.findIndex(p => p.id === socket.id);
                let disconnectedPlayer = playerIndex !== -1 ? initialRoom.players[playerIndex] : null;

                if (!disconnectedPlayer && socket.user?.walletAddress) {
                    const walletIdx = initialRoom.players.findIndex(p => p.username === socket.user.walletAddress);
                    if (walletIdx === -1) { socket.roomId = null; return; }
                    disconnectedPlayer = initialRoom.players[walletIdx];
                }
                if (!disconnectedPlayer) { socket.roomId = null; return; }

                const walletAddress = disconnectedPlayer.username;

                // Notify opponent and start grace timer — do NOT remove the player yet.
                if (initialRoom.gameStarted) {
                    // Pause the active question so Player B doesn't see the correct
                    // answer or advance while waiting for the grace period to resolve.
                    try {
                        await atomicRoomUpdate(roomId, async (r) => {
                            if (r.questionTimeout) { clearTimeout(r.questionTimeout); r.questionTimeout = null; }
                            r.disconnectGracePeriod = true;
                            return r;
                        });
                    } catch (e) {
                        logger.warn('[DISCONNECT] Could not pause question timer:', e.message);
                    }
                    io.to(roomId).emit('playerDisconnected', { walletAddress, gracePeriodMs: DISCONNECT_GRACE_MS });
                }

                // Cancel any existing timer (e.g. repeated disconnect events)
                if (disconnectTimers.has(walletAddress)) {
                    clearTimeout(disconnectTimers.get(walletAddress));
                }

                const timer = setTimeout(async () => {
                    disconnectTimers.delete(walletAddress);
                    logger.info(`[DISCONNECT] Grace period expired for ${walletAddress}, forfeiting game in room ${roomId}`);

                    let room;
                    try {
                        room = await atomicRoomUpdate(roomId, async (r) => {
                            let idx = r.players.findIndex(p => p.id === socket.id);
                            if (idx === -1) idx = r.players.findIndex(p => p.username === walletAddress);
                            if (idx === -1) throw new Error('Player not in room');
                            if (r.questionTimeout) { clearTimeout(r.questionTimeout); r.questionTimeout = null; }
                            r.players.splice(idx, 1);
                            r.playerLeft = true; r.isDeleted = true;
                            return r;
                        });
                    } catch (error) {
                        if (error.message.includes('not found') || error.message === 'Player not in room') return;
                        logger.error('Error in deferred disconnect cleanup', { error: error.message });
                        return;
                    }

                    // Bot game forfeit
                    if (room.roomMode === 'bot') {
                        const botPlayer = room.players.find(p => p.isBot);
                        if (botPlayer) {
                            await updatePlayerStats([
                                { username: disconnectedPlayer.username, score: disconnectedPlayer.score || 0, totalResponseTime: disconnectedPlayer.totalResponseTime || 0, isBot: false },
                                { username: botPlayer.username, score: botPlayer.score || 0, totalResponseTime: botPlayer.totalResponseTime || 0, isBot: true },
                            ], { winner: botPlayer.username, botOpponent: true, betAmount: room.betAmount });
                            io.to(roomId).emit('gameOverForfeit', { winner: botPlayer.username, disconnectedPlayer: disconnectedPlayer.username, betAmount: room.betAmount, botOpponent: true, gameMode: room.gameMode || null, tournamentId: room.tournamentId || null, message: `${disconnectedPlayer.username} left. ${botPlayer.username} wins.` });
                        }
                        await deleteGameRoom(roomId);
                        await redisClient.del(`room:${roomId}`);
                        await logGameRoomsState();
                        return;
                    }

                    // Human vs human forfeit
                    if (room.players.length === 1 && !room.players[0].isBot) {
                        const remainingPlayer = room.players[0];
                        const allPlayers = [
                            { username: remainingPlayer.username,    score: remainingPlayer.score    || 0, totalResponseTime: remainingPlayer.totalResponseTime    || 0, isBot: false },
                            { username: disconnectedPlayer.username, score: disconnectedPlayer.score || 0, totalResponseTime: disconnectedPlayer.totalResponseTime || 0, isBot: false },
                        ];
                        await handlePlayerLeftWin(roomId, remainingPlayer, disconnectedPlayer, room.betAmount, false, allPlayers);
                        await redisClient.del(`room:${roomId}`);
                        await logGameRoomsState();
                        return;
                    }

                    // Room empty
                    if (room.players.length === 0) {
                        await deleteGameRoom(roomId);
                        await redisClient.del(`room:${roomId}`);
                        await logGameRoomsState();
                        return;
                    }

                    if (!room.gameStarted) io.to(roomId).emit('playerLeft', disconnectedPlayer.username);
                }, DISCONNECT_GRACE_MS);

                disconnectTimers.set(walletAddress, timer);
                socket.roomId = null;
            } catch (error) {
                logger.error('Error cleaning up game rooms', { socketId: socket.id, error: error.message });
                socket.roomId = null;
            }
        });

        socket.on('requestGameRestore', async () => {
            try {
                // walletAddress comes from the authenticated session only
                const walletAddress = socket.user?.walletAddress;
                if (!walletAddress) {
                    socket.emit('gameRestoreFailed', 'Unauthorized');
                    return;
                }

                const activeGame = await findPlayerActiveRoom(walletAddress);
                if (!activeGame) {
                    socket.emit('gameRestoreFailed', 'No active game found');
                    return;
                }

                const { roomId, room } = activeGame;
                socket.roomId = roomId;
                await socket.join(roomId);

                const playerIndex = room.players.findIndex(p => p.username === walletAddress);
                if (playerIndex !== -1) {
                    room.players[playerIndex].socketId = socket.id;
                    await updateGameRoom(roomId, room);
                }

                // Restart the paused question if the player is reconnecting mid grace period.
                if (room.disconnectGracePeriod) {
                    await restartCurrentQuestion(roomId);
                }

                const currentQ = room.gameStarted && room.questions.length > 0
                    ? room.questions[Math.max(0, room.currentQuestionIndex)] : null;

                socket.emit('gameStateRestore', {
                    roomId,
                    players: room.players,
                    currentQuestionIndex: room.currentQuestionIndex,
                    gameStarted: room.gameStarted,
                    currentQuestion: currentQ ? {
                        questionId: currentQ.tempId,
                        question:   currentQ.question,
                        options:    currentQ.shuffledOptions,
                        questionNumber: room.currentQuestionIndex + 1,
                        totalQuestions: room.questions.length,
                    } : null,
                });

                logger.info(`[RESTORE] Game restored for ${walletAddress} in room ${roomId}`);
            } catch (error) {
                logger.error('[RESTORE] Error restoring game:', { error: error.message });
                socket.emit('gameRestoreFailed', 'Restore failed');
            }
        });
    });
}

// ─── Game event dispatch ──────────────────────────────────────────────────────
// NOTE: This function handles all game socket events. It replicates the large
// inline switch in the original server.js. Each case should be broken into its
// own handler file as the next step of refactoring.

async function handleGameEvent(socket, event, args) {
    const io          = context.io;
    const redisClient = context.redisClient;
    const data        = args[0];

    // ── joinPracticeGame ───────────────────────────────────────────────────────
    if (event === 'joinPracticeGame') {
        const { error } = joinPracticeGameSchema.validate(data);
        if (error) { socket.emit('joinGameFailure', 'Invalid input format'); return; }
        const walletAddress = socket.user.walletAddress;
        const { gameMode = 'bot' } = data;
        const clientIP = getClientIpFromSocket(socket);
        await rateLimitEvent(walletAddress, 'joinPracticeGame', clientIP, socket);

        if (await isBlockedFn(walletAddress) || await isBlockedFn(clientIP)) {
            socket.emit('joinGameFailure', 'Access denied'); return;
        }

        const practiceUser = await User.findOne({ walletAddress });
        if (practiceUser && practiceUser.hasPremiumAccess()) {
            socket.emit('joinGameFailure', 'Premium subscribers cannot join practice games. Use ranked matchmaking instead.');
            return;
        }

        const { generateRoomId } = require('../utils/helpers');

        if (gameMode === 'human') {
            // ── Human vs human matchmaking (mirrors joinHumanMatchmaking) ──────
            const pool = await getMatchmakingPool(0);
            const alreadyQueued = pool.some(p => p.walletAddress === walletAddress);
            if (alreadyQueued) { socket.emit('matchmakingError', 'Already in queue'); return; }

            await addToMatchmakingPool(0, { walletAddress, socketId: socket.id, joinTime: Date.now() });
            socket.matchmakingPool = 0;

            const updatedPool = await getMatchmakingPool(0);
            if (updatedPool.length >= 2) {
                const p1 = updatedPool[0]; const p2 = updatedPool[1];
                await removeFromMatchmakingPool(0, p1.socketId);
                await removeFromMatchmakingPool(0, p2.socketId);

                const roomId = generateRoomId();
                const room = await createGameRoom(roomId, 0, 'human', { gameMode: 'practice', isPractice: true });
                room.players.push(
                    { id: p1.socketId, username: p1.walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false },
                    { id: p2.socketId, username: p2.walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false }
                );
                await updateGameRoom(roomId, room);

                const p1Socket = io.sockets.sockets.get(p1.socketId);
                const p2Socket = io.sockets.sockets.get(p2.socketId);
                if (p1Socket) { p1Socket.join(roomId); p1Socket.roomId = roomId; p1Socket.matchmakingPool = null; }
                if (p2Socket) { p2Socket.join(roomId); p2Socket.roomId = roomId; p2Socket.matchmakingPool = null; }

                await GameSession.create({ roomId, betAmount: 0, gameMode: 'practice', players: [{ walletAddress: p1.walletAddress, socketId: p1.socketId }, { walletAddress: p2.walletAddress, socketId: p2.socketId }], status: 'active' });

                io.to(roomId).emit('matchFound', { gameRoomId: roomId, players: [p1.walletAddress, p2.walletAddress], mode: 'practice' });
                await startGame(roomId);
            } else {
                socket.emit('matchmakingJoined', { waitingRoomId: 'matchmaking-practice', mode: 'practice' });
            }
            await logMatchmakingState();

        } else {
            // ── Bot game ──────────────────────────────────────────────────────
            const roomId = generateRoomId();
            const room = await createGameRoom(roomId, 0, 'bot', { gameMode: 'practice', isPractice: true });
            room.players.push({ id: socket.id, username: walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false });
            await updateGameRoom(roomId, room);
            socket.join(roomId); socket.roomId = roomId;

            await GameSession.create({ roomId, betAmount: 0, gameMode: 'practice', players: [{ walletAddress, socketId: socket.id }], status: 'active' });

            socket.emit('joinedRoom', { roomId, players: room.players, betAmount: 0, gameMode: 'practice', isPractice: true });
            await startSinglePlayerGame(roomId);
            await logGameRoomsState();
        }
        return;
    }

    // ── joinGame (legacy / bet-based) ──────────────────────────────────────────
    if (event === 'joinGame') {
        const { error } = transactionSchema.validate(data);
        if (error) {
            trackValidationFailure(socket.user?.walletAddress || socket.handshake.address, 'joinGame', error.message);
            socket.emit('joinGameFailure', 'Invalid input format'); return;
        }
        const walletAddress = socket.user.walletAddress;
        const { betAmount, transactionSignature, nonce, recaptchaToken } = data;
        const clientIP = getClientIpFromSocket(socket);
        await rateLimitEvent(walletAddress, 'joinGame', clientIP, socket);

        if (await isBlockedFn(walletAddress) || await isBlockedFn(clientIP)) {
            socket.emit('joinGameFailure', 'Access denied'); return;
        }

        try {
            await verifyAndValidateTransaction(transactionSignature, betAmount, walletAddress, context.config.TREASURY_WALLET.toBase58(), nonce);
        } catch (txError) {
            trackFailedTransaction(walletAddress, { error: txError.message, betAmount, transactionSignature });
            socket.emit('joinGameFailure', txError.message); return;
        }

        const { generateRoomId } = require('../utils/helpers');
        const waitingRoomId = await getWaitingRoom(betAmount);

        if (waitingRoomId) {
            const joinedRoom = await atomicRoomUpdate(waitingRoomId, async (r) => {
                if (!r || r.gameStarted || r.players.length !== 1) {
                    r._joinRejected = true; return r;
                }
                r.players.push({ id: socket.id, username: walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false });
                r.roomMode = 'multiplayer';
                return r;
            });

            if (joinedRoom && !joinedRoom._joinRejected) {
                await removeWaitingRoom(betAmount, waitingRoomId);
                socket.join(waitingRoomId); socket.roomId = waitingRoomId;
                io.to(waitingRoomId).emit('playerJoined', { players: joinedRoom.players });
                await startGame(waitingRoomId);
                await logGameRoomsState();
                return;
            }
        }

        const roomId = generateRoomId();
        const room   = await createGameRoom(roomId, betAmount, 'waiting');
        room.players.push({ id: socket.id, username: walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false });
        await updateGameRoom(roomId, room);
        await addWaitingRoom(betAmount, roomId);
        socket.join(roomId); socket.roomId = roomId;

        await GameSession.create({ roomId, betAmount, gameMode: 'human', players: [{ walletAddress, socketId: socket.id }], status: 'active' });

        socket.emit('waitingForOpponent', { roomId, players: room.players, betAmount });

        // Auto-switch to bot after 30s wait
        const waitTimeout = setTimeout(async () => {
            const r = await getGameRoom(roomId);
            if (r && r.players.length === 1 && !r.gameStarted) {
                r.roomMode = 'bot'; await updateGameRoom(roomId, r);
                await removeWaitingRoom(betAmount, roomId);
                socket.emit('switchedToBot', { roomId });
                await startSinglePlayerGame(roomId);
            }
        }, 30000);

        room.waitingTimeout = waitTimeout;
        await logGameRoomsState();
        return;
    }

    // ── requestBotRoom (disabled — paid bot rooms not exposed in current UI) ───
    // if (event === 'requestBotRoom') {
    //     const { error } = requestBotRoomSchema.validate(data);
    //     if (error) { socket.emit('requestBotRoomFailure', 'Invalid input format'); return; }
    //     const walletAddress = socket.user.walletAddress;
    //     const { betAmount, transactionSignature, nonce, recaptchaToken } = data;
    //     const clientIP = getClientIpFromSocket(socket);
    //     await rateLimitEvent(walletAddress, 'requestBotRoom', clientIP, socket);
    //
    //     if (betAmount > 0) {
    //         if (await isBlockedFn(walletAddress) || await isBlockedFn(clientIP)) {
    //             socket.emit('requestBotRoomFailure', 'Access denied'); return;
    //         }
    //         try {
    //             await verifyAndValidateTransaction(transactionSignature, betAmount, walletAddress, context.config.TREASURY_WALLET.toBase58(), nonce);
    //         } catch (txError) {
    //             trackFailedTransaction(walletAddress, { error: txError.message, betAmount, transactionSignature });
    //             socket.emit('requestBotRoomFailure', txError.message); return;
    //         }
    //     }
    //
    //     const { generateRoomId } = require('../utils/helpers');
    //     const roomId = generateRoomId();
    //     const room   = await createGameRoom(roomId, betAmount, 'bot');
    //     room.players.push({ id: socket.id, username: walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false });
    //     await updateGameRoom(roomId, room);
    //     socket.join(roomId); socket.roomId = roomId;
    //
    //     socket.emit('botRoomCreated', { roomId, betAmount });
    //     await logGameRoomsState();
    //     return;
    // }

    // ── requestBotGame ─────────────────────────────────────────────────────────
    if (event === 'requestBotGame') {
        const { error } = requestBotGameSchema.validate(data);
        if (error) { socket.emit('gameError', 'Invalid room ID'); return; }
        if (socket.roomId !== data.roomId) {
            socket.emit('gameError', 'Unauthorized room access');
            return;
        }
        await startSinglePlayerGame(data.roomId);
        return;
    }

    // ── submitAnswer ───────────────────────────────────────────────────────────
    if (event === 'submitAnswer') {
        const arrivalTime = Date.now();

        const { error } = submitAnswerSchema.validate(data);
        if (error) {
            trackValidationFailure(socket.user?.walletAddress, 'submitAnswer', error.message);
            socket.emit('answerError', 'Invalid input format'); return;
        }
        const { roomId, questionId, answer } = data;
        const walletAddress = socket.user.walletAddress;
        const clientIP      = getClientIpFromSocket(socket);
        await rateLimitEvent(walletAddress, 'submitAnswer', clientIP, socket);

        if (socket.roomId !== roomId) {
            socket.emit('answerError', 'Unauthorized room access'); return;
        }

        const room = await getGameRoom(roomId);
        if (!room || room.isDeleted) { socket.emit('answerError', 'Room not found'); return; }

        const questionData = room.questionIdMap.get(questionId);
        if (!questionData) { socket.emit('answerError', 'Question not found'); return; }

        const player = room.players.find(p => p.username === walletAddress);
        if (!player || player.answered) { socket.emit('answerError', player?.answered ? 'Already answered' : 'Player not found'); return; }

        const QUESTION_DURATION_MS = 10_000;
        const LATE_GRACE_MS = 200; // absorbs normal network jitter

        let finalResponseTime = 0;
        const atomicResult = await atomicRoomUpdate(roomId, async (r) => {
            // questionStartTime is nulled by completeQuestion when a round ends.
            // If it's already null, this round is over — silently discard.
            if (!r.questionStartTime) {
                r._answerRejected = 'question_expired';
                return r;
            }
            // Deadline check lives inside the atomic block to prevent TOCTOU races.
            const serverResponseTime = arrivalTime - r.questionStartTime;
            if (serverResponseTime > QUESTION_DURATION_MS + LATE_GRACE_MS) {
                r._answerRejected = 'late_answer';
                r._serverResponseTime = serverResponseTime;
                return r;
            }
            const p = r.players.find(pl => pl.username === walletAddress);
            if (p) {
                // Re-check inside the atomic block — the outer read may be stale
                if (p.answered) { r._answerRejected = 'already_answered'; return r; }
                finalResponseTime = serverResponseTime;
                const isCorrect = answer === questionData.shuffledCorrectAnswer;
                p.answered = true; p.lastAnswer = answer; p.lastResponseTime = serverResponseTime;
                p.totalResponseTime = (p.totalResponseTime || 0) + serverResponseTime;
                if (isCorrect) { p.score++; }
            }
            r.answersReceived++;
            return r;
        });

        if (atomicResult._answerRejected === 'late_answer') {
            logger.warn(`[SUBMIT] Late answer rejected for ${walletAddress} in room ${roomId} (${atomicResult._serverResponseTime}ms after question start)`);
            socket.emit('answerError', 'Answer submitted after deadline');
            return;
        }
        if (atomicResult._answerRejected === 'question_expired') {
            logger.info(`[SUBMIT] Answer arrived after round completed for ${walletAddress} in room ${roomId}, ignoring`);
            return;
        }
        if (atomicResult._answerRejected === 'already_answered') {
            socket.emit('answerError', 'Already answered');
            return;
        }

        io.to(roomId).emit('playerAnswered', { username: walletAddress, isBot: false, timedOut: false, responseTime: finalResponseTime });

        const updatedRoom = await getGameRoom(roomId);
        const totalPlayers = updatedRoom.players.length;
        const allAnswered  = updatedRoom.players.every(p => p.answered);
        if (allAnswered || updatedRoom.answersReceived >= totalPlayers) {
            await completeQuestion(roomId);
        }
        return;
    }

    // ── leaveRoom ──────────────────────────────────────────────────────────────
    if (event === 'leaveRoom') {
        const { error } = leaveRoomSchema.validate(data);
        if (error) { socket.emit('leaveRoomError', 'Invalid room ID'); return; }
        const { roomId } = data;
        await rateLimitEvent(socket.user.walletAddress, 'leaveRoom', null, socket);

        if (socket.roomId !== roomId) {
            socket.emit('leaveRoomError', 'Unauthorized room access'); return;
        }

        let room;
        let leavingPlayer;
        try {
            room = await atomicRoomUpdate(roomId, async (r) => {
                const idx = r.players.findIndex(p => p.username === socket.user.walletAddress);
                if (idx === -1) throw new Error('Player not in room');
                leavingPlayer = r.players[idx];
                if (r.questionTimeout) { clearTimeout(r.questionTimeout); r.questionTimeout = null; }
                r.players.splice(idx, 1);
                r.playerLeft = true;
                if (r.gameStarted) r.isDeleted = true;
                return r;
            });
        } catch (err) {
            if (err.message === 'Player not in room') return;
            throw err;
        }

        socket.leave(roomId); socket.roomId = null;
        if (leavingPlayer) io.to(roomId).emit('playerLeft', socket.user.walletAddress);

        if (!room.gameStarted || !leavingPlayer) {
            await logGameRoomsState();
            return;
        }

        // Game was in progress — settle immediately so the remaining player
        // gets their forfeit win regardless of where we are in the question cycle.
        if (room.roomMode === 'bot') {
            const botPlayer = room.players.find(p => p.isBot);
            if (botPlayer) {
                await updatePlayerStats([
                    { username: leavingPlayer.username, score: leavingPlayer.score || 0, totalResponseTime: leavingPlayer.totalResponseTime || 0, isBot: false },
                    { username: botPlayer.username, score: botPlayer.score || 0, totalResponseTime: botPlayer.totalResponseTime || 0, isBot: true },
                ], { winner: botPlayer.username, botOpponent: true, betAmount: room.betAmount });
                io.to(roomId).emit('gameOverForfeit', { winner: botPlayer.username, disconnectedPlayer: leavingPlayer.username, betAmount: room.betAmount, botOpponent: true, gameMode: room.gameMode || null, tournamentId: room.tournamentId || null, message: `${leavingPlayer.username} left. ${botPlayer.username} wins.` });
            }
            await deleteGameRoom(roomId);
        } else if (room.players.length === 1 && !room.players[0].isBot) {
            const remainingPlayer = room.players[0];
            const allPlayers = [
                { username: remainingPlayer.username, score: remainingPlayer.score || 0, totalResponseTime: remainingPlayer.totalResponseTime || 0, isBot: false },
                { username: leavingPlayer.username,   score: leavingPlayer.score   || 0, totalResponseTime: leavingPlayer.totalResponseTime   || 0, isBot: false },
            ];
            await handlePlayerLeftWin(roomId, remainingPlayer, leavingPlayer, room.betAmount, false, allPlayers);
        } else {
            await deleteGameRoom(roomId);
        }
        await logGameRoomsState();
        return;
    }

    // ── switchToBot ────────────────────────────────────────────────────────────
    if (event === 'switchToBot') {
        const { error } = switchToBotSchema.validate(data);
        if (error) { socket.emit('gameError', 'Invalid room ID'); return; }
        const { roomId } = data;
        await rateLimitEvent(socket.user.walletAddress, 'switchToBot', null, socket);

        if (socket.roomId !== roomId) {
            socket.emit('gameError', 'Unauthorized room access'); return;
        }

        const room = await getGameRoom(roomId);
        if (!room) { socket.emit('gameError', 'Room not found'); return; }

        if (socket.matchmakingPool) {
            await removeFromMatchmakingPool(socket.matchmakingPool, socket.id);
            socket.matchmakingPool = null;
        }

        room.roomMode = 'bot';
        await updateGameRoom(roomId, room);
        await removeWaitingRoom(room.betAmount, roomId);
        socket.emit('switchedToBot', { roomId });
        await startSinglePlayerGame(roomId);
        return;
    }

    // ── joinHumanMatchmaking ───────────────────────────────────────────────────
    if (event === 'joinHumanMatchmaking') {
        const { error } = joinHumanMatchmakingSchema.validate(data);
        if (error) { socket.emit('matchmakingError', 'Invalid input format'); return; }
        const walletAddress = socket.user.walletAddress;
        const { betAmount } = data;
        const clientIP = getClientIpFromSocket(socket);
        await rateLimitEvent(walletAddress, 'joinHumanMatchmaking', clientIP, socket);

        const matchUser = await User.findOne({ walletAddress });
        if (!matchUser || !matchUser.hasPremiumAccess()) {
            socket.emit('matchmakingError', 'A subscription is required to play ranked games. Practice games are available for free.');
            return;
        }

        const pool = await getMatchmakingPool(betAmount);
        const alreadyQueued = pool.some(p => p.walletAddress === walletAddress);
        if (alreadyQueued) { socket.emit('matchmakingError', 'Already in queue'); return; }

        await addToMatchmakingPool(betAmount, { walletAddress, socketId: socket.id, joinTime: Date.now() });
        socket.matchmakingPool = betAmount;

        const fullPool = await getMatchmakingPool(betAmount);
        const premiumPool = [];
        for (const entry of fullPool) {
            // Remove stale entries from server restarts or ungraceful disconnects
            const entrySocket = io.sockets.sockets.get(entry.socketId);
            if (!entrySocket) {
                await removeFromMatchmakingPool(betAmount, entry.socketId);
                logger.info(`[matchmaking] Removed stale entry for disconnected player ${entry.walletAddress}`);
                continue;
            }
            const entryUser = await User.findOne({ walletAddress: entry.walletAddress });
            if (entryUser && entryUser.hasPremiumAccess()) {
                premiumPool.push(entry);
            } else {
                await removeFromMatchmakingPool(betAmount, entry.socketId);
                entrySocket.emit('matchmakingError', 'Your subscription has expired. Please renew to continue playing ranked games.');
            }
        }

        if (premiumPool.length >= 2) {
            const p1 = premiumPool[0]; const p2 = premiumPool[1];
            await removeFromMatchmakingPool(betAmount, p1.socketId);
            await removeFromMatchmakingPool(betAmount, p2.socketId);

            // Re-check liveness after removal — a socket can die in the gap
            const p1Socket = io.sockets.sockets.get(p1.socketId);
            const p2Socket = io.sockets.sockets.get(p2.socketId);
            if (!p1Socket || !p2Socket) {
                // Put the live one back in the queue and bail out
                if (p1Socket) {
                    await addToMatchmakingPool(betAmount, p1);
                    p1Socket.matchmakingPool = betAmount;
                    p1Socket.emit('matchmakingJoined', { waitingRoomId: 'ranked-queue', position: 1, mode: 'ranked' });
                }
                if (p2Socket) {
                    await addToMatchmakingPool(betAmount, p2);
                    p2Socket.matchmakingPool = betAmount;
                    p2Socket.emit('matchmakingJoined', { waitingRoomId: 'ranked-queue', position: 1, mode: 'ranked' });
                }
                await logMatchmakingState();
                return;
            }

            const { generateRoomId } = require('../utils/helpers');
            const roomId = generateRoomId();
            const room   = await createGameRoom(roomId, betAmount, 'human', { gameMode: 'ranked', isPractice: false });
            room.players.push(
                { id: p1.socketId, username: p1.walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false },
                { id: p2.socketId, username: p2.walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false }
            );
            await updateGameRoom(roomId, room);

            p1Socket.join(roomId); p1Socket.roomId = roomId; p1Socket.matchmakingPool = null;
            p2Socket.join(roomId); p2Socket.roomId = roomId; p2Socket.matchmakingPool = null;

            io.to(p1.socketId).emit('matchFound', { roomId, opponent: p2.walletAddress, betAmount });
            io.to(p2.socketId).emit('matchFound', { roomId, opponent: p1.walletAddress, betAmount });

            await startGame(roomId);
        } else {
            socket.emit('matchmakingJoined', { waitingRoomId: 'ranked-queue', position: premiumPool.length, mode: 'ranked' });
        }
        await logMatchmakingState();
        return;
    }

    // ── playerReady ────────────────────────────────────────────────────────────
    if (event === 'playerReady') {
        const { error } = playerReadySchema.validate(data);
        if (error) { socket.emit('gameError', 'Invalid input format'); return; }
        const { roomId } = data;
        await rateLimitEvent(socket.user.walletAddress, 'playerReady', null, socket);

        if (socket.roomId !== roomId) {
            socket.emit('gameError', 'Unauthorized room access'); return;
        }

        const room = await atomicRoomUpdate(roomId, async (r) => {
            const playerIdx = r.players.findIndex(p => p.username === socket.user.walletAddress);
            if (playerIdx !== -1) { r.players[playerIdx].ready = true; }
            return r;
        }).catch(err => {
            if (err.message.includes('not found')) return null;
            throw err;
        });
        if (!room) { socket.emit('gameError', 'Room not found'); return; }

        const allReady = room.players.filter(p => !p.isBot).every(p => p.ready);
        if (allReady && room.players.filter(p => !p.isBot).length >= 1) {
            await startGame(roomId);
        }
        return;
    }

    // ── joinTournamentGame ─────────────────────────────────────────────────────
    if (event === 'joinTournamentGame') {
        const { error } = joinTournamentGameSchema.validate(data);
        if (error) { socket.emit('joinGameFailure', 'Invalid input format'); return; }

        const walletAddress = socket.user.walletAddress;
        const { tournamentId } = data;
        const clientIP = getClientIpFromSocket(socket);
        await rateLimitEvent(walletAddress, 'joinTournamentGame', clientIP, socket);

        try {
            const user = await User.findOne({ walletAddress });
            if (!user) { socket.emit('joinGameFailure', 'User not found'); return; }
            if (!user.hasPremiumAccess()) { socket.emit('joinGameFailure', 'Premium subscription required'); return; }

            const ts = context.tournamentService;
            const tournament = await ts.getTournament(tournamentId);
            if (!tournament) { socket.emit('joinGameFailure', 'Tournament not found'); return; }

            const isRegistered = tournament.participants.some(
                p => p.userId.toString() === user._id.toString()
            );
            if (!isRegistered) { socket.emit('joinGameFailure', 'Not registered for this tournament'); return; }

            // Leave any existing room
            if (socket.roomId) {
                const oldRoomId = socket.roomId;
                try {
                    const result = await atomicRoomUpdate(oldRoomId, async (r) => {
                        const idx = r.players.findIndex(p => p.username === walletAddress);
                        if (idx === -1) throw new Error('Player not in room');
                        r.players.splice(idx, 1);
                        r._isEmpty = r.players.length === 0;
                        return r;
                    });
                    socket.leave(oldRoomId);
                    socket.roomId = null;
                    if (result._isEmpty) await deleteGameRoom(oldRoomId);
                } catch (cleanupErr) {
                    if (!cleanupErr.message.includes('not found') && cleanupErr.message !== 'Player not in room') throw cleanupErr;
                }
            }

            const { generateRoomId } = require('../utils/helpers');
            const redisClient = context.redisClient;
            const queueKey = `matchmaking:tournament:${tournamentId}`;

            // Check for a waiting opponent — skip stale entries from disconnected players
            let opponent = null;
            let opponentSocket = null;
            while (true) {
                const opponentJson = await redisClient.lpop(queueKey);
                if (!opponentJson) break;
                const candidate = JSON.parse(opponentJson);
                const candidateSocket = context.io.sockets.sockets.get(candidate.socketId);
                if (candidateSocket) {
                    opponent = candidate;
                    opponentSocket = candidateSocket;
                    break;
                }
                logger.info(`[joinTournamentGame] Skipping stale queue entry for disconnected player ${candidate.walletAddress}`);
            }

            if (opponent && opponentSocket) {
                const roomId = generateRoomId();
                const room = await createGameRoom(roomId, 0, 'human', { gameMode: 'tournament', tournamentId, isPractice: false });

                room.players.push(
                    { id: socket.id,           username: walletAddress,            score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false },
                    { id: opponent.socketId,   username: opponent.walletAddress,   score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false }
                );
                await updateGameRoom(roomId, room);

                socket.join(roomId);
                socket.roomId = roomId;
                opponentSocket.join(roomId); opponentSocket.roomId = roomId;

                context.io.to(roomId).emit('matchFound', {
                    gameRoomId: roomId, players: [walletAddress, opponent.walletAddress],
                    mode: 'tournament', tournamentId,
                });
                await startGame(roomId);
            } else {
                // No opponent yet — create room and join queue
                const roomId = generateRoomId();
                const room = await createGameRoom(roomId, 0, 'human', { gameMode: 'tournament', tournamentId, isPractice: false });
                room.players.push({ id: socket.id, username: walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false });
                await updateGameRoom(roomId, room);
                socket.join(roomId);
                socket.roomId = roomId;

                await redisClient.lpush(queueKey, JSON.stringify({ socketId: socket.id, walletAddress, joinTime: Date.now() }));
                await redisClient.expire(queueKey, 600); // 10-minute queue TTL

                socket.emit('matchmakingJoined', { waitingRoomId: `tournament-${tournamentId}`, mode: 'tournament', tournamentId });
            }

            await logGameRoomsState();
        } catch (err) {
            logger.error('[joinTournamentGame] Error:', { error: err.message });
            socket.emit('joinGameFailure', 'Failed to join tournament game');
        }
        return;
    }

    logger.warn(`Unhandled game event: ${event}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

function registerSocketHandlers(io) {
    registerSocketAuthMiddleware(io);
    registerConnectionHandler(io);
}

module.exports = { registerSocketHandlers, botDetector };