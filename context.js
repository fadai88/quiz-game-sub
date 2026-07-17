/**
 * context.js
 * Shared application-level singletons (redisClient, io, config, services).
 * Modules call context.get() to access these after they are initialised.
 * Server bootstrapping calls context.set() once each singleton is ready.
 */

const state = {
    redisClient: null,
    io: null,
    config: null,
    paymentProcessor: null,
    subscriptionService: null,
    tournamentService: null,
    // Shared via context so gameService can consult it at payout time without
    // requiring socket/index.js (which already requires gameService).
    botDetector: null,
};

module.exports = {
    set(key, value) { state[key] = value; },
    get(key) { return state[key]; },
    // Convenience getters used throughout the codebase
    get redisClient() { return state.redisClient; },
    get io()          { return state.io; },
    get config()      { return state.config; },
    get paymentProcessor()    { return state.paymentProcessor; },
    get subscriptionService() { return state.subscriptionService; },
    get tournamentService()   { return state.tournamentService; },
    get botDetector()         { return state.botDetector; },
};