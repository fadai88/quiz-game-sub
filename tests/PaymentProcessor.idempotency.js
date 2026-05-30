'use strict';

/**
 * Payout idempotency tests for PaymentProcessor.
 *
 * Covers the five scenarios from the security review:
 *   1. broadcast succeeds but confirmTransaction times out
 *   2. server restarts while payment is processing
 *   3. RPC returns null for a signature before later confirming
 *   4. blockhash expiry creates only one replacement transfer
 *   5. DB completion write fails after on-chain success
 *
 * None of these tests hit devnet.  All Solana network calls are replaced by
 * sinon stubs.  Real Keypair / PublicKey / Transaction objects are used so
 * that transaction signing and serialisation exercise the actual library code.
 */

const { expect } = require('chai');
const sinon      = require('sinon');
const { Keypair, PublicKey } = require('@solana/web3.js');

const PaymentProcessor = require('../services/PaymentProcessor');
const PaymentQueue     = require('../models/PaymentQueue');

// ── Shared fixtures ───────────────────────────────────────────────────────────
// 44-char base58 string → decodes to exactly 32 bytes → valid blockhash format.
const FAKE_BLOCKHASH  = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const LAST_VALID_BH   = 1000;
const RPC_URL         = 'https://api.devnet.solana.com';

// Real keypairs so transaction.sign() / transaction.serialize() work locally.
const treasury  = Keypair.generate();
const recipient = Keypair.generate();
// Mainnet USDC mint — valid 32-byte pubkey, no network call required.
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConn(overrides = {}) {
    return {
        rpcEndpoint:          RPC_URL,
        getLatestBlockhash:   sinon.stub().resolves({ blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: LAST_VALID_BH }),
        getAccountInfo:       sinon.stub().resolves({}),   // ATA already exists → no createATA instruction
        sendRawTransaction:   sinon.stub().resolves('ok'),
        confirmTransaction:   sinon.stub().resolves({ value: { err: null } }),
        getSignatureStatuses: sinon.stub().resolves({ value: [null] }),
        getBlockHeight:       sinon.stub().resolves(LAST_VALID_BH - 10),
        ...overrides,
    };
}

let seq = 0;
function makePayment(overrides = {}) {
    return {
        _id:                          `pay-${++seq}`,
        recipientWallet:              recipient.publicKey.toBase58(),
        amount:                       1_000_000,   // 1 USDC (6 decimals)
        gameId:                       `game-${seq}`,
        betAmount:                    500_000,
        broadcastSignature:           null,
        broadcastLastValidBlockHeight: null,
        markProcessing: sinon.stub().resolves(),
        markCompleted:  sinon.stub().resolves(),
        markFailed:     sinon.stub().resolves(),
        ...overrides,
    };
}

function makeProcessor(conn) {
    return new PaymentProcessor({
        connection:       conn,
        io:               { to: () => ({ emit: () => {} }) },
        TREASURY_KEYPAIR: treasury,
        USDC_MINT,
        TREASURY_WALLET:  treasury.publicKey,
        rpcEndpoints:     [RPC_URL],
    });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PaymentProcessor — payout idempotency', () => {
    // Stub the static DB update that persists broadcastSignature before each test.
    beforeEach(() => sinon.stub(PaymentQueue, 'findByIdAndUpdate').resolves({}));
    // sinon.restore() also un-installs fake timers if a test created them.
    afterEach(() => sinon.restore());

    // ── Scenario 1: broadcast succeeds but confirmTransaction times out ────────
    //
    // We test _confirmExistingSignature directly at two points:
    //  (a) immediate return when the sig is already on-chain
    //  (b) polling through null RPC responses until the sig appears
    //
    // These prove that the retry loop in sendPayment will not call
    // sendRawTransaction again when the first broadcast has already landed,
    // regardless of whether confirmTransaction timed out.

    it('1a. returns "confirmed" immediately when sig is already on-chain', async () => {
        const conn = makeConn({
            getSignatureStatuses: sinon.stub().resolves({
                value: [{ confirmationStatus: 'confirmed', err: null }],
            }),
        });

        const result = await makeProcessor(conn)
            ._confirmExistingSignature(conn, 'SOME_SIG', LAST_VALID_BH);

        expect(result).to.equal('confirmed');
        expect(conn.getSignatureStatuses.callCount).to.equal(1);
    });

    // ── Scenario 3: RPC returns null before later confirming ──────────────────
    //
    // getSignatureStatuses returns null twice (RPC has not indexed the tx yet)
    // and confirmed on the third call.  Fake timers advance past the two
    // 2 000 ms sleep intervals without blocking the test runner.

    it('1b / 3. polls through null × 2 then returns "confirmed"', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'Date'] });

        const statusStub = sinon.stub();
        statusStub.onCall(0).resolves({ value: [null] });
        statusStub.onCall(1).resolves({ value: [null] });
        statusStub.resolves({ value: [{ confirmationStatus: 'confirmed', err: null }] });

        const conn = makeConn({
            getSignatureStatuses: statusStub,
            getBlockHeight:       sinon.stub().resolves(LAST_VALID_BH - 50),
        });

        const p = makeProcessor(conn)._confirmExistingSignature(conn, 'SOME_SIG', LAST_VALID_BH);
        // Advance past the two 2 000 ms poll sleeps (4 000 ms total) plus margin.
        await clock.tickAsync(4500);
        const result = await p;

        expect(result).to.equal('confirmed');
        expect(statusStub.callCount).to.equal(3);

        clock.restore();
    });

    // ── Scenario 2: server restarts while payment is processing ───────────────
    //
    // The DB record has broadcastSignature already set (written before the crash).
    // sendPayment must call _confirmExistingSignature, find the sig confirmed, and
    // return it without ever calling sendRawTransaction.

    it('2. server restart: existing confirmed sig returned, no re-broadcast', async () => {
        const conn = makeConn({
            getSignatureStatuses: sinon.stub().resolves({
                value: [{ confirmationStatus: 'confirmed', err: null }],
            }),
        });
        const payment = makePayment({
            broadcastSignature:            'EXISTING_SIG',
            broadcastLastValidBlockHeight: LAST_VALID_BH,
        });

        const sig = await makeProcessor(conn).sendPayment(payment);

        expect(sig).to.equal('EXISTING_SIG');
        expect(conn.sendRawTransaction.callCount).to.equal(0);
    });

    // ── Scenario 4: blockhash expiry path ─────────────────────────────────────

    it('4a. _confirmExistingSignature returns "expired" when block height exceeded', async () => {
        const conn = makeConn({
            getSignatureStatuses: sinon.stub().resolves({ value: [null] }),
            getBlockHeight:       sinon.stub().resolves(LAST_VALID_BH + 1),
        });

        const result = await makeProcessor(conn)
            ._confirmExistingSignature(conn, 'OLD_SIG', LAST_VALID_BH);

        expect(result).to.equal('expired');
    });

    it('4b. expired blockhash: sendPayment builds exactly one replacement transaction', async () => {
        const conn = makeConn({
            // Sig not found (old tx definitely expired)
            getSignatureStatuses: sinon.stub().resolves({ value: [null] }),
            // Block height past the stored lastValidBlockHeight
            getBlockHeight:       sinon.stub().resolves(LAST_VALID_BH + 1),
            // Replacement tx confirms immediately
            confirmTransaction:   sinon.stub().resolves({ value: { err: null } }),
        });
        const payment = makePayment({
            broadcastSignature:            'EXPIRED_SIG',
            broadcastLastValidBlockHeight: LAST_VALID_BH,
        });

        const sig = await makeProcessor(conn).sendPayment(payment);

        expect(sig).to.be.a('string').and.not.equal('EXPIRED_SIG');
        // One broadcast for the replacement; the expired tx was never re-sent.
        expect(conn.sendRawTransaction.callCount).to.equal(1);
    });

    // ── Scenario 5: DB completion write fails after on-chain success ──────────
    //
    // markCompleted throws on the first processPayment call.
    // Invariants:
    //  • processPayment must throw (caller can retry)
    //  • markFailed must NOT be called (the on-chain tx is confirmed)
    //  • On the second processPayment call, the existing sig is confirmed via
    //    _confirmExistingSignature — sendRawTransaction is not called again.

    it('5. DB completion write fails: markFailed not called; second attempt reuses sig', async () => {
        const conn = makeConn({
            confirmTransaction:   sinon.stub().resolves({ value: { err: null } }),
            // _confirmExistingSignature will find the sig confirmed on second run
            getSignatureStatuses: sinon.stub().resolves({
                value: [{ confirmationStatus: 'confirmed', err: null }],
            }),
        });
        const payment = makePayment({
            markCompleted: sinon.stub()
                .onFirstCall().rejects(new Error('Mongo write timeout'))
                .resolves(),
        });
        const processor = makeProcessor(conn);

        // ── First processPayment: on-chain success, DB write fails ──
        const err = await processor.processPayment(payment).catch(e => e);
        expect(err).to.be.instanceOf(Error);
        expect(err.message).to.include('DB completion update failed');
        // Critical: must NOT mark failed because the USDC was already sent.
        expect(payment.markFailed.callCount).to.equal(0, 'markFailed must not be called after on-chain success');

        const broadcastsAfterFirst = conn.sendRawTransaction.callCount; // 1

        // ── Second processPayment: retries the same payment ──
        // broadcastSignature was persisted during the first run; the retry must
        // confirm it rather than building and sending a new transaction.
        await processor.processPayment(payment);

        expect(conn.sendRawTransaction.callCount).to.equal(
            broadcastsAfterFirst,
            'sendRawTransaction must not be called a second time'
        );
        expect(payment.markCompleted.callCount).to.equal(2);
    });
});
