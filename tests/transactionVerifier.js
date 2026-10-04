"use strict";

/**
 * Stake verification — services/transactionVerifier.js.
 *
 * This decides whether a stake counts as paid, so every check in it is a way
 * money can be faked: a replayed signature, a reused nonce, a transfer signed by
 * someone else, the wrong token, the wrong amount, a payment to the wrong wallet,
 * a memo bound to a different request, or a stale transaction. Each test builds
 * a transaction that breaks exactly one rule and checks that it is rejected.
 * The happy path is checked first, so every rejection is the rule under test
 * firing, not the fixture being broken.
 *
 * The retry rules matter just as much. A failure must not burn the signature or
 * the nonce: the stake may already be in the treasury, and the client's retry
 * reuses both. Only a fully verified transaction makes a resubmission a replay.
 *
 * No network. The Solana connection is a fake that serves the transaction each
 * test builds, Redis is an in-memory map, and TransactionLog is an in-memory
 * store that reproduces the conditional updates utils/txReplayGuard.js relies
 * on (including the duplicate-key error on a second insert).
 */

const { expect } = require("chai");
const sinon = require("sinon");
const bs58 = require("bs58").default;
const { Keypair } = require("@solana/web3.js");

const context = require("../context");
const TransactionLog = require("../models/TransactionLog");
const { STALE_PENDING_MS } = require("../utils/txReplayGuard");
const {
  verifyAndValidateTransaction,
} = require("../services/transactionVerifier");

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC = Keypair.generate().publicKey.toBase58();
const OTHER_MINT = Keypair.generate().publicKey.toBase58();
const SENDER = Keypair.generate().publicKey.toBase58();
const TREASURY = Keypair.generate().publicKey.toBase58();
const STRANGER = Keypair.generate().publicKey.toBase58();
const STAKE = 10_000_000; // 10 USDC in atomic units

const key = (b58) => ({ toBase58: () => b58, toString: () => b58 });

/**
 * A confirmed USDC stake transfer, valid in every respect. Overrides break one
 * thing at a time.
 */
function stakeTx({
  amount = STAKE,
  mint = USDC,
  recipient = TREASURY,
  signer = SENDER,
  senderIsSigner = true,
  memo = "nonce-1",
  includeMemo = true,
  blockTime = Math.floor(Date.now() / 1000) - 5,
  err = null,
} = {}) {
  // Account order: signers first, as on-chain. A non-signing sender is placed
  // after the single required signature.
  const accountKeys = senderIsSigner
    ? [key(signer), key(TOKEN_PROGRAM_ID), key(MEMO_PROGRAM_ID)]
    : [key(STRANGER), key(signer), key(TOKEN_PROGRAM_ID), key(MEMO_PROGRAM_ID)];
  const memoIndex = accountKeys.length - 1;
  const instructions = [{ programIdIndex: memoIndex - 1, data: "" }];
  if (includeMemo)
    instructions.push({
      programIdIndex: memoIndex,
      data: bs58.encode(Buffer.from(`quiz-stake:${memo}`)),
    });
  return {
    blockTime,
    meta: {
      err,
      preTokenBalances: [
        { owner: recipient, mint, uiTokenAmount: { amount: "500000000" } },
      ],
      postTokenBalances: [
        {
          owner: recipient,
          mint,
          uiTokenAmount: { amount: String(500_000_000 + amount) },
        },
      ],
    },
    transaction: {
      message: {
        accountKeys,
        header: { numRequiredSignatures: 1 },
        instructions,
      },
    },
  };
}

// ── In-memory TransactionLog with the semantics txReplayGuard depends on ─────
function fakeTransactionLog() {
  const rows = new Map();
  const matches = (row, filter) => {
    if (filter.signature && row.signature !== filter.signature) return false;
    if (!filter.$or) return true;
    return filter.$or.some(
      (c) =>
        row.status === c.status &&
        (!c.verifiedAt || row.verifiedAt <= c.verifiedAt.$lte)
    );
  };
  return {
    rows,
    findOneAndUpdate: async (filter, update) => {
      const row = rows.get(filter.signature);
      if (!row || !matches(row, filter)) return null;
      Object.assign(row, update.$set || update);
      return { ...row };
    },
    create: async (doc) => {
      if (rows.has(doc.signature)) {
        const e = new Error("E11000 duplicate key");
        e.code = 11000;
        throw e;
      }
      rows.set(doc.signature, { ...doc });
      return doc;
    },
    findOne: (filter) => {
      const row = rows.get(filter.signature);
      const result = row ? { ...row } : null;
      return { select: () => ({ lean: async () => result }) };
    },
  };
}

function fakeRedis() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => {
      m.set(k, v);
      return "OK";
    },
  };
}

describe("transactionVerifier — stake verification", () => {
  let log;
  let redis;
  let served; // the transaction the fake chain returns
  let confirmation; // the confirmation status it reports
  let prev;

  beforeEach(() => {
    prev = { config: context.get("config"), redis: context.get("redisClient") };
    log = fakeTransactionLog();
    redis = fakeRedis();
    served = stakeTx();
    confirmation = "confirmed";
    sinon
      .stub(TransactionLog, "findOneAndUpdate")
      .callsFake(log.findOneAndUpdate);
    sinon.stub(TransactionLog, "create").callsFake(log.create);
    sinon.stub(TransactionLog, "findOne").callsFake(log.findOne);
    context.set("redisClient", redis);
    context.set("config", {
      USDC_MINT: key(USDC),
      connection: {
        getSignatureStatuses: async () => ({
          value: [
            served === null
              ? null
              : {
                  confirmationStatus: confirmation,
                  err: served.meta.err,
                },
          ],
        }),
        getTransaction: async () => served,
      },
    });
  });

  afterEach(() => {
    sinon.restore();
    context.set("config", prev.config);
    context.set("redisClient", prev.redis);
  });

  // One attempt, no delay: the retry loop is not what is under test.
  const verify = (sig = "sig-1", { amount = STAKE, nonce = "nonce-1" } = {}) =>
    verifyAndValidateTransaction(sig, amount, SENDER, TREASURY, nonce, 1, 0);

  async function rejects(promise, pattern) {
    let err;
    try {
      await promise;
    } catch (e) {
      err = e;
    }
    expect(err, "expected the stake to be rejected").to.be.an("error");
    expect(err.message).to.match(pattern);
    return err;
  }

  describe("a valid stake", () => {
    it("is accepted, and only then burns the signature and the nonce", async () => {
      const tx = await verify();
      expect(tx).to.equal(served);
      expect(log.rows.get("sig-1").status).to.equal("verified");
      expect(redis.m.get("nonce:nonce-1")).to.equal("used");
      expect(redis.m.get("tx:sig-1")).to.equal("1");
    });

    it("accepts a finalized transaction as well as a confirmed one", async () => {
      confirmation = "finalized";
      await verify();
      expect(log.rows.get("sig-1").status).to.equal("verified");
    });
  });

  describe("replays and duplicates", () => {
    it("rejects resubmitting a signature that was already verified", async () => {
      await verify();
      await rejects(
        verify("sig-1", { nonce: "nonce-2" }),
        /replay attack prevented/
      );
    });

    it("rejects a second submission while the first is still in flight", async () => {
      log.rows.set("sig-1", {
        signature: "sig-1",
        status: "pending",
        verifiedAt: new Date(),
      });
      await rejects(verify(), /already being processed/);
    });

    it("lets a stale in-flight attempt (owner died) be retried", async () => {
      log.rows.set("sig-1", {
        signature: "sig-1",
        status: "pending",
        verifiedAt: new Date(Date.now() - STALE_PENDING_MS - 1000),
      });
      await verify();
      expect(log.rows.get("sig-1").status).to.equal("verified");
    });

    it("rejects a nonce that was already used by another stake", async () => {
      await redis.set("nonce:nonce-1", "used");
      await rejects(verify(), /Nonce already used/);
      expect(log.rows.get("sig-1").status).to.equal("failed");
    });
  });

  describe("a failed attempt does not strand the stake", () => {
    it("burns neither signature nor nonce, so the same stake verifies on retry", async () => {
      served = null; // not visible on-chain yet
      await rejects(verify(), /could not be verified/);
      expect(log.rows.get("sig-1").status).to.equal("failed");
      expect(redis.m.has("nonce:nonce-1")).to.equal(false);

      served = stakeTx(); // now confirmed
      await verify();
      expect(log.rows.get("sig-1").status).to.equal("verified");
      expect(redis.m.get("nonce:nonce-1")).to.equal("used");
    });

    it("keeps waiting while the transaction is only 'processed', then gives up", async () => {
      confirmation = "processed";
      await rejects(verify(), /could not be verified/);
      expect(log.rows.get("sig-1").status).to.equal("failed");
    });
  });

  describe("each on-chain rule rejects a transaction that breaks it", () => {
    it("a transaction that failed on-chain", async () => {
      served = stakeTx({ err: { InstructionError: [0, { Custom: 1 }] } });
      await rejects(verify(), /failed on the blockchain/);
    });

    it("a transfer from a different wallet", async () => {
      served = stakeTx({ signer: STRANGER });
      await rejects(verify(), /sender verification failed/);
    });

    it("a transaction the claimed sender appears in but did not sign", async () => {
      served = stakeTx({ senderIsSigner: false });
      await rejects(verify(), /not signed by expected sender/);
    });

    it("a token other than USDC", async () => {
      served = stakeTx({ mint: OTHER_MINT });
      await rejects(verify(), /does not transfer USDC to treasury/);
    });

    it("a payment to a wallet other than the treasury", async () => {
      served = stakeTx({ recipient: STRANGER });
      await rejects(verify(), /does not transfer USDC to treasury/);
    });

    it("less than the stake", async () => {
      served = stakeTx({ amount: STAKE - 1 });
      await rejects(verify(), /Amount mismatch/);
    });

    it("more than the stake (amounts must match exactly)", async () => {
      served = stakeTx({ amount: STAKE + 1_000_000 });
      await rejects(verify(), /Amount mismatch/);
    });

    it("a stake amount that is not in atomic units", async () => {
      await rejects(verify("sig-1", { amount: 10.5 }), /atomic units/);
    });

    it("a transaction with no memo (no binding to this request)", async () => {
      served = stakeTx({ includeMemo: false });
      await rejects(verify(), /missing memo/);
    });

    it("a memo carrying a different request's nonce", async () => {
      served = stakeTx({ memo: "nonce-someone-else" });
      await rejects(verify(), /Nonce mismatch/);
    });

    it("a transaction older than five minutes", async () => {
      served = stakeTx({ blockTime: Math.floor(Date.now() / 1000) - 600 });
      await rejects(verify(), /expired/);
    });

    it("a transaction with no block time", async () => {
      served = stakeTx({ blockTime: null });
      await rejects(verify(), /missing timestamp/);
    });

    it("never burns the nonce or verifies the signature on any of these", async () => {
      const broken = [
        stakeTx({ signer: STRANGER }),
        stakeTx({ mint: OTHER_MINT }),
        stakeTx({ amount: STAKE - 1 }),
        stakeTx({ memo: "other" }),
      ];
      for (const [i, tx] of broken.entries()) {
        served = tx;
        await verify(`sig-broken-${i}`).catch(() => {});
        expect(log.rows.get(`sig-broken-${i}`).status).to.equal("failed");
      }
      expect(redis.m.has("nonce:nonce-1")).to.equal(false);
    });
  });
});
