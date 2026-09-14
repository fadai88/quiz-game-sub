/**
 * services/roomManager.js
 * Redis-backed game room CRUD, atomic updates, and matchmaking pool helpers.
 */

const mongoose = require("mongoose");
const logger = require("../logger");
const context = require("../context");
const { criticalRedisOp } = require("./redisService");
const { raceConditionMetrics } = require("../utils/idempotency");

// ─── Active room tracking ─────────────────────────────────────────────────────

async function getCleanActiveRooms() {
  const redisClient = context.redisClient;
  try {
    const roomIds = await redisClient.smembers("active:rooms");
    if (roomIds.length === 0) return [];

    const pipeline = redisClient.pipeline();
    for (const id of roomIds) pipeline.exists(`room:${id}`);
    const results = await pipeline.exec();

    const cleanupPipeline = redisClient.pipeline();
    const validRooms = [];

    roomIds.forEach((id, i) => {
      if (results[i][1] === 1) {
        validRooms.push(id);
      } else {
        cleanupPipeline.srem("active:rooms", id);
      }
    });

    if (cleanupPipeline.length > 0) {
      await cleanupPipeline.exec();
      logger.info(
        `🧹 Cleaned up ${roomIds.length - validRooms.length} zombie room IDs`
      );
    }
    return validRooms;
  } catch (error) {
    logger.error("Error getting/cleaning active rooms:", { error });
    return [];
  }
}

// ─── Matchmaking pool tracking ────────────────────────────────────────────────

// The wallet addresses waiting at a given stake, derived from the queue list
// itself (the source of truth). An earlier implementation kept a parallel
// wallet-keyed Redis SET, but nothing pruned it by socket liveness, so it leaked
// orphaned wallets across restarts and showed phantom "N players waiting" counts.
// Reading straight from the list can never drift from the real queue.
async function getMatchmakingPoolWallets(betAmount) {
  const pool = await getMatchmakingPool(betAmount);
  return [...new Set(pool.map((p) => p.walletAddress))];
}

async function getAllMatchmakingPools() {
  const validBets = [3, 10, 15, 20, 30];
  const pools = {};
  for (const bet of validBets) {
    const wallets = await getMatchmakingPoolWallets(bet);
    if (wallets.length > 0) pools[bet] = wallets;
  }
  return pools;
}

// ─── Waiting room index ───────────────────────────────────────────────────────

async function addWaitingRoom(betAmount, roomId) {
  try {
    await context.redisClient.zadd(
      `waiting_rooms:${betAmount}`,
      Date.now(),
      roomId
    );
    await context.redisClient.expire(`waiting_rooms:${betAmount}`, 3600);
    logger.info(`Added room ${roomId} to waiting index for bet ${betAmount}`);
    return true;
  } catch (error) {
    console.error(`Error adding waiting room ${roomId}:`, error);
    return false;
  }
}

async function getWaitingRoom(betAmount) {
  try {
    const ids = await context.redisClient.zrange(
      `waiting_rooms:${betAmount}`,
      0,
      0
    );
    return ids.length > 0 ? ids[0] : null;
  } catch (error) {
    console.error(`Error getting waiting room for bet ${betAmount}:`, error);
    return null;
  }
}

async function removeWaitingRoom(betAmount, roomId) {
  try {
    await context.redisClient.zrem(`waiting_rooms:${betAmount}`, roomId);
    logger.info(
      `Removed room ${roomId} from waiting index for bet ${betAmount}`
    );
  } catch (error) {
    console.error(`Error removing waiting room ${roomId}:`, error);
  }
}

// ─── Room CRUD ────────────────────────────────────────────────────────────────

async function createGameRoom(
  roomId,
  betAmount,
  roomMode = "waiting",
  options = {}
) {
  const room = {
    players: [],
    betAmount,
    questions: [],
    questionIdMap: new Map(),
    currentQuestionIndex: -1,
    answersReceived: 0,
    gameStarted: false,
    roomMode,
    waitingTimeout: null,
    questionTimeout: null,
    playerLeft: false,
    hasBot: false,
    questionStartTime: null,
    roundStartTime: null,
    disconnectGracePeriod: false,
    isDeleted: false,
    gameMode: options.gameMode || "practice",
    tournamentId: options.tournamentId || "",
    matchId: options.matchId || "",
    isPractice: options.isPractice !== undefined ? options.isPractice : true,
  };

  await criticalRedisOp(async () => {
    const multi = context.redisClient.multi();
    multi.hset(`room:${roomId}`, {
      players: JSON.stringify(room.players),
      questions: JSON.stringify(room.questions),
      questionIdMap: JSON.stringify([]),
      betAmount: betAmount.toString(),
      currentQuestionIndex: room.currentQuestionIndex.toString(),
      answersReceived: room.answersReceived.toString(),
      gameStarted: room.gameStarted.toString(),
      roomMode: roomMode || "",
      hasBot: room.hasBot.toString(),
      playerLeft: room.playerLeft.toString(),
      questionStartTime: "",
      roundStartTime: "",
      disconnectGracePeriod: room.disconnectGracePeriod.toString(),
      isDeleted: room.isDeleted.toString(),
      gameMode: room.gameMode,
      tournamentId: room.tournamentId,
      matchId: room.matchId || "",
      isPractice: room.isPractice.toString(),
    });
    multi.expire(`room:${roomId}`, 3600);
    multi.sadd("active:rooms", roomId);
    await multi.exec();
    logger.info(
      `Created & tracked room ${roomId} in Redis with bet ${betAmount}`
    );
  }, `Create game room ${roomId}`);

  return room;
}

async function getGameRoom(roomId) {
  return await criticalRedisOp(async () => {
    const roomData = await context.redisClient.hgetall(`room:${roomId}`);
    if (!roomData || Object.keys(roomData).length === 0) return null;

    const questions = JSON.parse(roomData.questions || "[]").map((q) => ({
      ...q,
      _id: q._id ? new mongoose.Types.ObjectId(q._id) : null,
      shuffledOptions: q.shuffledOptions || [],
      shuffledCorrectAnswer: q.shuffledCorrectAnswer ?? -1,
    }));

    let questionIdMap = new Map();
    try {
      const mapData = JSON.parse(roomData.questionIdMap || "[]");
      const hydrateEntry = (val) => ({
        ...val,
        _id: val._id ? new mongoose.Types.ObjectId(val._id) : null,
        shuffledOptions: val.shuffledOptions || [],
        shuffledCorrectAnswer: val.shuffledCorrectAnswer ?? -1,
      });

      if (Array.isArray(mapData)) {
        questionIdMap = new Map(
          mapData.map((item) => [item.key, hydrateEntry(item.value)])
        );
      } else if (typeof mapData === "object" && mapData !== null) {
        logger.warn(
          `Room ${roomId} using legacy questionIdMap format - converting`
        );
        questionIdMap = new Map(
          Object.entries(mapData).map(([k, v]) => [k, hydrateEntry(v)])
        );
      }
    } catch (parseError) {
      console.error(
        `Error parsing questionIdMap for room ${roomId}:`,
        parseError
      );
    }

    return {
      players: JSON.parse(roomData.players || "[]"),
      betAmount: parseInt(roomData.betAmount) || 0,
      questions,
      questionIdMap,
      currentQuestionIndex:
        roomData.currentQuestionIndex !== undefined
          ? parseInt(roomData.currentQuestionIndex)
          : -1,
      answersReceived: parseInt(roomData.answersReceived) || 0,
      suddenDeathRounds: parseInt(roomData.suddenDeathRounds) || 0,
      gameStarted: roomData.gameStarted === "true",
      roomMode: roomData.roomMode || null,
      hasBot: roomData.hasBot === "true",
      playerLeft: roomData.playerLeft === "true",
      questionStartTime: roomData.questionStartTime
        ? parseInt(roomData.questionStartTime)
        : null,
      roundStartTime: roomData.roundStartTime
        ? parseInt(roomData.roundStartTime)
        : null,
      questionTimeout: null,
      waitingTimeout: null,
      disconnectGracePeriod: roomData.disconnectGracePeriod === "true",
      isDeleted: roomData.isDeleted === "true",
      gameMode: roomData.gameMode || "practice",
      tournamentId: roomData.tournamentId || "",
      matchId: roomData.matchId || "",
      isPractice: roomData.isPractice !== "false",
    };
  }, `Get game room ${roomId}`);
}

function _serializeRoom(room) {
  const serializedQuestions = room.questions.map((q) => ({
    tempId: q.tempId,
    _id: q._id ? q._id.toString() : null,
    question: q.question,
    options: q.options,
    correctAnswer: q.correctAnswer,
    shuffledOptions: q.shuffledOptions || [],
    shuffledCorrectAnswer: q.shuffledCorrectAnswer ?? -1,
  }));

  const serializedMap = Array.from(room.questionIdMap.entries()).map(
    ([key, val]) => ({
      key,
      value: {
        tempId: val.tempId,
        _id: val._id ? val._id.toString() : null,
        question: val.question,
        options: val.options,
        correctAnswer: val.correctAnswer,
        shuffledOptions: val.shuffledOptions || [],
        shuffledCorrectAnswer: val.shuffledCorrectAnswer ?? -1,
      },
    })
  );

  return {
    players: JSON.stringify(room.players),
    questions: JSON.stringify(serializedQuestions),
    questionIdMap: JSON.stringify(serializedMap),
    betAmount: room.betAmount.toString(),
    currentQuestionIndex: room.currentQuestionIndex.toString(),
    answersReceived: room.answersReceived.toString(),
    suddenDeathRounds: (room.suddenDeathRounds || 0).toString(),
    gameStarted: room.gameStarted.toString(),
    roomMode: room.roomMode || "",
    hasBot: room.hasBot.toString(),
    playerLeft: room.playerLeft.toString(),
    questionStartTime: room.questionStartTime
      ? room.questionStartTime.toString()
      : "",
    roundStartTime: room.roundStartTime ? room.roundStartTime.toString() : "",
    disconnectGracePeriod: (room.disconnectGracePeriod === true).toString(),
    isDeleted: room.isDeleted.toString(),
    gameMode: room.gameMode || "practice",
    tournamentId: room.tournamentId || "",
    matchId: room.matchId || "",
    isPractice: (room.isPractice !== undefined
      ? room.isPractice
      : true
    ).toString(),
  };
}

async function updateGameRoom(roomId, room) {
  try {
    if (room.isDeleted) {
      logger.info(`Room ${roomId} is marked as deleted, skipping update`);
      return;
    }
    const multi = context.redisClient.multi();
    multi.hset(`room:${roomId}`, _serializeRoom(room));
    multi.expire(`room:${roomId}`, 3600);
    await multi.exec();
    logger.info(`Updated room ${roomId} in Redis`);
  } catch (error) {
    console.error(`Error updating room ${roomId} in Redis:`, error);
    throw error;
  }
}

async function atomicRoomUpdate(roomId, updateFn, maxRetries = 5) {
  raceConditionMetrics.totalAttempts++;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      await context.redisClient.watch(`room:${roomId}`);
      const room = await getGameRoom(roomId);
      if (!room) {
        await context.redisClient.unwatch();
        throw new Error(`Room ${roomId} not found`);
      }

      const updatedRoom = await updateFn(room);
      const multi = context.redisClient.multi();
      multi.hset(`room:${roomId}`, _serializeRoom(updatedRoom));
      multi.expire(`room:${roomId}`, 3600);
      const results = await multi.exec();

      if (results === null) {
        retries++;
        raceConditionMetrics.totalRetries++;
        logger.warn(
          `Race condition detected in room ${roomId}, retry ${retries}/${maxRetries}`
        );
        await new Promise((r) =>
          setTimeout(r, Math.random() * Math.pow(2, retries) * 10)
        );
        continue;
      }

      if (retries > 0)
        logger.info(
          `Atomic update succeeded for room ${roomId} (retries: ${retries})`
        );
      return updatedRoom;
    } catch (error) {
      await context.redisClient.unwatch();
      if (error.message.includes("not found")) {
        logger.info(
          `atomicRoomUpdate: room ${roomId} already deleted, skipping`
        );
      } else {
        logger.error(`Error in atomicRoomUpdate for room ${roomId}:`, error);
      }
      throw error;
    }
  }

  raceConditionMetrics.maxRetriesExceeded++;
  const err = new Error(
    `Max retries (${maxRetries}) exceeded for room ${roomId} - severe race condition`
  );
  logger.error(err.message);
  throw err;
}

async function deleteGameRoom(roomId) {
  try {
    const room = await getGameRoom(roomId);
    if (room?.questionTimeout) clearTimeout(room.questionTimeout);

    const multi = context.redisClient.multi();
    multi.del(`room:${roomId}`);
    multi.srem("active:rooms", roomId);
    if (room?.betAmount && room.roomMode === "human") {
      multi.zrem(`waiting_rooms:${room.betAmount}`, roomId);
      logger.info(`Queued removal from waiting_rooms:${room.betAmount}`);
    }
    await multi.exec();
    logger.info(`Deleted room ${roomId} and cleaned up tracking sets`);
  } catch (error) {
    console.error(`Error deleting room ${roomId} from Redis:`, error);
    throw error;
  }
}

// ─── Matchmaking pool (list-based) ───────────────────────────────────────────

async function addToMatchmakingPool(betAmount, playerData) {
  try {
    await context.redisClient.lpush(
      `matchmaking:human:${betAmount}`,
      JSON.stringify(playerData)
    );
    logger.info(
      `Added player ${playerData.walletAddress} to matchmaking pool for ${betAmount}`
    );
    return true;
  } catch (error) {
    console.error(`Error adding to matchmaking pool for ${betAmount}:`, error);
    throw error;
  }
}

/**
 * Take the two players at the head of the pool, or take nobody at all.
 *
 * Matchmaking needs a pair, so a pair is what has to be claimed atomically. The
 * obvious cheaper version — pop one, pop another — is wrong in a way that only
 * shows up under load: with several handlers popping at once they each end up
 * holding one player, every one of them then sees an empty queue, and they all
 * put their player back and give up. Forty players, nobody matched, no error
 * anywhere. Everyone picks up one chopstick and nobody eats.
 *
 * A two-line Lua script removes the possibility. Redis runs it as a single
 * atomic step, so the outcome is either two players (ours alone — no other
 * caller can see them) or an untouched queue. There is no state in which a
 * caller holds one player and has to decide what to do about it.
 *
 * Returns [first, second] following the existing head-first order, or null when
 * fewer than two are queued. The caller owns what it gets and must put back
 * anyone it cannot use.
 */
const CLAIM_PAIR_LUA = `
local first = redis.call('LPOP', KEYS[1])
if not first then return nil end
local second = redis.call('LPOP', KEYS[1])
if not second then
  redis.call('LPUSH', KEYS[1], first)
  return nil
end
return {first, second}
`;

async function claimTwoFromMatchmakingPool(betAmount) {
  try {
    const claimed = await context.redisClient.eval(
      CLAIM_PAIR_LUA,
      1,
      `matchmaking:human:${betAmount}`
    );
    if (!claimed || claimed.length < 2) return null;
    return [JSON.parse(claimed[0]), JSON.parse(claimed[1])];
  } catch (error) {
    logger.error(`Error claiming a pair from pool ${betAmount}:`, error);
    return null;
  }
}

/**
 * Take a player out of the pool, and report whether THIS caller is the one that
 * took them.
 *
 * That second half is the important half. Matchmaking reads the pool, picks the
 * first two entries and removes them, which is a read-modify-write with an await
 * in the middle: several joins arriving together all read the same pool and all
 * pick the same two players. Something has to decide which handler actually gets
 * them, and `LREM` already does — it is atomic, and its reply is the number of
 * elements it removed, so for a given entry exactly one concurrent caller can be
 * told 1 and the rest are told 0.
 *
 * This used to throw that number away and return the player data either way, so
 * every racing handler believed it had won and built a room. Eight simultaneous
 * joins produced eight rooms for the same pair; see docs/LOAD_TESTING.md.
 *
 * Returns the player data only when this call is the one that removed them, and
 * null when the entry was already gone — whether because a competing handler
 * claimed them a moment ago or because they were never queued. Callers must
 * treat null as "not mine to use" rather than as an error: for the disconnect
 * path it means the player was already matched and must not be refunded as a
 * queue-leaver, and for matchmaking it means the pairing belongs to someone else.
 */
async function removeFromMatchmakingPool(betAmount, socketId) {
  try {
    const pool =
      (await context.redisClient.lrange(
        `matchmaking:human:${betAmount}`,
        0,
        -1
      )) || [];
    const playerIndex = pool.findIndex((p) => {
      try {
        return JSON.parse(p)?.socketId === socketId;
      } catch {
        return false;
      }
    });

    if (playerIndex === -1) {
      logger.info(
        `Player with socketId ${socketId} not found in matchmaking pool for ${betAmount}`
      );
      return null;
    }

    const removedCount = await context.redisClient.lrem(
      `matchmaking:human:${betAmount}`,
      1,
      pool[playerIndex]
    );
    if (!removedCount) {
      // Another handler removed this exact entry between the read above and the
      // LREM. It owns the player now; we must not also act on them.
      logger.info(
        `[matchmaking] Lost the claim on socketId ${socketId} for ${betAmount} — already taken`
      );
      return null;
    }
    const playerData = JSON.parse(pool[playerIndex]);
    logger.info(
      `Removed player with socketId ${socketId} from matchmaking pool for ${betAmount}`
    );
    return playerData;
  } catch (error) {
    console.error(
      `Error removing from matchmaking pool for ${betAmount}:`,
      error
    );
    return null;
  }
}

async function getMatchmakingPool(betAmount) {
  try {
    const pool = await context.redisClient.lrange(
      `matchmaking:human:${betAmount}`,
      0,
      -1
    );
    return pool.map((p) => JSON.parse(p));
  } catch (error) {
    console.error(`Error fetching matchmaking pool for ${betAmount}:`, error);
    return [];
  }
}

// ─── Debug helpers ────────────────────────────────────────────────────────────

async function logGameRoomsState() {
  console.log("Current game rooms state:");
  const roomIds = await getCleanActiveRooms();
  logger.info(`Total rooms: ${roomIds.length}`);
  for (const id of roomIds) {
    const room = await getGameRoom(id);
    if (!room) continue;
    logger.info(`Room ID: ${id}`);
    logger.info(
      `  Mode: ${room.roomMode}, Started: ${room.gameStarted}, Bet: ${room.betAmount}`
    );
    room.players.forEach((p) =>
      logger.info(`    - ${p.username}${p.isBot ? " (BOT)" : ""}`)
    );
  }
}

async function logMatchmakingState() {
  console.log("Current Matchmaking State:");
  const pools = await getAllMatchmakingPools();
  for (const [betAmount, wallets] of Object.entries(pools)) {
    logger.info(`  Bet Amount ${betAmount}: ${wallets.length} players waiting`);
    const pool = await getMatchmakingPool(betAmount);
    if (pool.length > 0) {
      const byWallet = new Map(pool.map((p) => [p.walletAddress, p]));
      for (const wallet of wallets) {
        const player = byWallet.get(wallet);
        if (player) {
          const waitTime = Math.round((Date.now() - player.joinTime) / 1000);
          logger.info(`    - ${wallet} (waiting for ${waitTime}s)`);
        }
      }
    }
  }
}

module.exports = {
  getCleanActiveRooms,
  getMatchmakingPoolWallets,
  getAllMatchmakingPools,
  addWaitingRoom,
  getWaitingRoom,
  removeWaitingRoom,
  createGameRoom,
  getGameRoom,
  updateGameRoom,
  atomicRoomUpdate,
  deleteGameRoom,
  addToMatchmakingPool,
  claimTwoFromMatchmakingPool,
  removeFromMatchmakingPool,
  getMatchmakingPool,
  logGameRoomsState,
  logMatchmakingState,
};
