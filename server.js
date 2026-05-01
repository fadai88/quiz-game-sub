/**
 * server.js  —  Application entry point
 *
 * All heavy logic has been extracted into purpose-built modules:
 *
 *   config/constants.js           — ENVIRONMENT, GAME_MODES, COOKIE_OPTIONS
 *   config/schemas.js             — Joi validation schemas
 *   context.js                    — Shared singleton store (redisClient, io, ...)
 *   middleware/securityHeaders.js — OWASP security headers
 *   middleware/authenticate.js    — HTTP session auth / admin guard
 *   models/TransactionLog.js      — Replay-attack audit log
 *   models/GameSession.js         — Crash-recovery session record
 *   utils/sanitize.js             — Input / output / error sanitization
 *   utils/idempotency.js          — Redis-backed idempotency locks
 *   utils/helpers.js              — shuffleArray, generateRoomId, verifyRecaptcha
 *   services/redisService.js      — Redis init, rate-limiters, op wrappers
 *   services/roomManager.js       — Room CRUD, matchmaking helpers
 *   services/transactionVerifier.js — On-chain USDC verification
 *   services/botService.js        — TriviaBot class, name/difficulty pickers
 *   services/gameService.js       — startGame, question rounds, game over
 *   services/playerService.js     — Stats, refunds, active-room lookup
 *   services/rateLimitService.js  — Per-event + recaptcha rate limiting
 *   socket/index.js               — Socket.IO auth + all event handlers
 *   routes/auth.js                — /api/auth/*
 *   routes/balance.js             — /api/balance/*, /api/leaderboard, etc.
 *   routes/subscriptions.js       — /api/subscription/*
 *   routes/tournaments.js         — /api/tournaments/*, /api/admin/tournaments/*
 *   jobs/cronJobs.js              — Safety-net, subscription-expiry, tournament-start
 */

'use strict';

// ─── Core deps ────────────────────────────────────────────────────────────────
const express      = require('express');
const http         = require('http');
const https        = require('https');
const socketIo     = require('socket.io');
const mongoose     = require('mongoose');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
require('dotenv').config();

// ─── App config & shared state ────────────────────────────────────────────────
const { ENVIRONMENT }       = require('./config/constants');
const context               = require('./context');
const logger                = require('./logger');
const { authenticate, requireAdmin } = require('./middleware/authenticate');
const { getClientIpFromRequest }    = require('./middleware/trustedProxy');
const { httpRequestLogger, socketLogger, errorHandler } = require('./middleware/requestLogger');
const securityHeaders       = require('./middleware/securityHeaders');
const { getCachedTreasurySecretKey } = require('./aws-secrets-integration');
const { PublicKey, Connection, Keypair } = require('@solana/web3.js');

// ─── Services ─────────────────────────────────────────────────────────────────
const { initializeRedis, initializeSocketAdapter } = require('./services/redisService');
const PaymentProcessor    = require('./services/PaymentProcessor');
const SubscriptionService = require('./services/SubscriptionService');
const TournamentService   = require('./services/TournamentService');

// ─── Socket & routes ──────────────────────────────────────────────────────────
const { registerSocketHandlers, botDetector } = require('./socket/index');
const authRoutes          = require('./routes/auth');
const balanceRoutes       = require('./routes/balance');
const subscriptionRoutes  = require('./routes/subscriptions');
const { tournamentRouter, adminTournamentRouter } = require('./routes/tournaments');
const { registerCronJobs } = require('./jobs/cronJobs');
const { RateLimiterRedis, RateLimiterMemory } = require('rate-limiter-flexible');

// ─── Session secret ───────────────────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET && ENVIRONMENT === 'production') {
    console.error('❌ FATAL: SESSION_SECRET not set in production!');
    process.exit(1);
}

// ─── Express + Socket.IO setup ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000'];

const io = socketIo(server, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e6, // 1 MB — mitigates CVE-2023-32695
});
io.use(socketLogger);
context.set('io', io);

// ─── Middleware stack ─────────────────────────────────────────────────────────
app.use(securityHeaders);
app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true }));
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));
app.use(httpRequestLogger);

// ─── HTML templates — read once at startup, inject nonce per request ─────────
const recaptchaEnabled = process.env.ENABLE_RECAPTCHA === 'true';
const safeSiteKey      = (process.env.RECAPTCHA_SITE_KEY || '').replace(/[^a-zA-Z0-9_\-]/g, '');
const gameHtmlTemplate  = fs.readFileSync(path.join(__dirname, 'public', 'game.html'),  'utf8')
    .replace(/YOUR_SITE_KEY/g, safeSiteKey);
const loginHtmlTemplate = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8')
    .replace(/YOUR_SITE_KEY/g, safeSiteKey);

app.get('/game.html', (req, res) => {
    const nonce = res.locals.cspNonce;
    res.send(gameHtmlTemplate.replace('</head>', `<script nonce="${nonce}">
        window.recaptchaEnabled = ${recaptchaEnabled};
        window.recaptchaSiteKey = "${safeSiteKey}";
    </script></head>`));
});
app.get('/login.html', (req, res) => {
    const nonce = res.locals.cspNonce;
    res.send(loginHtmlTemplate.replace('</head>', `<script nonce="${nonce}">
        window.recaptchaEnabled = ${recaptchaEnabled};
        window.recaptchaSiteKey = "${safeSiteKey}";
    </script></head>`));
});
app.get('/admin-tournaments.html', authenticate, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-tournaments.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── HTTP rate limiting ───────────────────────────────────────────────────────
// Built lazily so the limiter is created after Redis is ready.
let _httpLimiter = null;
function getHttpLimiter() {
    if (_httpLimiter) return _httpLimiter;
    const client = context.redisClient;
    _httpLimiter = client
        ? new RateLimiterRedis({ storeClient: client, points: 60, duration: 60, keyPrefix: 'http' })
        : new RateLimiterMemory({ points: 60, duration: 60 });
    return _httpLimiter;
}

async function httpRateLimit(req, res, next) {
    try {
        await getHttpLimiter().consume(req.ip);
        next();
    } catch {
        res.status(429).json({ success: false, error: 'Too many requests. Please slow down.' });
    }
}

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',         httpRateLimit, authRoutes);
app.use('/api',              httpRateLimit, balanceRoutes);
app.use('/api/subscription', httpRateLimit, subscriptionRoutes);
app.use('/api/tournaments',       httpRateLimit, tournamentRouter);
app.use('/api/admin/tournaments', httpRateLimit, adminTournamentRouter);

// ─── Admin honeypot ───────────────────────────────────────────────────────────
// Log only — do NOT auto-block. Auto-blocking on a single GET lets an attacker
// DoS legitimate users by spoofing their IP in a request to this path.
app.get('/admin', (req, res) => {
    const clientIP = getClientIpFromRequest(req);
    logger.warn(`Admin honeypot accessed from ${clientIP}`);
    res.redirect('/');
});

app.use(errorHandler);
io.engine.on('connection_error', (err) => logger.error('Socket.IO connection error:', err));

// ─── MongoDB ──────────────────────────────────────────────────────────────────
const mongooseOptions = {
    ...(ENVIRONMENT === 'production' && { tls: true, tlsAllowInvalidCertificates: false }),
    serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000,
    retryWrites: true, w: 'majority',
};
mongoose.connect(process.env.MONGODB_URI, mongooseOptions)
    .then(() => console.log('✅ MongoDB connected successfully'))
    .catch(err => { console.error('❌ FATAL: MongoDB connection failed:', err.message); process.exit(1); });

mongoose.connection.on('error',        err  => console.error('❌ MongoDB runtime error:', err.message));
mongoose.connection.on('disconnected', ()   => console.warn('⚠️  MongoDB disconnected'));
mongoose.connection.on('reconnected',  ()   => console.log('✅ MongoDB reconnected'));

// ─── Config initialisation (AWS Secrets + services) ──────────────────────────
async function initializeConfig() {
    console.log('🔐 Initializing config with AWS Secrets Manager...');
    if (!process.env.TREASURY_WALLET_ADDRESS) throw new Error('TREASURY_WALLET_ADDRESS not set');
    if (!process.env.SOLANA_RPC_URL)          throw new Error('SOLANA_RPC_URL not set');

    const secretString = await getCachedTreasurySecretKey();
    const secretKey    = JSON.parse(secretString);

    const cfg = {
        USDC_MINT:        new PublicKey(process.env.USDC_MINT_ADDRESS || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        TREASURY_WALLET:  new PublicKey(process.env.TREASURY_WALLET_ADDRESS),
        TREASURY_KEYPAIR: Keypair.fromSecretKey(Buffer.from(secretKey)),
        connection:       new Connection(process.env.SOLANA_RPC_URL, 'confirmed'),
        rpcEndpoints:     [process.env.SOLANA_RPC_URL],
        io,
    };
    context.set('config', cfg);
    console.log('✅ Config initialized successfully');
    return cfg;
}

// Init services once DB is connected
mongoose.connection.once('open', async () => {
    try {
        const cfg = await initializeConfig();

        const paymentProcessor = new PaymentProcessor(cfg);
        paymentProcessor.startProcessing(60000);
        context.set('paymentProcessor', paymentProcessor);
        console.log('✅ PaymentProcessor initialized');

        const serviceConfig = {
            SOLANA_RPC_URL:              process.env.SOLANA_RPC_URL,
            TREASURY_WALLET:             process.env.TREASURY_WALLET_ADDRESS,
            USDC_MINT:                   process.env.USDC_MINT_ADDRESS,
            MONTHLY_SUBSCRIPTION_PRICE: parseFloat(process.env.MONTHLY_SUBSCRIPTION_PRICE) || 15,
            YEARLY_SUBSCRIPTION_PRICE:  parseFloat(process.env.YEARLY_SUBSCRIPTION_PRICE)  || 150,
        };
        context.set('subscriptionService', new SubscriptionService(serviceConfig));
        context.set('tournamentService',   new TournamentService(serviceConfig));
        logger.info('✅ Subscription and Tournament services initialized');
    } catch (error) {
        logger.error('❌ FATAL: Service initialization failed:', { error });
        process.exit(1);
    }
});

// ─── Server startup ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

async function startServer() {
    try {
        await initializeRedis();

        // Delay adapter init slightly so redisClient is ready
        setTimeout(() => initializeSocketAdapter().catch(console.error), 1000);

        // Register all Socket.IO handlers
        registerSocketHandlers(io);

        server.listen(PORT, () => {
            logger.info(`🚀 Server is running on port ${PORT}`);
            registerCronJobs(botDetector);
        });
    } catch (error) {
        logger.error('❌ Failed to start server:', { error });
        process.exit(1);
    }
}

startServer();

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const { abortGameWithRefund } = require('./services/gameService');
const { getCleanActiveRooms } = require('./services/roomManager');

async function gracefulShutdown(signal) {
    console.log(`\n📡 Received ${signal}, shutting down gracefully...`);
    try {
        const activeRoomIds = await getCleanActiveRooms();
        for (const roomId of activeRoomIds) {
            await abortGameWithRefund(roomId, `Server Restart/Shutdown (${signal})`);
            io.to(roomId).emit('gameError', 'Server restarting. Game cancelled and funds refunded.');
        }
        console.log(`✅ Refunded ${activeRoomIds.length} active games.`);
    } catch (err) {
        console.error('⚠️ Error during shutdown refunds:', err);
    }

    if (server) await new Promise(r => server.close(r));
    if (io)     await new Promise(r => io.close(r));
    if (mongoose.connection) await mongoose.connection.close();
    if (context.redisClient) await context.redisClient.quit();
    await require('./logger').gracefulShutdown(signal);
}

process.on('SIGTERM',              () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',               () => gracefulShutdown('SIGINT'));
process.on('uncaughtException',    (err) => { console.error('❌ Uncaught Exception:', err); gracefulShutdown('UNCAUGHT_EXCEPTION'); });
process.on('unhandledRejection',   (reason) => { console.error('❌ Unhandled Rejection:', reason); gracefulShutdown('UNHANDLED_REJECTION'); });