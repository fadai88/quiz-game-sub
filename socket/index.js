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

const redisService = require('../services/redisService');
const { SecurityLogger, AuditLogger }  = require('../utils/securityLogger');
const { sanitizeForLog }               = require('../utils/sanitize');
const { verifyRecaptcha }              = require('../utils/helpers');
const { orphanedPlayerMetrics }        = require('../utils/idempotency');
const { alertManager, trackValidationFailure, trackRateLimitViolation, trackBotSuspicion, trackRecaptchaFailure, trackFailedTransaction, trackFailedLogin } = require('../config/alerts');

const {
    transactionSchema, submitAnswerSchema, playerReadySchema,
    switchToBotSchema, requestBotRoomSchema, requestBotGameSchema,
    leaveRoomSchema, matchFoundSchema, joinPracticeGameSchema, joinTournamentGameSchema,
} = require('../config/schemas');

const {
    createGameRoom, getGameRoom, updateGameRoom, deleteGameRoom,
    atomicRoomUpdate, addToMatchmakingPool, removeFromMatchmakingPool,
    getMatchmakingPool, addWaitingRoom, getWaitingRoom, removeWaitingRoom,
    getAllMatchmakingPools, logGameRoomsState, logMatchmakingState,
} = require('../services/roomManager');

const { startGame, startSinglePlayerGame, completeQuestion, abortGameWithRefund } = require('../services/gameService');
const { updatePlayerStats, refundToVirtualBalance, findPlayerActiveRoom, handlePlayerLeftWin } = require('../services/playerService');
const { verifyAndValidateTransaction } = require('../services/transactionVerifier');
const { rateLimitEvent, rateLimitFailedRecaptcha, isBlocked: isBlockedFn } = require('../services/rateLimitService');

const SESSION_SECRET = process.env.SESSION_SECRET;

const botDetector = new BotDetector();

// ─── Socket.IO auth middleware ────────────────────────────────────────────────

function registerSocketAuthMiddleware(io) {
    io.use(async (socket, next) => {
        const startTime = Date.now();
        try {
            const incomingEvent = socket.handshake.auth?.event || '';
            if (incomingEvent === 'walletLogin' || incomingEvent === 'walletReconnect') {
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
        const sessionToken = socket.user.sessionToken;
        if (!sessionToken) {
            socket.emit('error', { message: 'Session expired: Please login again', code: 'SESSION_EXPIRED' });
            socket.disconnect(true);
            return false;
        }
        const session = await context.redisClient.get(`session:${sessionToken}`);
        if (!session) {
            socket.emit('error', { message: 'Session expired: Please login again', code: 'SESSION_EXPIRED' });
            socket.disconnect(true);
            return false;
        }
        const sessionData = JSON.parse(session);
        if (Date.now() - sessionData.timestamp > 24 * 60 * 60 * 1000) {
            await context.redisClient.del(`session:${sessionToken}`);
            socket.emit('error', { message: 'Session expired: Please login again', code: 'SESSION_EXPIRED' });
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
            ip: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address,
            userAgent: socket.handshake.headers['user-agent'],
            timestamp: new Date(),
            sessionId: socket.id,
        };

        botDetector.trackConnection(connectionData.ip, connectionData.userAgent, socket.id);

        // Block-list check on connect
        (async () => {
            try {
                const isBlocked = await context.redisClient.get(`blocklist:${connectionData.ip}`);
                if (isBlocked) {
                    logger.warn(`Blocked IP attempting to connect: ${connectionData.ip}`);
                    socket.disconnect();
                }
            } catch (error) {
                logger.error('Error checking IP blocklist:', { error: error?.message, ip: connectionData.ip });
            }
        })();

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

        // ── walletLogin ────────────────────────────────────────────────────────
        socket.on('walletLogin', async ({ walletAddress, signature, message, recaptchaToken, clientData }) => {
            try {
                const clientIP = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() || socket.handshake.address;

                const isWalletBlocked = await context.redisClient.get(`blocklist:wallet:${walletAddress}`);
                if (isWalletBlocked) { socket.emit('loginFailure', 'This wallet is temporarily blocked.'); return; }

                const loginLimitKey = `login:${clientIP}`;
                const loginAttempts = await context.redisClient.get(loginLimitKey) || 0;
                if (loginAttempts > 100) {
                    SecurityLogger.rateLimitExceeded(clientIP, 'login', 5, '1 minute');
                    trackRateLimitViolation(clientIP, { eventName: 'login' });
                    return socket.emit('loginFailure', 'Too many login attempts. Please try again later.');
                }
                await context.redisClient.set(loginLimitKey, parseInt(loginAttempts) + 1, 'EX', 3600);

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

                // Fallback anomaly check if reCAPTCHA disabled
                if (process.env.ENABLE_RECAPTCHA !== 'true') {
                    const anomalies = [];
                    if (!clientData) anomalies.push('missing clientData');
                    else {
                        try {
                            if (clientData.timezone && !Intl.supportedValuesOf('timeZone').includes(clientData.timezone)) anomalies.push('invalid timezone');
                        } catch {}
                        if (clientData.screenResolution && !/^\d+x\d+$/.test(clientData.screenResolution)) anomalies.push('invalid resolution');
                    }
                    if (anomalies.length > 0) return socket.emit('loginFailure', 'Invalid client information. Please try again.');
                }

                // Verify wallet signature
                try {
                    const publicKey     = new PublicKey(walletAddress);
                    const signatureBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
                    const messageBytes   = new TextEncoder().encode(message);
                    const verified = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey.toBytes());
                    if (!verified) {
                        SecurityLogger.log('wallet_signature_invalid', { walletAddress, ip: clientIP });
                        trackFailedLogin(walletAddress, clientIP, { reason: 'invalid_signature' });
                        return socket.emit('loginFailure', 'Signature verification failed. Please try again.');
                    }
                } catch (error) {
                    logger.error('Wallet signature verification error:', error);
                    return socket.emit('loginFailure', 'Signature verification failed. Please try again.');
                }

                // Create/update user
                let user = await User.findOne({ walletAddress });
                if (!user) {
                    user = await User.create({ walletAddress, registrationIP: clientIP, registrationDate: new Date() });
                } else {
                    user.lastLoginDate = new Date(); user.lastLoginIP = clientIP;
                    await user.save();
                }

                socket.user = { walletAddress, socketId: socket.id };

                // Generate a one-time verify token for the HTTP login endpoint
                const { v4: uuidv4 } = require('uuid');
                const verifyToken = uuidv4();
                await context.redisClient.set(`verify:${walletAddress}`, verifyToken, 'EX', 300);

                SecurityLogger.loginSuccess(walletAddress, { sessionId: verifyToken, fingerprint: clientData?.userAgent }, socket.handshake);
                socket.emit('loginSuccess', { walletAddress, verifyToken, virtualBalance: user.virtualBalance || 0 });
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

        socket.on('connect', () => {
            if (socket.user?.walletAddress) socket.join(`wallet:${socket.user.walletAddress}`);
        });

        // ── Authenticated game events ──────────────────────────────────────────
        const gameEvents = [
            'joinGame', 'playerReady', 'joinPracticeGame', 'joinTournamentGame',
            'subscribe', 'joinHumanMatchmaking', 'joinBotGame', 'switchToBot',
            'matchFound', 'leaveRoom', 'requestBotRoom', 'requestBotGame', 'submitAnswer',
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

            // 2. Handle active game room
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
                    if (error.message.includes('not found') || error.message === 'Player not in room') { socket.roomId = null; return; }
                    throw error;
                }

                // Bot game forfeit
                if (room.roomMode === 'bot') {
                    const botPlayer = room.players.find(p => p.isBot);
                    if (botPlayer) {
                        await updatePlayerStats([
                            { username: disconnectedPlayer.username, score: disconnectedPlayer.score || 0, totalResponseTime: disconnectedPlayer.totalResponseTime || 0, isBot: false },
                            { username: botPlayer.username, score: botPlayer.score || 0, totalResponseTime: botPlayer.totalResponseTime || 0, isBot: true },
                        ], { winner: botPlayer.username, botOpponent: true, betAmount: room.betAmount });
                        io.to(roomId).emit('gameOverForfeit', { winner: botPlayer.username, disconnectedPlayer: disconnectedPlayer.username, betAmount: room.betAmount, botOpponent: true, message: `${disconnectedPlayer.username} left. ${botPlayer.username} wins.` });
                    }
                    await deleteGameRoom(roomId);
                    await redisClient.del(`room:${roomId}`);
                    await logGameRoomsState();
                    socket.roomId = null; return;
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
                    socket.roomId = null; return;
                }

                // Room empty
                if (room.players.length === 0) {
                    await deleteGameRoom(roomId);
                    await redisClient.del(`room:${roomId}`);
                    await logGameRoomsState();
                    socket.roomId = null; return;
                }

                if (!room.gameStarted) io.to(roomId).emit('playerLeft', disconnectedPlayer.username);
                socket.roomId = null;
            } catch (error) {
                logger.error('Error cleaning up game rooms', { socketId: socket.id, error: error.message });
                socket.roomId = null;
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
        const { walletAddress, gameMode = 'bot' } = data;
        const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        await rateLimitEvent(walletAddress, 'joinPracticeGame', clientIP, socket);

        if (await isBlockedFn(walletAddress) || await isBlockedFn(clientIP)) {
            socket.emit('joinGameFailure', 'Access denied'); return;
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
            trackValidationFailure(data?.walletAddress || socket.handshake.address, 'joinGame', error.message);
            socket.emit('joinGameFailure', 'Invalid input format'); return;
        }
        const { walletAddress, betAmount, transactionSignature, nonce, recaptchaToken } = data;
        const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
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
            const existingRoom = await getGameRoom(waitingRoomId);
            if (existingRoom && !existingRoom.gameStarted && existingRoom.players.length === 1) {
                existingRoom.players.push({ id: socket.id, username: walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false });
                existingRoom.roomMode = 'multiplayer';
                await updateGameRoom(waitingRoomId, existingRoom);
                await removeWaitingRoom(betAmount, waitingRoomId);
                socket.join(waitingRoomId); socket.roomId = waitingRoomId;
                io.to(waitingRoomId).emit('playerJoined', { players: existingRoom.players });
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

    // ── requestBotRoom ─────────────────────────────────────────────────────────
    if (event === 'requestBotRoom') {
        const { error } = requestBotRoomSchema.validate(data);
        if (error) { socket.emit('requestBotRoomFailure', 'Invalid input format'); return; }
        const { walletAddress, betAmount } = data;
        const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        await rateLimitEvent(walletAddress, 'requestBotRoom', clientIP, socket);

        const { generateRoomId } = require('../utils/helpers');
        const roomId = generateRoomId();
        const room   = await createGameRoom(roomId, betAmount, 'bot');
        room.players.push({ id: socket.id, username: walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false });
        await updateGameRoom(roomId, room);
        socket.join(roomId); socket.roomId = roomId;

        socket.emit('botRoomCreated', { roomId, betAmount });
        await logGameRoomsState();
        return;
    }

    // ── requestBotGame ─────────────────────────────────────────────────────────
    if (event === 'requestBotGame') {
        const { error } = requestBotGameSchema.validate(data);
        if (error) { socket.emit('gameError', 'Invalid room ID'); return; }
        await startSinglePlayerGame(data.roomId);
        return;
    }

    // ── submitAnswer ───────────────────────────────────────────────────────────
    if (event === 'submitAnswer') {
        const { error } = submitAnswerSchema.validate(data);
        if (error) {
            trackValidationFailure(socket.user?.walletAddress, 'submitAnswer', error.message);
            socket.emit('answerError', 'Invalid input format'); return;
        }
        const { roomId, questionId, answer } = data;
        const walletAddress = socket.user.walletAddress;
        const clientIP      = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        await rateLimitEvent(walletAddress, 'submitAnswer', clientIP, socket);

        const room = await getGameRoom(roomId);
        if (!room || room.isDeleted) { socket.emit('answerError', 'Room not found'); return; }

        const questionData = room.questionIdMap.get(questionId);
        if (!questionData) { socket.emit('answerError', 'Question not found'); return; }

        const player = room.players.find(p => p.username === walletAddress);
        if (!player || player.answered) { socket.emit('answerError', player?.answered ? 'Already answered' : 'Player not found'); return; }

        const isCorrect     = answer === questionData.shuffledCorrectAnswer;
        const responseTime  = Date.now() - (room.questionStartTime || Date.now());

        await atomicRoomUpdate(roomId, async (r) => {
            const p = r.players.find(pl => pl.username === walletAddress);
            if (p) {
                p.answered = true; p.lastAnswer = answer; p.lastResponseTime = responseTime;
                if (isCorrect) { p.score++; p.totalResponseTime = (p.totalResponseTime || 0) + responseTime; }
            }
            r.answersReceived++;
            return r;
        });

        io.to(roomId).emit('playerAnswered', { username: walletAddress, isBot: false, timedOut: false, responseTime });

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

        const room = await getGameRoom(roomId);
        if (!room) return;

        const playerIdx = room.players.findIndex(p => p.username === socket.user.walletAddress);
        if (playerIdx !== -1) {
            room.players.splice(playerIdx, 1);
            room.playerLeft = true;
        }
        await updateGameRoom(roomId, room);
        socket.leave(roomId); socket.roomId = null;
        io.to(roomId).emit('playerLeft', socket.user.walletAddress);
        await logGameRoomsState();
        return;
    }

    // ── switchToBot ────────────────────────────────────────────────────────────
    if (event === 'switchToBot') {
        const { error } = switchToBotSchema.validate(data);
        if (error) { socket.emit('gameError', 'Invalid room ID'); return; }
        const { roomId } = data;
        await rateLimitEvent(socket.user.walletAddress, 'switchToBot', null, socket);

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
        const { error } = requestBotRoomSchema.validate(data);
        if (error) { socket.emit('matchmakingError', 'Invalid input format'); return; }
        const { walletAddress, betAmount } = data;
        const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        await rateLimitEvent(walletAddress, 'joinHumanMatchmaking', clientIP, socket);

        const pool = await getMatchmakingPool(betAmount);
        const alreadyQueued = pool.some(p => p.walletAddress === walletAddress);
        if (alreadyQueued) { socket.emit('matchmakingError', 'Already in queue'); return; }

        await addToMatchmakingPool(betAmount, { walletAddress, socketId: socket.id, joinTime: Date.now() });
        socket.matchmakingPool = betAmount;

        const updatedPool = await getMatchmakingPool(betAmount);
        if (updatedPool.length >= 2) {
            const p1 = updatedPool[0]; const p2 = updatedPool[1];
            await removeFromMatchmakingPool(betAmount, p1.socketId);
            await removeFromMatchmakingPool(betAmount, p2.socketId);

            const { generateRoomId } = require('../utils/helpers');
            const roomId = generateRoomId();
            const room   = await createGameRoom(roomId, betAmount, 'human');
            room.players.push(
                { id: p1.socketId, username: p1.walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false },
                { id: p2.socketId, username: p2.walletAddress, score: 0, totalResponseTime: 0, answered: false, lastAnswer: null, lastResponseTime: null, isBot: false }
            );
            await updateGameRoom(roomId, room);

            const p1Socket = io.sockets.sockets.get(p1.socketId);
            const p2Socket = io.sockets.sockets.get(p2.socketId);
            if (p1Socket) { p1Socket.join(roomId); p1Socket.roomId = roomId; p1Socket.matchmakingPool = null; }
            if (p2Socket) { p2Socket.join(roomId); p2Socket.roomId = roomId; p2Socket.matchmakingPool = null; }

            io.to(p1.socketId).emit('matchFound', { roomId, opponent: p2.walletAddress, betAmount });
            io.to(p2.socketId).emit('matchFound', { roomId, opponent: p1.walletAddress, betAmount });

            await startGame(roomId);
        } else {
            socket.emit('waitingForMatch', { betAmount, position: updatedPool.length });
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

        const room = await getGameRoom(roomId);
        if (!room) { socket.emit('gameError', 'Room not found'); return; }

        const playerIdx = room.players.findIndex(p => p.username === socket.user.walletAddress);
        if (playerIdx !== -1) { room.players[playerIdx].ready = true; }
        await updateGameRoom(roomId, room);

        const allReady = room.players.filter(p => !p.isBot).every(p => p.ready);
        if (allReady && room.players.filter(p => !p.isBot).length >= 1) {
            await startGame(roomId);
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

module.exports = { registerSocketHandlers };