import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database, runMigrations, PaymentSessionRepository, ObservationRepository, SupportTicketRepository, AuditLogRepository } from '@youpi/db';
import { PaymentStatus, ObserverSource } from '@youpi/common';
import { AttributionEngine, ObservationNormalizer, StatementReconciliation, parseStatementCsv, rupeesToPaise } from '@youpi/core';

const ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';

function istDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(value);
}

function istSlash(value = new Date()) {
  const [year, month, day] = istDate(value).split('-');
  return `${day}/${month}/${year}`;
}

function hdfcCsv(dataRows) {
  return [
    'HDFC Bank Limited',
    'Account Number: 50100123456789',
    'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
    ...dataRows
  ].join('\n');
}

function creditRow({ utr = '123456789012', deposit = '499.00', date = istSlash(), narration } = {}) {
  const text = narration || `UPI-TEST PAYER-payer@okhdfcbank-HDFC0000001-${utr}-ORDER 1001`;
  return `${date},"${text}",0,${date},,"${deposit}",10000.00`;
}

describe('bank statement reconciliation', () => {
  let db;
  let sessionRepo;
  let engine;
  let events;
  let merchantId;

  beforeEach(() => {
    db = new Database({ inMemory: true });
    merchantId = runMigrations(db).defaultMerchant.id;
    sessionRepo = new PaymentSessionRepository(db);
    events = [];
    engine = new StatementReconciliation({
      db,
      sessionRepo,
      auditRepo: new AuditLogRepository(db),
      eventEmitter: { emit: (event, payload) => events.push({ event, payload }) }
    });
  });

  afterEach(() => db.close());

  function observe(orderId, amountPaise, utr) {
    const attribution = new AttributionEngine({
      sessionRepo,
      obsRepo: new ObservationRepository(db),
      ticketRepo: new SupportTicketRepository(db),
      auditRepo: new AuditLogRepository(db),
      eventEmitter: { emit: () => {} }
    });
    const session = sessionRepo.create({
      merchantId,
      receivingAccountId: ACCOUNT_ID,
      orderId,
      amountPaise
    });
    sessionRepo.acquireSlotAtomic(session.id, ACCOUNT_ID, 300000);
    sessionRepo.transitionToProcessing(session.id, 30000);
    const result = attribution.processObservation(ObservationNormalizer.normalize({
      source: ObserverSource.GOOGLE_MESSAGES,
      receivingAccountId: ACCOUNT_ID,
      amountPaise,
      bankReferenceNumber: utr,
      observedAt: new Date(),
      rawPayload: { text: `Received ${utr} ${orderId}` }
    }));
    assert.equal(result.outcomeStatus, PaymentStatus.OBSERVED_SUCCESS);
    return sessionRepo.findById(session.id);
  }

  test('parses an HDFC credit, an Indian-grouped amount, and a quoted comma', () => {
    assert.equal(rupeesToPaise('1,499.50'), 149950);
    const parsed = parseStatementCsv(hdfcCsv([
      creditRow({ deposit: '1,499.50', narration: 'UPI-TEST, PAYER-payer@okhdfcbank-HDFC0000001-123456789012-NOTE' })
    ]));
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.lines.length, 1);
    assert.equal(parsed.lines[0].amountPaise, 149950);
    assert.equal(parsed.lines[0].utr, '123456789012');
    assert.equal(parsed.lines[0].direction, 'CREDIT');
    assert.equal(parsed.lines[0].bookedOn, istDate());
  });

  test('a matching HDFC credit reconciles the observed session once', () => {
    const session = observe('ORD-STMT-1', 49900n, '123456789012');
    const csv = hdfcCsv([creditRow()]);
    const first = engine.importCsv({ receivingAccountId: ACCOUNT_ID, csvText: csv });
    assert.equal(first.reconciled, 1);
    assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.RECONCILED);
    assert.equal(events.filter(event => event.event === 'PAYMENT.RECONCILED').length, 1);

    const second = engine.importCsv({ receivingAccountId: ACCOUNT_ID, csvText: csv });
    assert.equal(second.lines[0].outcome, 'DUPLICATE');
    assert.equal(events.filter(event => event.event === 'PAYMENT.RECONCILED').length, 1);
    assert.equal(db.queryOne("SELECT COUNT(*) AS n FROM payment_sessions WHERE status = 'RECONCILED'").n, 1);
  });

  test('a debit, a missing reference, and an unmatched credit do not reconcile', () => {
    const session = observe('ORD-STMT-2', 49900n, '123456789012');
    const csv = hdfcCsv([
      '23/10/2026,"UPI-OUT-payer@okhdfcbank-HDFC0000001-123456789012-OUT",0,23/10/2026,100.00,,9000.00',
      '23/10/2026,"SALARY CREDIT",0,23/10/2026,,25000.00,34000.00',
      creditRow({ utr: '999999999999' })
    ]);
    const result = engine.importCsv({ receivingAccountId: ACCOUNT_ID, csvText: csv });
    assert.equal(result.reconciled, 0);
    assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.OBSERVED_SUCCESS);
    assert.equal(result.lines[0].matchReason, 'DEBIT');
    assert.equal(result.lines[1].matchReason, 'MISSING_REFERENCE');
    assert.equal(result.lines[2].outcome, 'UNMATCHED');
  });

  test('amount and date disagreements move the session to manual review', () => {
    const amountSession = observe('ORD-STMT-AMT', 49900n, '123456789012');
    const amountResult = engine.importCsv({
      receivingAccountId: ACCOUNT_ID,
      csvText: hdfcCsv([creditRow({ deposit: '500.00' })])
    });
    assert.equal(amountResult.reconciled, 0);
    assert.equal(amountResult.lines[0].matchReason, 'AMOUNT_MISMATCH');
    assert.equal(sessionRepo.findById(amountSession.id).status, PaymentStatus.MANUAL_REVIEW);

    const dateSession = observe('ORD-STMT-DATE', 49900n, '223456789012');
    const dateResult = engine.importCsv({
      receivingAccountId: ACCOUNT_ID,
      csvText: hdfcCsv([creditRow({ utr: '223456789012', date: '01/10/2026' })])
    });
    assert.equal(dateResult.lines[0].matchReason, 'STATEMENT_DATE_OUTSIDE_WINDOW');
    assert.equal(sessionRepo.findById(dateSession.id).status, PaymentStatus.MANUAL_REVIEW);
    assert.equal(db.queryOne("SELECT COUNT(*) AS n FROM payment_sessions WHERE status = 'RECONCILED'").n, 0);
  });

  test('two held sessions for one statement reference are not picked apart', () => {
    const obsRepo = new ObservationRepository(db);
    function hold(orderId) {
      const session = sessionRepo.create({
        merchantId,
        receivingAccountId: ACCOUNT_ID,
        orderId,
        amountPaise: 49900n
      });
      sessionRepo.acquireSlotAtomic(session.id, ACCOUNT_ID, 300000);
      sessionRepo.transitionToTerminal(session.id, PaymentStatus.MANUAL_REVIEW);
      return session.id;
    }
    const firstId = hold('ORD-HOLD-1');
    const secondId = hold('ORD-HOLD-2');
    obsRepo.create({
      receivingAccountId: ACCOUNT_ID,
      source: 'GOOGLE_MESSAGES',
      amountPaise: 49900n,
      observedAt: new Date(),
      bankReferenceNumber: '323456789012',
      fingerprintHash: 'fp-hold-statement',
      rawPayload: {}
    });

    const result = engine.importCsv({
      receivingAccountId: ACCOUNT_ID,
      csvText: hdfcCsv([creditRow({ utr: '323456789012' })])
    });
    assert.equal(result.lines[0].matchReason, 'MULTIPLE_SESSIONS');
    assert.equal(sessionRepo.findById(firstId).status, PaymentStatus.MANUAL_REVIEW);
    assert.equal(sessionRepo.findById(secondId).status, PaymentStatus.MANUAL_REVIEW);
  });

  test('one held session is reconciled when the statement reference matches its alert', () => {
    const obsRepo = new ObservationRepository(db);
    const session = sessionRepo.create({
      merchantId,
      receivingAccountId: ACCOUNT_ID,
      orderId: 'ORD-HOLD-ONE',
      amountPaise: 49900n
    });
    sessionRepo.acquireSlotAtomic(session.id, ACCOUNT_ID, 300000);
    sessionRepo.transitionToTerminal(session.id, PaymentStatus.MANUAL_REVIEW);
    obsRepo.create({
      receivingAccountId: ACCOUNT_ID,
      source: 'GOOGLE_MESSAGES',
      amountPaise: 49900n,
      observedAt: new Date(),
      bankReferenceNumber: '523456789012',
      fingerprintHash: 'fp-hold-one',
      rawPayload: {}
    });
    const result = engine.importCsv({
      receivingAccountId: ACCOUNT_ID,
      csvText: hdfcCsv([creditRow({ utr: '523456789012' })])
    });
    assert.equal(result.reconciled, 1);
    const reconciledSession = sessionRepo.findById(session.id);
    assert.equal(reconciledSession.status, PaymentStatus.RECONCILED);
    assert.ok(reconciledSession.attributedObservationId, 'Reconciled MANUAL_REVIEW session must link attributedObservationId');
  });

  test('corroborates LATE_UNMATCHED observations during statement import and emits PAYMENT.UNMATCHED_RECONCILIATION_NEEDED', () => {
    const obsRepo = new ObservationRepository(db);
    const expiredSession = sessionRepo.create({
      merchantId,
      receivingAccountId: ACCOUNT_ID,
      orderId: 'ORD-LATE-STMT-1',
      amountPaise: 49900n
    });
    sessionRepo.acquireSlotAtomic(expiredSession.id, ACCOUNT_ID, 300000);
    sessionRepo.transitionToTerminal(expiredSession.id, PaymentStatus.EXPIRED);

    const lateObs = obsRepo.create({
      receivingAccountId: ACCOUNT_ID,
      source: 'GOOGLE_MESSAGES',
      amountPaise: 49900n,
      observedAt: new Date(),
      bankReferenceNumber: '623456789012',
      fingerprintHash: 'fp-late-unmatched-stmt',
      rawPayload: {}
    });
    obsRepo.markLateUnmatched(lateObs.id, expiredSession.id);

    const result = engine.importCsv({
      receivingAccountId: ACCOUNT_ID,
      csvText: hdfcCsv([creditRow({ utr: '623456789012' })])
    });
    assert.equal(result.unmatched, 1);
    assert.equal(result.lines[0].outcome, 'UNMATCHED');
    assert.equal(result.lines[0].observationId, lateObs.id);
    assert.equal(result.lines[0].candidatePaymentSessionId, expiredSession.id);
    assert.equal(sessionRepo.findById(expiredSession.id).status, PaymentStatus.EXPIRED);
    assert.equal(events.filter(e => e.event === 'PAYMENT.UNMATCHED_RECONCILIATION_NEEDED').length, 1);
  });

  test('a statement line does not settle a session that was never observed', () => {
    const session = sessionRepo.create({
      merchantId,
      receivingAccountId: ACCOUNT_ID,
      orderId: 'ORD-UNOBSERVED',
      amountPaise: 49900n
    });
    sessionRepo.acquireSlotAtomic(session.id, ACCOUNT_ID, 300000);
    const result = engine.importCsv({
      receivingAccountId: ACCOUNT_ID,
      csvText: hdfcCsv([creditRow()])
    });
    assert.equal(result.lines[0].outcome, 'UNMATCHED');
    assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.ACTIVE);
  });

  test('rejects a file that has no statement header', () => {
    const result = engine.importCsv({ receivingAccountId: ACCOUNT_ID, csvText: 'hello,world\n1,2\n' });
    assert.equal(result.error, 'UNSUPPORTED_STATEMENT');
  });
});
