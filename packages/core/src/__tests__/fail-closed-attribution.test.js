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

  test('9. Cross-channel vs same-channel-family deduplication: SMS_GATEWAY + ANDROID_OBSERVER does not falsely upgrade to Level 2', () => {
    const session = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      orderId: 'ORD-SAME-FAMILY-DEDUP',
      amountPaise: 25000n
    });
    sessionRepo.acquireSlotAtomic(session.id, accountA.id, 300000);

    // 1st SMS observation via SMS_GATEWAY
    const smsRes = pipeline.process({
      source: 'SMS_GATEWAY',
      rawText: 'Received Rs 250.00 on UPI. Ref: 888877776666',
      sender: 'HDFCBK',
      receivingAccountId: accountA.id
    });
    assert.equal(smsRes.status, 'VERIFIED');
    assert.equal(sessionRepo.findById(session.id).verificationLevel, 1);

    // 2nd observation of the same SMS via ANDROID_OBSERVER (same SMS channel family, NOT Gmail)
    const androidDupRes = pipeline.process({
      source: 'ANDROID_OBSERVER',
      rawText: 'Received Rs 250.00 on UPI. Ref: 888877776666',
      sender: 'HDFCBK',
      receivingAccountId: accountA.id
    });
    assert.equal(androidDupRes.status, 'REJECTED');
    assert.equal(androidDupRes.failingCondition, 'DUPLICATE_OBSERVATION');
    assert.equal(sessionRepo.findById(session.id).verificationLevel, 1, 'Same-family SMS replay must not upgrade to Level 2');

    // 3rd observation via independent GMAIL channel upgrades to Level 2 Dual Verification
    const gmailRes = pipeline.process({
      source: 'GMAIL',
      rawText: 'Dear Customer, Rs 250.00 has been credited to your account via UPI. Ref: 888877776666',
      sender: 'alerts@hdfc.bank.in',
      receivingAccountId: accountA.id
    });
    assert.equal(gmailRes.status, 'VERIFIED');
    const updated = sessionRepo.findById(session.id);
    assert.equal(updated.verificationLevel, 2);
    assert.match(updated.verificationTag, /Dual Verification/);
  });

  test('10. Conflicting UTR during in-flight grace window holds session in MANUAL_REVIEW instead of upgrading to Level 2', () => {
    const graceEngine = new AttributionEngine({
      sessionRepo,
      obsRepo,
      ticketRepo,
      auditRepo,
      gracePeriodMs: 5000
    });

    try {
      const session = sessionRepo.create({
        merchantId: merchantA.id,
        receivingAccountId: accountA.id,
        orderId: 'ORD-CONFLICT-GRACE',
        amountPaise: 30000n
      });
      sessionRepo.acquireSlotAtomic(session.id, accountA.id, 300000);

      // 1st observation starts 5s grace window with UTR 111122223333
      const obs1 = graceEngine.processObservation(ObservationNormalizer.normalize({
        receivingAccountId: accountA.id,
        source: ObserverSource.SMS_GATEWAY,
        amountPaise: 30000n,
        bankReferenceNumber: '111122223333',
        observedAt: new Date()
      }));
      assert.equal(obs1.attributed, true);
      assert.equal(obs1.outcomeStatus, 'VERIFYING');

      // 2nd observation arrives during grace window for same amount but CONFLICTING UTR 444455556666
      const obs2 = graceEngine.processObservation(ObservationNormalizer.normalize({
        receivingAccountId: accountA.id,
        source: ObserverSource.GMAIL,
        amountPaise: 30000n,
        bankReferenceNumber: '444455556666',
        observedAt: new Date()
      }));
      assert.equal(obs2.attributed, false);
      assert.equal(obs2.ambiguous, true);
      assert.equal(obs2.outcomeStatus, PaymentStatus.MANUAL_REVIEW);
      assert.equal(obs2.reason, 'CONFLICTING_UTR_ON_SESSION');

      const heldSession = sessionRepo.findById(session.id);
      assert.equal(heldSession.status, PaymentStatus.MANUAL_REVIEW);

      // Subsequent observer alerts cannot move a MANUAL_REVIEW session to OBSERVED_SUCCESS
      const obs3 = graceEngine.processObservation(ObservationNormalizer.normalize({
        receivingAccountId: accountA.id,
        source: ObserverSource.GMAIL,
        amountPaise: 30000n,
        bankReferenceNumber: '111122223333',
        observedAt: new Date()
      }));
      assert.equal(obs3.attributed, false);
      assert.equal(obs3.outcomeStatus, PaymentStatus.MANUAL_REVIEW);
      assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.MANUAL_REVIEW);
    } finally {
      graceEngine.destroy();
    }
  });

  test('11. Delayed and unmatched observations are reconciled into LATE_UNMATCHED with audit trail and support tickets', () => {
    const customer = customerRepo.create({
      name: 'Delayed Payer',
      email: 'delayed@example.com',
      mobileNumber: '9876500001'
    });
    const session = sessionRepo.create({
      merchantId: merchantA.id,
      receivingAccountId: accountA.id,
      customerId: customer.id,
      orderId: 'ORD-DELAYED-RECON',
      amountPaise: 42000n
    });
    sessionRepo.acquireSlotAtomic(session.id, accountA.id, 300000);

    // 1. Unmatched observation arrives while session is not yet expired (or stored as UNATTRIBUTED first)
    const rawUnattributed = obsRepo.create({
      receivingAccountId: accountA.id,
      source: ObserverSource.SMS_GATEWAY,
      amountPaise: 42000n,
      bankReferenceNumber: '909090121212',
      fingerprintHash: 'fp-unmatched-recon-420',
      observedAt: new Date()
    });
    assert.equal(rawUnattributed.attributionStatus, ObservationAttributionStatus.UNATTRIBUTED);

    // 2. Session expires before attribution
    sessionRepo.transitionToTerminal(session.id, PaymentStatus.EXPIRED);

    // 3. Reconciling unmatched observations links it to the expired session as LATE_UNMATCHED and opens a ticket
    const reconSummary = attributionEngine.reconcileUnmatchedObservations(accountA.id);
    assert.equal(reconSummary.processed, 1);
    assert.equal(reconSummary.reconciledCount, 1);
    assert.equal(reconSummary.results[0].outcomeStatus, ObservationAttributionStatus.LATE_UNMATCHED);
    assert.equal(reconSummary.results[0].paymentSessionId, session.id);

    const updatedObs = obsRepo.findById(rawUnattributed.id);
    assert.equal(updatedObs.attributionStatus, ObservationAttributionStatus.LATE_UNMATCHED);
    assert.equal(updatedObs.rawPayload.lateMatchedSessionId, session.id);
    assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.EXPIRED, 'Expired session must remain EXPIRED');

    const tickets = db.query('SELECT * FROM support_tickets WHERE payment_id = ?', [session.id]);
    assert.equal(tickets.length, 1);
    assert.match(tickets[0].subject, /LATE PAYMENT DETECTED/);
  });
});
