'use strict';

/**
 * Payout idempotency tests for PaymentProcessor.
 *
 * Covers the five scenarios from the security review plus the additional
 * findings from the independent code review:
 *
 *   1.  broadcast succeeds but confirmTransaction times out
 *   2.  server restarts while payment is processing
 *   3.  RPC returns null for a signature before later confirming
 *   4.  blockhash expiry creates only one replacement transfer
 *   5.  DB completion write fails after on-chain success
 *   HIGH   confirmTransaction resolves with err → must not mark completed
 *   ORDER  broadcastSignature must be persisted before sendRawTransaction
 *   FAIL   on-chain failure in existing sig → must mark failed, no re-broadcast
 *
 * None of these tests hit devnet.  Real Keypair / PublicKey / Transaction
 * objects are used so signing and serialisation exercise the actual library.
 * All Solana RPC calls are replaced by sinon stubs.
 */

const { expect } = require('chai');
const sinon      = require('sinon');
const { Keypair, PublicKey } = require('@solana/web3.js');

const PaymentProcessor = require('../services/PaymentProcessor');
const PaymentQueue     = require('../models/PaymentQueue');

// ── Fixtures ──────────────────────────────────────────────────────────────────
// 44-char base58 → decodes to exactly 32 bytes → valid blockhash format.
const FAKE_BLOCKHASH  = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const LAST_VALID_BH   = 1000;
const RPC_URL         = 'https://api.devnet.solana.com';
// Reused across HIGH and FAIL tests.
const SOLANA_ERR      = { InstructionError: [0, { Custom: 1 }] };

// Real keypairs so transaction.sign() / transaction.serialize() work locally.
const treasury  = Keypair.generate();
const recipient = Keypair.generate();
// Mainnet USDC mint — valid 32-byte pubkey, no network call needed.
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConn(overrides = {}) {
    return {
        rpcEndpoint:          RPC_URL,
        getLatestBlockhash:   sinon.stub().resolves({ blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: LAST_VALID_BH }),
        getAccountInfo:       sinon.stub().resolves({}),   // ATA exists → no createATA needed
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
        connection:        conn,
        io:                { to: () => ({ emit: () => {} }) },
        TREASURY_KEYPAIR:  treasury,
        USDC_MINT,
        TREASURY_WALLET:   treasury.publicKey,
        rpcEndpoints:      [RPC_URL],
        // Ensures the retry-loop connection switch stays on our mock instead of
        // constructing a real Connection that would call devnet.
        connectionFactory: () => conn,
    });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('PaymentProcessor — payout idempotency', () => {
    // Stub the static DB call that persists broadcastSignature before broadcast.
    beforeEach(() => sinon.stub(PaymentQueue, 'findByIdAndUpdate').resolves({}));
    // sinon.restore() also un-installs any fake timers created in a test.
    afterEach(() => sinon.restore());

    // ── HIGH: confirmTransaction resolved error ────────────────────────────────
    //
    // Solana's confirmTransaction can RESOLVE (not throw) with { value: { err } }
    // when the transaction reached the network but failed at the VM level.
    // Before the fix, PaymentProcessor ignored this return value and returned the
    // signature as success.  The fixed code throws, causing processPayment to mark
    // the payment failed.

    it('HIGH: confirmTransaction resolving with err → never marks completed, marks failed', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        const conn = makeConn({
            confirmTransaction:   sinon.stub().resolves({ value: { err: SOLANA_ERR } }),
            // On each retry, _confirmExistingSignature sees the sig as expired
            // (no sleeping needed) rather than polling indefinitely.
            getSignatureStatuses: sinon.stub().resolves({ value: [null] }),
            getBlockHeight:       sinon.stub().resolves(LAST_VALID_BH + 1),
        });
        const payment = makePayment();
        // Attach .catch immediately so the rejection is handled before tickAsync
        // runs — prevents PromiseRejectionHandledWarning in strict CI environments.
        const p = makeProcessor(conn).processPayment(payment).catch(() => {});
        // MAX_RETRIES=3 retry waits: 2^1=2 000ms + 2^2=4 000ms = 6 000ms total.
        await clock.tickAsync(7000);
        await p;

        expect(payment.markCompleted.callCount).to.equal(0);
        expect(payment.markFailed.callCount).to.equal(1);
        clock.restore();
    });

    // ── Scenario 1: broadcast succeeds but confirmTransaction times out ────────

    it('1a. _confirmExistingSignature returns "confirmed" immediately when sig is on-chain', async () => {
        const conn = makeConn({
            getSignatureStatuses: sinon.stub().resolves({
                value: [{ confirmationStatus: 'confirmed', err: null }],
            }),
        });
        const result = await makeProcessor(conn)
            ._confirmExistingSignature(conn, 'SIG', LAST_VALID_BH);

        expect(result).to.equal('confirmed');
        expect(conn.getSignatureStatuses.callCount).to.equal(1);
    });

    it('1c. end-to-end: confirmTransaction timeout → retry finds persisted sig confirmed, no second broadcast', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        const conn = makeConn({
            confirmTransaction:   sinon.stub().rejects(new Error('TransactionExpiredTimeoutError')),
            getSignatureStatuses: sinon.stub().resolves({
                value: [{ confirmationStatus: 'confirmed', err: null }],
            }),
        });
        const payment = makePayment();
        const p = makeProcessor(conn).sendPayment(payment);
        // Advance past the 2^1 = 2 000ms retry wait between attempts 1 and 2.
        await clock.tickAsync(2100);
        const sig = await p;

        expect(sig).to.be.a('string');
        // The original broadcast happened once; the retry returned early after
        // _confirmExistingSignature found it confirmed.
        expect(conn.sendRawTransaction.callCount).to.equal(1);
        clock.restore();
    });

    // ── Scenario 3 / 1b: RPC returns null before later confirming ─────────────

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

        const p = makeProcessor(conn)
            ._confirmExistingSignature(conn, 'SIG', LAST_VALID_BH);
        // Advance past two 2 000ms poll sleeps (4 000ms) plus margin.
        await clock.tickAsync(4500);
        const result = await p;

        expect(result).to.equal('confirmed');
        expect(statusStub.callCount).to.equal(3);
        clock.restore();
    });

    // ── Ordering invariant ────────────────────────────────────────────────────
    //
    // The entire double-send defence rests on this: broadcastSignature must be
    // written to the DB *before* the network broadcast so a crash between the two
    // leaves a recoverable record.

    it('ORDER: broadcastSignature + lastValidBlockHeight persisted before sendRawTransaction is called', async () => {
        const conn    = makeConn();
        const payment = makePayment();
        const findByIdStub = PaymentQueue.findByIdAndUpdate; // set up in beforeEach

        await makeProcessor(conn).sendPayment(payment);

        expect(findByIdStub.calledBefore(conn.sendRawTransaction)).to.be.true;
        const [, updateDoc] = findByIdStub.firstCall.args;
        expect(updateDoc).to.have.property('broadcastSignature').that.is.a('string');
        expect(updateDoc).to.have.property('broadcastLastValidBlockHeight', LAST_VALID_BH);
    });

    // ── Scenario 2: server restarts while payment is processing ───────────────

    it('2a. server restart (sendPayment): existing confirmed sig returned, no re-broadcast', async () => {
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

    it('2b. queue recovery (processPayment): stale processing payment confirmed and completed, no re-broadcast', async () => {
        const conn = makeConn({
            getSignatureStatuses: sinon.stub().resolves({
                value: [{ confirmationStatus: 'confirmed', err: null }],
            }),
        });
        // Simulates a document fetched from DB with status:'processing' after restart.
        const payment = makePayment({
            broadcastSignature:            'STALE_SIG',
            broadcastLastValidBlockHeight: LAST_VALID_BH,
        });

        await makeProcessor(conn).processPayment(payment);

        expect(payment.markProcessing.callCount).to.equal(1);
        expect(payment.markCompleted.callCount).to.equal(1);
        expect(conn.sendRawTransaction.callCount).to.equal(0);
    });

    // ── Scenario 4: blockhash expiry ──────────────────────────────────────────

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
            getSignatureStatuses: sinon.stub().resolves({ value: [null] }),
            getBlockHeight:       sinon.stub().resolves(LAST_VALID_BH + 1),
            confirmTransaction:   sinon.stub().resolves({ value: { err: null } }),
        });
        const payment = makePayment({
            broadcastSignature:            'EXPIRED_SIG',
            broadcastLastValidBlockHeight: LAST_VALID_BH,
        });

        const sig = await makeProcessor(conn).sendPayment(payment);

        expect(sig).to.be.a('string').and.not.equal('EXPIRED_SIG');
        expect(conn.sendRawTransaction.callCount).to.equal(1);
    });

    // ── Scenario 5: DB completion write fails after on-chain success ──────────
    //
    // Uses a fresh payment object for the second run to simulate a real server
    // restart: only the fields that are actually persisted to the DB carry over.

    it('5. DB completion write fails: markFailed not called; fresh retry reuses sig, no re-broadcast', async () => {
        const conn = makeConn({
            confirmTransaction:   sinon.stub().resolves({ value: { err: null } }),
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

        // First run: on-chain success, DB write fails.
        const err = await processor.processPayment(payment).catch(e => e);
        expect(err).to.be.instanceOf(Error);
        expect(err.message).to.include('DB completion update failed');
        // markFailed must NOT be called — the USDC already left the treasury.
        expect(payment.markFailed.callCount).to.equal(0,
            'markFailed must not be called after on-chain success');

        const broadcastsAfterFirst = conn.sendRawTransaction.callCount; // 1

        // Simulate reloading the payment document from the DB on the next run.
        // A real restart only carries over persisted fields; in-memory mutation
        // state (e.g. the old markCompleted stub's call history) is gone.
        const freshPayment = makePayment({
            broadcastSignature:            payment.broadcastSignature,
            broadcastLastValidBlockHeight: payment.broadcastLastValidBlockHeight,
        });

        // Second run: confirms the existing sig, no new broadcast.
        await processor.processPayment(freshPayment);

        expect(conn.sendRawTransaction.callCount).to.equal(broadcastsAfterFirst,
            'sendRawTransaction must not be called a second time');
        expect(freshPayment.markCompleted.callCount).to.equal(1);
        expect(freshPayment.markFailed.callCount).to.equal(0);
    });

    // ── On-chain failure for existing signatures ──────────────────────────────
    //
    // If getSignatureStatuses returns { err } for the stored signature, the tx
    // definitely failed on-chain.  The processor should mark failed and must
    // never re-broadcast (the USDC never moved, but re-broadcasting would be
    // wrong — the failure may be permanent, e.g. insufficient balance).

    it('FAIL: _confirmExistingSignature throws when known on-chain tx failed', async () => {
        const conn = makeConn({
            getSignatureStatuses: sinon.stub().resolves({
                value: [{ err: SOLANA_ERR, confirmationStatus: 'confirmed' }],
            }),
        });

        let threw = null;
        try {
            await makeProcessor(conn)._confirmExistingSignature(conn, 'FAILED_SIG', LAST_VALID_BH);
        } catch (e) {
            threw = e;
        }

        expect(threw).to.be.instanceOf(Error);
        expect(threw.message).to.include('Broadcast transaction failed on-chain');
    });

    it('FAIL: processPayment marks failed (not completed) when existing broadcast failed on-chain, never re-broadcasts', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        const conn = makeConn({
            // Every status check returns the same on-chain failure.
            getSignatureStatuses: sinon.stub().resolves({
                value: [{ err: SOLANA_ERR, confirmationStatus: 'confirmed' }],
            }),
        });
        // Payment already has a stored sig (was broadcast before the failure).
        const payment = makePayment({
            broadcastSignature:            'FAILED_ON_CHAIN_SIG',
            broadcastLastValidBlockHeight: LAST_VALID_BH,
        });
        // Attach .catch immediately — same reason as the HIGH test above.
        const p = makeProcessor(conn).processPayment(payment).catch(() => {});
        // _checkSignatureStatus throws immediately on each attempt (no sleeping
        // inside the method), but the retry waits between attempts still apply.
        await clock.tickAsync(7000);
        await p;

        expect(payment.markCompleted.callCount).to.equal(0);
        expect(payment.markFailed.callCount).to.equal(1);
        // A failed tx must never be re-broadcast.
        expect(conn.sendRawTransaction.callCount).to.equal(0);
        clock.restore();
    });

    // ── Pre-broadcast DB write failure ────────────────────────────────────────
    //
    // Step 4 of sendPayment persists broadcastSignature BEFORE broadcasting.
    // If that write fails the code should not broadcast at all — the sig was
    // never persisted so a subsequent retry would have no record to check and
    // would build a fresh transaction anyway.

    it('DB-PRE-BROADCAST: findByIdAndUpdate failure → sendRawTransaction never called', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        // Change the default resolves({}) from beforeEach to a rejection.
        PaymentQueue.findByIdAndUpdate.rejects(new Error('DB write timeout'));

        const conn    = makeConn();
        const payment = makePayment();

        const p = makeProcessor(conn).processPayment(payment).catch(() => {});
        // MAX_RETRIES=3 retry waits: 2^1=2 000ms + 2^2=4 000ms = 6 000ms total.
        await clock.tickAsync(7000);
        await p;

        expect(conn.sendRawTransaction.callCount).to.equal(0);
        expect(payment.markFailed.callCount).to.equal(1);
        clock.restore();
    });

    // ── sendRawTransaction failure after signature is persisted ───────────────
    //
    // Some RPC failures are ambiguous: the packet may have reached the node even
    // though we got a network error.  Because broadcastSignature was already
    // persisted (Step 4 runs before Step 5), the retry must poll it via
    // _confirmExistingSignature rather than immediately building a duplicate tx.

    it('BROADCAST-FAIL: sendRawTransaction throws after persist → retry checks stored sig, no second broadcast', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        const conn = makeConn({
            sendRawTransaction:   sinon.stub().rejects(new Error('RPC connection failed')),
            // Simulates the tx actually landing despite the network error.
            getSignatureStatuses: sinon.stub().resolves({
                value: [{ confirmationStatus: 'confirmed', err: null }],
            }),
        });
        const payment = makePayment();
        // Attach .catch immediately to avoid unhandled rejection during tickAsync.
        const p = makeProcessor(conn).sendPayment(payment).catch(e => e);
        // Advance past the 2^1 = 2 000ms retry wait.
        await clock.tickAsync(2100);
        const result = await p;

        // The retry found the persisted sig confirmed and returned it without
        // calling sendRawTransaction a second time.
        expect(result).to.be.a('string');
        expect(conn.sendRawTransaction.callCount).to.equal(1);
        clock.restore();
    });
});
