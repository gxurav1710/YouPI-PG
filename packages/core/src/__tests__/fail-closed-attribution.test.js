import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PaymentStatus,
  ObserverSource,
  ObservationAttributionStatus
} from '@youpi/common';
import {
  AttributionEngine,
  ObservationNormalizer,
  PaymentVerificationPipeline,
  QueueEngine
} from '../index.js';
import {
  Database,
  runMigrations,
  PaymentSessionRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository,
  CustomerRepository,
  ReceivingAccountRepository,
  MerchantRepository
} from '@youpi/db';

describe('Phase 9A Fail-Closed Payment Attribution Hardening Suite', () => {
  let db;
  let sessionRepo;
  let obsRepo;
  let ticketRepo;
  let auditRepo;
  let customerRepo;
  let accountRepo;
  let merchantRepo;
  let queueEngine;
  let attributionEngine;
  let pipeline;
  let emittedEvents;

  let merchantA;
  let merchantB;
  let accountA;
  let accountB;

  beforeEach(() => {
    db = new Database({ inMemory: true });
    runMigrations(db);

    sessionRepo = new PaymentSessionRepository(db);
    obsRepo = new ObservationRepository(db);
    ticketRepo = new SupportTicketRepository(db);
    auditRepo = new AuditLogRepository(db);
    customerRepo = new CustomerRepository(db);
    accountRepo = new ReceivingAccountRepository(db);
    merchantRepo = new MerchantRepository(db);

    emittedEvents = [];

    // Setup 2 separate merchants
    merchantA = merchantRepo.create({
      businessName: 'V-Visa B2B Staging',
      slug: 'vvisa-b2b',
      contactEmail: 'ops@vvisa.in',
      contactPhone: '9876543210',
      webhookUrl: 'http://localhost:3000/api/payments/youpi/webhook',
      webhookSecret: 'secret_a_test'
    });

    merchantB = merchantRepo.create({
      businessName: 'External Agency Portal',
      slug: 'agency-portal',
      contactEmail: 'agency@agency.in',
      contactPhone: '9876543211',
      webhookUrl: 'http://localhost:4000/api/payments/webhook',
      webhookSecret: 'secret_b_test'
    });

    // Setup 2 separate receiving accounts
    accountA = accountRepo.create({
      merchantId: merchantA.id,
      upiId: 'vvisa.staging@bank',
      payeeName: 'V-Visa Technologies',
      isActive: true
    });

    accountB = accountRepo.create({
      merchantId: merchantB.id,
      upiId: 'agency.staging@bank',
      payeeName: 'Agency Operations',
      isActive: true
    });

    queueEngine = new QueueEngine({
      sessionRepo,
      accountRepo,
      eventEmitter: { emit: (event, payload) => emittedEvents.push({ event, payload }) },
      auditRepo
    });

    attributionEngine = new AttributionEngine({
      sessionRepo,
      obsRepo,
      ticketRepo,
      auditRepo,
      gracePeriodMs: 0,
      eventEmitter: { emit: (event, payload) => emittedEvents.push({ event, payload }) }
    });

    pipeline = new PaymentVerificationPipeline({
      db,
      sessionRepo,
      obsRepo,
      customerRepo,
      auditRepo,
      attributionEngine,
      eventEmitter: { emit: (event, payload) => emittedEvents.push({ event, payload }) },
      server: null
    });
  });

  afterEach(() => {
    db.close();
  });

  test('1. Same amount across two merchants with missing account context: strictly NO attribution', () => {
    // Merchant A creates ₹500 session
    const sessionA = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-MERCHANT-A',
      amountPaise: 50000n
    });
    sessionRepo.acquireSlotAtomic(sessionA.id, accountA.id, 300000);

    // Merchant B creates ₹500 session
    const sessionB = sessionRepo.create({
      merchantId: merchantB.id,
      receivingAccountId: accountB.id,
      orderId: 'ORD-MERCHANT-B',
      amountPaise: 50000n
    });
    sessionRepo.acquireSlotAtomic(sessionB.id, accountB.id, 300000);

    // Incoming observation for ₹500 has MISSING receivingAccountId
    const rawText = 'Received Rs 500.00 in your account. Ref: 500000111222';
    const pipeResult = pipeline.process({
      source: 'SMS',
      rawText,
      sender: 'HDFCBK',
      receivingAccountId: null // Missing context!
    });

    // Fail-Closed Guard: Must NOT guess either session!
    assert.equal(pipeResult.status, 'UNRESOLVED');
    assert.equal(pipeResult.failingCondition, 'NO_ACTIVE_SESSION');

    // Both sessions remain ACTIVE, neither is attributed!
    assert.equal(sessionRepo.findById(sessionA.id).status, PaymentStatus.ACTIVE);
    assert.equal(sessionRepo.findById(sessionB.id).status, PaymentStatus.ACTIVE);
  });

  test('2. Same amount across two receiving accounts: strictly NO cross-account attribution', () => {
    const sessionA = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-VPA-A',
      amountPaise: 100000n
    });
    sessionRepo.acquireSlotAtomic(sessionA.id, accountA.id, 300000);

    const sessionB = sessionRepo.create({
      merchantId: merchantB.id,
      receivingAccountId: accountB.id,
      orderId: 'ORD-VPA-B',
      amountPaise: 100000n
    });
    sessionRepo.acquireSlotAtomic(sessionB.id, accountB.id, 300000);

    // Bank alert arrives specifically for Account B
    const rawText = 'Payment of Rs. 1000.00 received. UPI Ref: 100099988877';
    const pipeResult = pipeline.process({
      source: 'SMS',
      rawText,
      sender: 'YESBNK',
      receivingAccountId: accountB.id // Account B context
    });

    assert.equal(pipeResult.status, 'VERIFIED');
    // Session B is credited
    assert.equal(sessionRepo.findById(sessionB.id).status, PaymentStatus.OBSERVED_SUCCESS);
    // Session A on Account A is untouched!
    assert.equal(sessionRepo.findById(sessionA.id).status, PaymentStatus.ACTIVE);
  });

  test('3. Valid account context: only eligible sessions for that account are considered', () => {
    const sessionA = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-TARGET-A',
      amountPaise: 25000n
    });
    sessionRepo.acquireSlotAtomic(sessionA.id, accountA.id, 300000);

    const rawText = 'Received Rs 250.00 on UPI. Ref: 250000011223';
    const pipeResult = pipeline.process({
      source: 'GMAIL',
      rawText,
      sender: 'alerts@retail.bank.in',
      receivingAccountId: accountA.id
    });

    assert.equal(pipeResult.status, 'VERIFIED');
    assert.equal(sessionRepo.findById(sessionA.id).status, PaymentStatus.OBSERVED_SUCCESS);
  });

  test('3b. Manual UPI sessions are never verified from SMS or Gmail attribution', () => {
    const manual = sessionRepo.create({ merchantId: merchantA.id, receivingAccountId: accountA.id,
      orderId: 'ORD-MANUAL-UPI', amountPaise: 25000n, method: 'MANUAL_UPI' });
    sessionRepo.acquireSlotAtomic(manual.id, accountA.id, 300000);
    const result = pipeline.process({ source: 'GMAIL', rawText: 'Received Rs 250.00 via UPI. UTR 250000011224',
      sender: 'alerts@retail.bank.in', receivingAccountId: accountA.id, rawPayload: { targetSessionId: manual.id } });
    assert.notEqual(result.status, 'VERIFIED');
    assert.equal(sessionRepo.findById(manual.id).status, PaymentStatus.ACTIVE);
    assert.equal(emittedEvents.some(event => event.payload?.paymentId === manual.id), false);
  });

  test('4. Missing or invalid observer registration: rejected or quarantined without guessing', () => {
    const sessionA = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-FAIL-CLOSED',
      amountPaise: 10000n
    });
    sessionRepo.acquireSlotAtomic(sessionA.id, accountA.id, 300000);

    // Observation with non-existent receivingAccountId
    const rawText = 'Received Rs 100.00 on UPI. Ref: 100000998877';
    const pipeResult = pipeline.process({
      source: 'SMS',
      rawText,
      sender: 'AXISBK',
      receivingAccountId: 'non_existent_account_cuid'
    });

    assert.equal(pipeResult.status, 'UNRESOLVED');
    assert.equal(pipeResult.failingCondition, 'NO_ACTIVE_SESSION');
    assert.equal(sessionRepo.findById(sessionA.id).status, PaymentStatus.ACTIVE);
  });

  test('5. Expired session: no automatic confirmation', () => {
    const session = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-EXPIRED',
      amountPaise: 5000n
    });
    sessionRepo.acquireSlotAtomic(session.id, accountA.id, 300000);
    // Explicitly transition to EXPIRED
    sessionRepo.transitionToTerminal(session.id, PaymentStatus.EXPIRED);

    const rawText = 'Received Rs 50.00 on UPI. Ref: 500000998877';
    const pipeResult = pipeline.process({
      source: 'SMS',
      rawText,
      sender: 'YESBNK',
      receivingAccountId: accountA.id
    });

    // Must be rejected as NO_ACTIVE_SESSION or LATE_UNMATCHED, NEVER confirmed!
    assert.notEqual(pipeResult.status, 'VERIFIED');
    assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.EXPIRED);
  });

  test('6. Previously consumed UTR during a later session: strictly rejected with REFERENCE_ALREADY_USED', () => {
    // 1. Session 1 confirms UTR 999999000111
    const session1 = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-FIRST',
      amountPaise: 10000n
    });
    sessionRepo.acquireSlotAtomic(session1.id, accountA.id, 300000);

    const r1 = pipeline.process({
      source: 'GMAIL',
      rawText: 'Received Rs 100.00 on UPI. Ref: 999999000111',
      sender: 'alerts@yes.bank.in',
      receivingAccountId: accountA.id
    });
    assert.equal(r1.status, 'VERIFIED');
    assert.equal(sessionRepo.findById(session1.id).status, PaymentStatus.OBSERVED_SUCCESS);

    // 2. Later Session 2 is active on same account
    const session2 = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-SECOND',
      amountPaise: 10000n
    });
    sessionRepo.acquireSlotAtomic(session2.id, accountA.id, 300000);

    // 3. Attempt to replay SAME UTR 999999000111 on Session 2
    const replayResult = pipeline.process({
      source: 'SMS',
      rawText: 'Received Rs 100.00 on UPI. Ref: 999999000111',
      sender: 'YESBNK',
      receivingAccountId: accountA.id
    });

    assert.equal(replayResult.status, 'REJECTED');
    assert.equal(replayResult.failingCondition, 'REFERENCE_ALREADY_USED');
    assert.equal(sessionRepo.findById(session2.id).status, PaymentStatus.ACTIVE);
  });

  test('7. Duplicate events from SMS/Gmail: no duplicate wallet credit (idempotent)', () => {
    const session = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-MULTI-CHANNEL',
      amountPaise: 30000n
    });
    sessionRepo.acquireSlotAtomic(session.id, accountA.id, 300000);

    // Event 1: SMS arrives and verifies session
    const r1 = pipeline.process({
      source: 'SMS',
      rawText: 'Received Rs 300.00 on UPI. Ref: 300000123456',
      sender: 'YESBNK',
      receivingAccountId: accountA.id
    });
    assert.equal(r1.status, 'VERIFIED');
    assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.OBSERVED_SUCCESS);

    // Event 2: Duplicate Gmail event with same UTR arrives after session is already SUCCESS
    const r2 = pipeline.process({
      source: 'GMAIL',
      rawText: 'Credit alert: Rs 300.00 deposited. Ref: 300000123456',
      sender: 'alerts@yes.bank.in',
      receivingAccountId: accountA.id
    });
    // Event 2 must NOT re-credit or double-activate (fails closed without active session)
    assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.OBSERVED_SUCCESS);

    // Invariant: Success event emitted exactly once across both observer channels!
    const successEvents = emittedEvents.filter(e => e.event === 'PAYMENT.OBSERVED_SUCCESS');
    assert.equal(successEvents.length, 1);
  });

  test('7b. Same-channel replay after a cross-channel upgrade: rejected as DUPLICATE_OBSERVATION', () => {
    const session = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-REPLAY-AFTER-UPGRADE',
      amountPaise: 10000n
    });
    sessionRepo.acquireSlotAtomic(session.id, accountA.id, 300000);
    const sms = {
      source: 'SMS',
      rawText: 'Received Rs 100.00 on UPI. Ref: 777777000222',
      sender: 'YESBNK',
      receivingAccountId: accountA.id
    };

    // Gmail first, then SMS: the legitimate Level 2 upgrade. The UTR fingerprint now has a
    // GMAIL row and an SMS_GATEWAY row, and the GMAIL row is the one an unfiltered lookup finds.
    assert.equal(pipeline.process({
      source: 'GMAIL',
      rawText: 'Received Rs 100.00 on UPI. Ref: 777777000222',
      sender: 'alerts@yes.bank.in',
      receivingAccountId: accountA.id
    }).status, 'VERIFIED');
    assert.equal(pipeline.process(sms).status, 'VERIFIED');
    assert.equal(sessionRepo.findById(session.id).verificationLevel, 2);
    const upgradesBefore = emittedEvents.filter(e => e.event === 'PAYMENT.VERIFICATION_UPGRADED').length;

    // The observer delivers the same SMS again (retry, or SMS + notification for one credit).
    const replay = pipeline.process(sms);

    assert.equal(replay.status, 'REJECTED');
    assert.equal(replay.failingCondition, 'DUPLICATE_OBSERVATION');
    const rows = db.query('SELECT source FROM payment_observations WHERE bank_reference_number = ?', ['777777000222']);
    assert.deepEqual(rows.map(r => r.source).sort(), [ObserverSource.GMAIL, ObserverSource.SMS_GATEWAY]);
    assert.equal(emittedEvents.filter(e => e.event === 'PAYMENT.VERIFICATION_UPGRADED').length, upgradesBefore);
    assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.OBSERVED_SUCCESS);
  });

  test('7c. Attribution engine drops a same-channel replay even when another channel owns the first row', () => {
    const session = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-ENGINE-REPLAY',
      amountPaise: 10000n
    });
    sessionRepo.acquireSlotAtomic(session.id, accountA.id, 300000);
    const observe = (source) => attributionEngine.processObservation(ObservationNormalizer.normalize({
      receivingAccountId: accountA.id,
      source,
      amountPaise: 10000n,
      bankReferenceNumber: '777777000333',
      observedAt: new Date()
    }));

    assert.equal(observe(ObserverSource.GMAIL).attributed, true);
    assert.equal(observe(ObserverSource.SMS_GATEWAY).attributed, true);
    const replay = observe(ObserverSource.SMS_GATEWAY);

    assert.equal(replay.duplicate, true);
    assert.equal(replay.outcomeStatus, ObservationAttributionStatus.DUPLICATE_IGNORED);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_observations WHERE bank_reference_number = ?', ['777777000333']).n, 2);
  });

  test('8. Concurrent checkout creation: queue and session state remain atomic and consistent', () => {
    // 3 concurrent checkouts on same receiving account
    const s1 = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-CONC-1',
      amountPaise: 10000n
    });
    const s2 = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-CONC-2',
      amountPaise: 10000n
    });
    const s3 = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-CONC-3',
      amountPaise: 10000n
    });

    const q1 = queueEngine.enqueueOrActivate(s1.id, accountA.id);
    const q2 = queueEngine.enqueueOrActivate(s2.id, accountA.id);
    const q3 = queueEngine.enqueueOrActivate(s3.id, accountA.id);

    // Invariant: Exactly ONE active session, remaining are strictly QUEUED
    assert.equal(q1.status, PaymentStatus.ACTIVE);
    assert.equal(q2.status, PaymentStatus.QUEUED);
    assert.equal(q2.queuePosition, 1);
    assert.equal(q3.status, PaymentStatus.QUEUED);
    assert.equal(q3.queuePosition, 2);

    // When s1 succeeds, promoting next activates s2
    sessionRepo.transitionToTerminal(s1.id, PaymentStatus.SUCCESS);
    const promoted = queueEngine.promoteNext(accountA.id);
    assert.equal(promoted.id, s2.id);
    assert.equal(sessionRepo.findById(s2.id).status, PaymentStatus.ACTIVE);
  });
});
