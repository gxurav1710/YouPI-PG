import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../../../../scripts/test-support.js';
import { Database, runMigrations, MerchantRepository, PaymentSessionRepository, ObservationRepository, SupportTicketRepository, AuditLogRepository } from '@youpi/db';
import { WebhookEngine } from '../webhook-engine.js';
import { AttributionEngine } from '../attribution-engine.js';
import { ObservationNormalizer } from '../normalizer.js';
import { StatementReconciliation } from '../statement-reconciliation.js';

function fixture() {
  const db = new Database({ inMemory: true });
  runMigrations(db);
  const merchants = new MerchantRepository(db);
  const merchant = merchants.create({ businessName: 'Synthetic outcomes', slug: 'outcome-fixture', contactEmail: 'outcomes@example.com', contactPhone: '9000000000', webhookUrl: 'http://localhost:54321/webhook', webhookSecret: 'synthetic_outcome_test_secret' });
  const sessions = new PaymentSessionRepository(db);
  return { db, sessions, merchant, engine: new WebhookEngine({ db, merchantRepo: merchants, sessionRepo: sessions }) };
}

for (const outcome of ['OBSERVED_SUCCESS', 'MANUAL_REVIEW', 'RECONCILED', 'EXPIRED']) {
  test(`${outcome} survives a commit before dispatch`, async () => {
    const { db, sessions, merchant, engine } = fixture();
    const previousFetch = globalThis.fetch;
    try {
      const session = sessions.create({ merchantId: merchant.id, orderId: `CRASH-${outcome}`, amountPaise: 300n, status: outcome === 'RECONCILED' ? 'OBSERVED_SUCCESS' : 'ACTIVE' });
      sessions.transitionToTerminal(session.id, outcome);
      assert.equal(db.queryOne('SELECT event_type FROM payment_webhook_outbox WHERE payment_id = ?', [session.id])?.event_type, outcome);
      const received = [];
      globalThis.fetch = async (_url, options) => { received.push(JSON.parse(options.body)); return { ok: true, status: 200, text: async () => 'ok' }; };
      await engine.recoverOutbox();
      assert.deepEqual(received.map(item => item.event), [outcome]);
      assert.equal((await engine.recoverOutbox()).length, 0);
    } finally { globalThis.fetch = previousFetch; db.close(); }
  });
}

test('observed then reconciled before dispatch retains two distinct durable events', async () => {
  const { db, sessions, merchant, engine } = fixture();
  const previousFetch = globalThis.fetch;
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'TWO-EVENTS', amountPaise: 300n, status: 'ACTIVE' });
    sessions.transitionToTerminal(session.id, 'OBSERVED_SUCCESS');
    sessions.transitionToTerminal(session.id, 'RECONCILED');
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]).n, 2);
    const received = [];
    globalThis.fetch = async (_url, options) => { received.push(JSON.parse(options.body)); return { ok: true, status: 200, text: async () => 'ok' }; };
    await engine.recoverOutbox();
    assert.deepEqual(received.map(item => item.event).sort(), ['OBSERVED_SUCCESS', 'RECONCILED']);
    assert.equal(new Set(received.map(item => item.deliveryId)).size, 2);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox').n, 0);
    assert.equal((await engine.recoverOutbox()).length, 0);
  } finally { globalThis.fetch = previousFetch; db.close(); }
});

test('terminal transition rollback leaves no event', () => {
  const { db, sessions, merchant } = fixture();
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'ROLLBACK', amountPaise: 300n, status: 'ACTIVE' });
    assert.throws(() => db.transaction(() => { sessions.transitionToTerminal(session.id, 'OBSERVED_SUCCESS'); throw new Error('rollback'); }), /rollback/);
    assert.equal(sessions.findById(session.id).status, 'ACTIVE');
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox').n, 0);
  } finally { db.close(); }
});

test('dispatching one outcome preserves the next pending event when configuration fails', async () => {
  const { db, sessions, merchant, engine } = fixture();
  const previousFetch = globalThis.fetch;
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'EVENT-SCOPE', amountPaise: 300n, status: 'ACTIVE' });
    sessions.transitionToTerminal(session.id, 'OBSERVED_SUCCESS');
    sessions.transitionToTerminal(session.id, 'RECONCILED');
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
    await engine.dispatch('OBSERVED_SUCCESS', sessions.findById(session.id));
    assert.deepEqual(db.query('SELECT event_type FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]).map(row => row.event_type), ['RECONCILED']);
    db.execute("UPDATE merchants SET webhook_secret = '' WHERE id = ?", [merchant.id]);
    assert.equal((await engine.dispatch('RECONCILED', sessions.findById(session.id))).delivered, false);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE payment_id = ? AND event_type = ?', [session.id, 'RECONCILED']).n, 0);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]).n, 1);
  } finally { globalThis.fetch = previousFetch; db.close(); }
});

test('legacy upgrade preserves pending event and timestamp without queuing history, and is repeatable', () => {
  const { db, sessions, merchant } = fixture();
  try {
    const old = sessions.create({ merchantId: merchant.id, orderId: 'HISTORY', amountPaise: 300n, status: 'RECONCILED' });
    const pending = sessions.create({ merchantId: merchant.id, orderId: 'PENDING', amountPaise: 300n, status: 'EXPIRED' });
    db.exec(`
      DROP TRIGGER trg_terminal_payment_webhook_outbox;
      DROP TABLE payment_webhook_outbox;
      CREATE TABLE payment_webhook_outbox (
        payment_id TEXT PRIMARY KEY REFERENCES payment_sessions(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK(event_type IN ('SUCCESS','FAILED','EXPIRED','CANCELLED')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TRIGGER trg_terminal_payment_webhook_outbox AFTER UPDATE OF status ON payment_sessions
      WHEN NEW.status IN ('SUCCESS','FAILED','EXPIRED','CANCELLED') AND OLD.status NOT IN ('SUCCESS','FAILED','EXPIRED','CANCELLED')
      BEGIN INSERT OR IGNORE INTO payment_webhook_outbox (payment_id, event_type) VALUES (NEW.id, NEW.status); END;
    `);
    db.execute('INSERT INTO payment_webhook_outbox VALUES (?, ?, ?)', [pending.id, 'EXPIRED', '2026-10-28T00:00:00.123Z']);
    runMigrations(db);
    runMigrations(db);
    const rows = db.query('SELECT * FROM payment_webhook_outbox');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payment_id, pending.id);
    assert.equal(rows[0].created_at, '2026-10-28T00:00:00.123Z');
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox WHERE payment_id = ?', [old.id]).n, 0);
    const modern = sessions.create({ merchantId: merchant.id, orderId: 'AFTER-UPGRADE', amountPaise: 300n, status: 'ACTIVE' });
    sessions.transitionToTerminal(modern.id, 'OBSERVED_SUCCESS');
    sessions.transitionToTerminal(modern.id, 'RECONCILED');
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox WHERE payment_id = ?', [modern.id]).n, 2);
    db.execute('DELETE FROM payment_sessions WHERE id = ?', [modern.id]);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox WHERE payment_id = ?', [modern.id]).n, 0);
  } finally { db.close(); }
});

test('legacy outbox migration rolls back DDL and pending rows if replacement fails', () => {
  const { db, sessions, merchant } = fixture();
  const originalExec = db.exec.bind(db);
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'UPGRADE-ROLLBACK', amountPaise: 300n, status: 'EXPIRED' });
    originalExec(`DROP TRIGGER trg_terminal_payment_webhook_outbox; DROP TABLE payment_webhook_outbox;
      CREATE TABLE payment_webhook_outbox (payment_id TEXT PRIMARY KEY REFERENCES payment_sessions(id), event_type TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TRIGGER trg_terminal_payment_webhook_outbox AFTER UPDATE OF status ON payment_sessions
      WHEN NEW.status = 'EXPIRED' BEGIN INSERT OR IGNORE INTO payment_webhook_outbox VALUES (NEW.id, NEW.status, 'legacy'); END;`);
    db.execute('INSERT INTO payment_webhook_outbox VALUES (?, ?, ?)', [session.id, 'EXPIRED', 'legacy-time']);
    db.exec = sql => { if (sql.includes('CREATE TABLE payment_webhook_outbox_upgrade')) { originalExec(sql); throw new Error('synthetic migration failure'); } return originalExec(sql); };
    assert.throws(() => runMigrations(db), /synthetic migration failure/);
    db.exec = originalExec;
    assert.equal(db.queryOne('SELECT created_at FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]).created_at, 'legacy-time');
    assert.equal(db.queryOne("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'payment_webhook_outbox_upgrade'").n, 0);
    assert.equal(db.queryOne("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'trg_terminal_payment_webhook_outbox'").n, 1);
    runMigrations(db);
    assert.equal(db.query('PRAGMA table_info(payment_webhook_outbox)').find(column => column.name === 'event_type').pk, 2);
  } finally { db.exec = originalExec; db.close(); }
});

test('real observer and statement workflow persists both events without an event listener', async () => {
  const { db, sessions, merchant, engine } = fixture();
  const previousFetch = globalThis.fetch;
  try {
    const accountId = '00000000-0000-0000-0000-000000000002';
    const session = sessions.create({ merchantId: merchant.id, receivingAccountId: accountId, orderId: 'REAL-WORKFLOW', amountPaise: 300n });
    sessions.acquireSlotAtomic(session.id, accountId, 300000);
    sessions.transitionToProcessing(session.id, 30000);
    const auditRepo = new AuditLogRepository(db);
    const attribution = new AttributionEngine({ sessionRepo: sessions, obsRepo: new ObservationRepository(db), ticketRepo: new SupportTicketRepository(db), auditRepo, eventEmitter: { emit() {} } });
    const result = attribution.processObservation(ObservationNormalizer.normalize({ source: 'GOOGLE_MESSAGES', receivingAccountId: accountId, amountPaise: 300n, bankReferenceNumber: '123456789012', observedAt: new Date(), rawPayload: { text: 'Synthetic bank observation 123456789012' } }));
    assert.equal(result.outcomeStatus, 'OBSERVED_SUCCESS');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const [year, month, day] = today.split('-');
    const date = `${day}/${month}/${year}`;
    const csv = ['HDFC Bank Limited', 'Account Number: synthetic', 'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance', `${date},UPI-SYNTHETIC-123456789012,0,${date},,3.00,3.00`].join('\n');
    const statement = new StatementReconciliation({ db, sessionRepo: sessions, auditRepo, eventEmitter: { emit() {} } });
    assert.equal(statement.importCsv({ receivingAccountId: accountId, csvText: csv }).reconciled, 1);
    assert.equal(sessions.findById(session.id).status, 'RECONCILED');
    const received = [];
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      const expected = crypto.createHmac('sha256', merchant.webhookSecret).update(options.body).digest('hex');
      assert.equal(options.headers['X-Gateway-Signature'], `sha256=${expected}`);
      assert.equal(payload.utr, '123456789012');
      assert.equal(payload.amountPaise, 300);
      received.push(payload);
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    await engine.recoverOutbox();
    assert.equal(received.length, 2);
    assert.equal(received.find(item => item.event === 'OBSERVED_SUCCESS').settlementState, 'NOT_RECONCILED');
    assert.equal(received.find(item => item.event === 'RECONCILED').settlementState, 'RECONCILED');
  } finally { globalThis.fetch = previousFetch; db.close(); }
});

test('disk reopen replays both committed outcomes once without requiring historical backfill', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-outbox-outcomes-'));
  const dbPath = path.join(directory, 'gateway.sqlite');
  let db = new Database({ dbPath });
  const previousFetch = globalThis.fetch;
  try {
    const merchant = new MerchantRepository(db).create({ businessName: 'Disk fixture', slug: 'disk-fixture', contactEmail: 'disk@example.com', contactPhone: '9000000000', webhookUrl: 'http://localhost:54321/webhook', webhookSecret: 'synthetic_disk_webhook_secret' });
    const sessions = new PaymentSessionRepository(db);
    const session = sessions.create({ merchantId: merchant.id, orderId: 'REOPEN', amountPaise: 300n, status: 'ACTIVE' });
    sessions.transitionToTerminal(session.id, 'OBSERVED_SUCCESS');
    sessions.transitionToTerminal(session.id, 'RECONCILED');
    db.close();
    db = new Database({ dbPath });
    runMigrations(db);
    const engine = new WebhookEngine({ db, merchantRepo: new MerchantRepository(db) });
    const received = [];
    globalThis.fetch = async (_url, options) => { received.push(JSON.parse(options.body)); return { ok: true, status: 200, text: async () => 'ok' }; };
    await engine.recoverOutbox();
    assert.deepEqual(received.map(item => item.event).sort(), ['OBSERVED_SUCCESS', 'RECONCILED']);
    await engine.recoverOutbox();
    assert.equal(received.length, 2);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE payment_id = ?', [session.id]).n, 2);
  } finally { globalThis.fetch = previousFetch; db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('repeated same outcome is idempotent while a three-event review lifecycle keeps all events', async () => {
  const { db, sessions, merchant, engine } = fixture();
  const previousFetch = globalThis.fetch;
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'REVIEW-LIFECYCLE', amountPaise: 300n, status: 'ACTIVE' });
    for (const outcome of ['OBSERVED_SUCCESS', 'OBSERVED_SUCCESS', 'MANUAL_REVIEW', 'MANUAL_REVIEW', 'RECONCILED', 'RECONCILED']) sessions.transitionToTerminal(session.id, outcome);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]).n, 3);
    const received = [];
    globalThis.fetch = async (_url, options) => { received.push(JSON.parse(options.body)); return { ok: true, status: 200, text: async () => 'ok' }; };
    await engine.recoverOutbox();
    assert.deepEqual(received.map(item => item.event).sort(), ['MANUAL_REVIEW', 'OBSERVED_SUCCESS', 'RECONCILED']);
    assert.equal(new Set(received.map(item => item.deliveryId)).size, 3);
  } finally { globalThis.fetch = previousFetch; db.close(); }
});

test('reconciled retry preserves its original signed bytes, timestamp and ID', async () => {
  const { db, sessions, merchant, engine } = fixture();
  const previousFetch = globalThis.fetch;
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'RECONCILED-RETRY', amountPaise: 300n, status: 'OBSERVED_SUCCESS' });
    sessions.transitionToTerminal(session.id, 'RECONCILED');
    const requests = [];
    globalThis.fetch = async (_url, options) => { requests.push(options); return { ok: requests.length > 1, status: requests.length > 1 ? 200 : 503, text: async () => 'synthetic response' }; };
    await engine.recoverOutbox();
    db.execute('UPDATE webhook_deliveries SET next_retry_at = ? WHERE payment_id = ?', ['2000-01-01T00:00:00.000Z', session.id]);
    await engine.retryPending();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body, requests[0].body);
    for (const name of ['X-Gateway-Delivery-Id', 'X-Gateway-Timestamp', 'X-Gateway-Signature', 'X-Gateway-Signature-V2']) assert.equal(requests[1].headers[name], requests[0].headers[name]);
    const expected = crypto.createHmac('sha256', merchant.webhookSecret).update(`${requests[1].headers['X-Gateway-Timestamp']}.${requests[1].body}`).digest('hex');
    assert.equal(requests[1].headers['X-Gateway-Signature-V2'], `sha256=${expected}`);
  } finally { globalThis.fetch = previousFetch; db.close(); }
});
