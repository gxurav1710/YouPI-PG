import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import '../../../../scripts/test-support.js';
import { Database, runMigrations, MerchantRepository, PaymentSessionRepository } from '@youpi/db';
import { createPaymentApp } from '../../../../apps/payment-api/src/index.js';
import { createOfflineWhatsApp } from '../../../../apps/payment-api/src/__tests__/fixtures/offline-whatsapp.js';

const waitFor = async (condition, description, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), `Timed out waiting for ${description}`);
};

test('webhook recovery delivers healthy events behind invalid endpoints without starvation (Issue #120)', async () => {
  const originalCheckout = process.env.BASE_CHECKOUT_URL;
  const originalPrivate = process.env.YOUPI_ALLOW_PRIVATE_WEBHOOKS;
  const originalRetryInterval = process.env.WEBHOOK_RETRY_INTERVAL_MS;

  process.env.BASE_CHECKOUT_URL = 'http://127.0.0.1:7000';
  process.env.YOUPI_ALLOW_PRIVATE_WEBHOOKS = 'true';
  process.env.WEBHOOK_RETRY_INTERVAL_MS = '25';

  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200);
      res.end('ok');
    });
  });

  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const receiverPort = receiver.address().port;
  const db = new Database({ inMemory: true });
  let app;

  try {
    const { defaultMerchant: blocked } = runMigrations(db);
    const merchants = new MerchantRepository(db);
    const sessions = new PaymentSessionRepository(db);

    // Set blocked merchant to invalid non-URL string
    merchants.update(blocked.id, { webhookUrl: 'not-a-url', webhookSecret: 'synthetic-blocked-secret' });

    const healthy = merchants.create({
      businessName: 'Synthetic healthy merchant',
      slug: 'healthy-repro',
      contactEmail: 'synthetic@example.com',
      contactPhone: '9000000000',
      webhookUrl: `http://127.0.0.1:${receiverPort}/webhook`,
      webhookSecret: 'synthetic-healthy-secret'
    });

    const add = (merchant, index) => {
      const session = sessions.create({
        merchantId: merchant.id,
        orderId: `SYNTHETIC-${index}`,
        amountPaise: 100n,
        status: 'ACTIVE'
      });
      sessions.transitionToTerminal(session.id, 'EXPIRED');
      db.execute(
        'UPDATE payment_webhook_outbox SET created_at = ? WHERE payment_id = ?',
        [new Date(1700000000000 + index).toISOString(), session.id]
      );
      return session;
    };

    // Pre-populate 100 invalid outbox items followed by 1 healthy item
    for (let i = 0; i < 100; i++) add(blocked, i);
    const eligible = add(healthy, 100);

    app = createPaymentApp(db, { whatsappBerryService: createOfflineWhatsApp() });

    // 1. Verify healthy merchant is delivered even though 100 blocked merchant entries precede it
    await waitFor(() => received.length >= 1, 'healthy merchant delivery');
    assert.equal(received.length, 1);
    assert.equal(received[0].paymentId, eligible.id);

    // 2. Verify invalid configurations remain in the outbox without synthetic failure rows
    const retained = db.queryOne(
      'SELECT COUNT(*) n FROM payment_webhook_outbox o JOIN payment_sessions s ON s.id = o.payment_id WHERE s.merchant_id = ?',
      [blocked.id]
    ).n;
    assert.equal(retained, 100);

    const syntheticFailures = db.queryOne(
      'SELECT COUNT(*) n FROM webhook_deliveries WHERE merchant_id = ?',
      [blocked.id]
    ).n;
    assert.equal(syntheticFailures, 0);

    // 3. Repair the blocked merchant configuration and verify progressive recovery
    merchants.update(blocked.id, { webhookUrl: `http://127.0.0.1:${receiverPort}/webhook` });

    await waitFor(() => received.length === 101, 'all 101 webhooks received post-repair');
    assert.equal(received.length, 101);

    await waitFor(() => {
      const rem = db.queryOne('SELECT COUNT(*) n FROM payment_webhook_outbox').n;
      return rem === 0;
    }, 'outbox completely cleared after repair');
  } finally {
    app?.destroy();
    await new Promise(resolve => receiver.close(resolve));
    db.close();

    if (originalCheckout !== undefined) process.env.BASE_CHECKOUT_URL = originalCheckout;
    else delete process.env.BASE_CHECKOUT_URL;
    if (originalPrivate !== undefined) process.env.YOUPI_ALLOW_PRIVATE_WEBHOOKS = originalPrivate;
    else delete process.env.YOUPI_ALLOW_PRIVATE_WEBHOOKS;
    if (originalRetryInterval !== undefined) process.env.WEBHOOK_RETRY_INTERVAL_MS = originalRetryInterval;
    else delete process.env.WEBHOOK_RETRY_INTERVAL_MS;
  }
});
