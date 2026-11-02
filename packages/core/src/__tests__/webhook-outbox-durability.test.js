import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../../../scripts/test-support.js';
import { Database, runMigrations, MerchantRepository, PaymentSessionRepository } from '@youpi/db';
import { WebhookEngine } from '../webhook-engine.js';

function fixture(slug) {
  const db = new Database({ inMemory: true });
  runMigrations(db);
  const merchants = new MerchantRepository(db);
  const sessions = new PaymentSessionRepository(db);
  const merchant = merchants.create({
    businessName: 'Synthetic webhook fixture',
    slug,
    contactEmail: slug + '@example.com',
    contactPhone: '9000000000',
    webhookUrl: 'http://localhost:54321/webhook',
    webhookSecret: 'synthetic_hmac_secret_for_webhook_tests'
  });
  const engine = new WebhookEngine({ db, merchantRepo: merchants, sessionRepo: sessions });
  return { db, merchants, sessions, merchant, engine };
}

test('outbox survives terminal transition and is prepared before network dispatch', async () => {
  const { db, sessions, merchant, engine } = fixture('durable-terminal');
  const previousFetch = globalThis.fetch;
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'DURABLE-1', amountPaise: 100n, status: 'ACTIVE' });
    sessions.transitionToTerminal(session.id, 'EXPIRED');
    assert.equal(db.queryOne('SELECT event_type FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]).event_type, 'EXPIRED');

    let requestCount = 0;
    globalThis.fetch = async (_url, opts) => {
      requestCount++;
      const row = db.queryOne('SELECT * FROM webhook_deliveries WHERE payment_id = ?', [session.id]);
      assert.ok(row, 'delivery MUST be durable before fetch');
      assert.equal(row.is_successful, 0);
      // The first request is still in flight. Zero marks it for immediate boot
      // recovery; dispatch increments the count after this request completes.
      assert.equal(row.attempt_count, 0);
      assert.ok(row.next_retry_at, 'crash recovery lease MUST be set');
      assert.equal(row.id, opts.headers['X-Gateway-Delivery-Id']);
      return { ok: true, status: 200, text: async () => 'ok' };
    };

    const recovered = await engine.recoverOutbox();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].delivered, true);
    assert.equal(requestCount, 1);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]).n, 0);
    assert.equal((await engine.recoverOutbox()).length, 0);
    const duplicate = await engine.dispatch('EXPIRED', sessions.findById(session.id));
    assert.equal(duplicate.deliveryId, recovered[0].deliveryId);
    assert.equal(requestCount, 1, 'duplicate terminal events MUST NOT issue another delivery');
  } finally {
    globalThis.fetch = previousFetch;
    db.close();
  }
});

test('interrupted first attempt remains eligible for restart retry with the same delivery ID and body', async () => {
  const { db, sessions, merchant, engine, merchants } = fixture('durable-restart');
  const previousFetch = globalThis.fetch;
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'DURABLE-2', amountPaise: 200n });
    let initialBody;
    globalThis.fetch = async (_url, opts) => {
      const row = db.queryOne('SELECT * FROM webhook_deliveries WHERE payment_id = ?', [session.id]);
      assert.ok(row, 'network must not start before persistence');
      initialBody = opts.body;
      assert.equal(row.payload, initialBody);
      throw new Error('synthetic network failure');
    };
    const failed = await engine.dispatch('SUCCESS', session);
    assert.equal(failed.delivered, false);
    const pending = db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [failed.deliveryId]);
    assert.equal(pending.is_successful, 0);
    assert.equal(pending.attempt_count, 1);
    assert.ok(pending.next_retry_at);

    db.execute('UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), pending.id]);
    const afterRestart = new WebhookEngine({ db, merchantRepo: merchants, sessionRepo: sessions });
    let resent = 0;
    globalThis.fetch = async (_url, opts) => {
      resent++;
      assert.equal(opts.headers['X-Gateway-Delivery-Id'], pending.id);
      assert.equal(opts.body, initialBody);
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const results = await afterRestart.retryPending();
    assert.equal(results.length, 1);
    assert.equal(results[0].success, true);
    assert.equal(resent, 1);
    assert.equal(db.queryOne('SELECT is_successful FROM webhook_deliveries WHERE id = ?', [pending.id]).is_successful, 1);
  } finally {
    globalThis.fetch = previousFetch;
    db.close();
  }
});

test('missing merchant signing key preserves an outboxed event until configuration is repaired', async () => {
  const { db, sessions, merchant, engine, merchants } = fixture('durable-key-rotation');
  const previousFetch = globalThis.fetch;
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'DURABLE-3', amountPaise: 300n, status: 'ACTIVE' });
    sessions.transitionToTerminal(session.id, 'EXPIRED');
    db.execute("UPDATE merchants SET webhook_secret = '' WHERE id = ?", [merchant.id]);
    assert.equal((await engine.recoverOutbox()).length, 0);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE payment_id = ?', [session.id]).n, 0);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]).n, 1);
    merchants.update(merchant.id, { webhookSecret: 'newly_rotated_synthetic_test_secret' });
    let attempted = 0;
    globalThis.fetch = async () => {
      attempted++;
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const replayed = await engine.recoverOutbox();
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].delivered, true);
    assert.equal(attempted, 1);
  } finally {
    globalThis.fetch = previousFetch;
    db.close();
  }
});
