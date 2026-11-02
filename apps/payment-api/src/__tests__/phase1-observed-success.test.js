import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Database, runMigrations, PaymentSessionRepository, ObservationRepository, SupportTicketRepository, AuditLogRepository } from '@youpi/db';
import { PaymentStatus, ObservationAttributionStatus } from '@youpi/common';
import { AttributionEngine, ObservationNormalizer } from '@youpi/core';
import { startServer as startPaymentApi } from '../index.js';
import { CoinWalletStoreServer } from '../../../coin-wallet-store/src/server.js';
import { authHeadersFor } from '../../../../scripts/test-support.js';

describe('Phase 1 observed success and matching safety', () => {
  describe('ambiguous alerts are not auto-attributed', () => {
    let db;
    let sessionRepo;
    let attributionEngine;
    let emittedEvents;
    const accountId = '00000000-0000-0000-0000-000000000002';

    let merchantId;

    beforeEach(() => {
      db = new Database({ inMemory: true });
      const seed = runMigrations(db);
      merchantId = seed.defaultMerchant.id;
      sessionRepo = new PaymentSessionRepository(db);
      emittedEvents = [];
      attributionEngine = new AttributionEngine({
        sessionRepo,
        obsRepo: new ObservationRepository(db),
        ticketRepo: new SupportTicketRepository(db),
        auditRepo: new AuditLogRepository(db),
        eventEmitter: { emit: (event, payload) => emittedEvents.push({ event, payload }) }
      });
    });

    afterEach(() => db.close());

    function activate(orderId) {
      const session = sessionRepo.create({
        merchantId,
        receivingAccountId: accountId,
        orderId,
        amountPaise: 20000n
      });
      sessionRepo.acquireSlotAtomic(session.id, accountId, 300000);
      sessionRepo.transitionToProcessing(session.id, 30000);
      return sessionRepo.findById(session.id);
    }

    test('a live session plus a recent same-amount expiry is held for manual review', () => {
      const expired = activate('ORD-EXPIRED-SAME');
      sessionRepo.transitionToTerminal(expired.id, PaymentStatus.EXPIRED, { reason: 'WINDOW_ELAPSED' });
      const live = activate('ORD-LIVE-SAME');
      assert.ok(live.slotAcquiredAt);

      const obs = ObservationNormalizer.normalize({
        source: 'GOOGLE_MESSAGES',
        receivingAccountId: accountId,
        amountPaise: 20000n,
        bankReferenceNumber: 'UTR-AMBIGUOUS-1',
        observedAt: new Date(live.slotAcquiredAt.getTime() - 60_000),
        rawPayload: { text: 'Received Rs 200' }
      });
      const result = attributionEngine.processObservation(obs);

      assert.equal(result.attributed, false);
      assert.equal(result.ambiguous, true);
      assert.equal(result.outcomeStatus, PaymentStatus.MANUAL_REVIEW);
      assert.equal(sessionRepo.findById(live.id).status, PaymentStatus.MANUAL_REVIEW);
      assert.equal(sessionRepo.findById(expired.id).status, PaymentStatus.EXPIRED);
      assert.equal(emittedEvents.some(e => e.event === 'PAYMENT.OBSERVED_SUCCESS'), false);
      const stored = db.queryOne('SELECT attribution_status FROM payment_observations WHERE id = ?', [result.observationId]);
      assert.equal(stored.attribution_status, ObservationAttributionStatus.AMBIGUOUS);
    });

    test('two recent same-amount expiries are not resolved by picking the newest', () => {
      const older = activate('ORD-LATE-OLD');
      sessionRepo.transitionToTerminal(older.id, PaymentStatus.EXPIRED);
      const newer = activate('ORD-LATE-NEW');
      sessionRepo.transitionToTerminal(newer.id, PaymentStatus.EXPIRED);

      const obs = ObservationNormalizer.normalize({
        source: 'GOOGLE_MESSAGES',
        receivingAccountId: accountId,
        amountPaise: 20000n,
        bankReferenceNumber: 'UTR-LATE-MULTI',
        observedAt: new Date(),
        rawPayload: { text: 'Received Rs 200' }
      });
      const result = attributionEngine.processObservation(obs);

      assert.equal(result.ambiguous, true);
      assert.equal(result.attributed, false);
      assert.equal(sessionRepo.findById(older.id).status, PaymentStatus.EXPIRED);
      assert.equal(sessionRepo.findById(newer.id).status, PaymentStatus.EXPIRED);
      assert.equal(db.queryOne("SELECT COUNT(*) AS n FROM payment_sessions WHERE status = 'RECONCILED'").n, 0);
    });

    test('a single matching alert becomes OBSERVED_SUCCESS and is not RECONCILED', () => {
      const live = activate('ORD-OBSERVED-ONLY');
      const obs = ObservationNormalizer.normalize({
        source: 'GOOGLE_MESSAGES',
        receivingAccountId: accountId,
        amountPaise: 20000n,
        bankReferenceNumber: 'UTR-OBSERVED-1',
        observedAt: new Date(),
        rawPayload: { text: 'Received Rs 200' }
      });
      const result = attributionEngine.processObservation(obs);
      assert.equal(result.outcomeStatus, PaymentStatus.OBSERVED_SUCCESS);
      assert.equal(sessionRepo.findById(live.id).status, PaymentStatus.OBSERVED_SUCCESS);
      assert.equal(db.queryOne("SELECT COUNT(*) AS n FROM payment_sessions WHERE status = 'RECONCILED'").n, 0);
    });
  });

  describe('new UPI sessions require a live SMS observer', () => {
    let apiInstance;
    let testDb;
    let baseUrl;
    const previousFlag = process.env.YOUPI_ENFORCE_OBSERVER_HEALTH;
    const previousSms = process.env.SMS_OBSERVER_PORT;
    const previousGmail = process.env.GMAIL_OBSERVER_PORT;

    before(async () => {
      process.env.YOUPI_ENFORCE_OBSERVER_HEALTH = 'true';
      process.env.SMS_OBSERVER_PORT = '5991';
      process.env.GMAIL_OBSERVER_PORT = '5992';
      testDb = new Database({ inMemory: true });
      apiInstance = await startPaymentApi(6211, testDb);
      baseUrl = `http://127.0.0.1:${apiInstance.port}`;
    });

    after(async () => {
      if (previousFlag === undefined) delete process.env.YOUPI_ENFORCE_OBSERVER_HEALTH;
      else process.env.YOUPI_ENFORCE_OBSERVER_HEALTH = previousFlag;
      if (previousSms === undefined) delete process.env.SMS_OBSERVER_PORT;
      else process.env.SMS_OBSERVER_PORT = previousSms;
      if (previousGmail === undefined) delete process.env.GMAIL_OBSERVER_PORT;
      else process.env.GMAIL_OBSERVER_PORT = previousGmail;
      await apiInstance.close();
      testDb.close();
    });

    function request(pathname, options = {}) {
      return new Promise((resolve, reject) => {
        const url = new URL(pathname, baseUrl);
        const req = http.request(url, {
          method: options.method || 'GET',
          headers: { 'Content-Type': 'application/json', ...authHeadersFor(pathname),
            ...(pathname.startsWith('/api/v1/payments') ? { 'X-Merchant-Id': '00000000-0000-0000-0000-000000000001' } : {}),
            ...(options.headers || {}) }
        }, res => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            let body;
            try { body = JSON.parse(data); } catch { body = data; }
            resolve({ status: res.statusCode, body });
          });
        });
        req.on('error', reject);
        if (options.body) req.write(JSON.stringify(options.body));
        req.end();
      });
    }

    test('refuses a new UPI session when the SMS heartbeat is stale, then accepts one after a fresh heartbeat', async () => {
      testDb.execute('DELETE FROM android_devices');
      const blocked = await request('/api/v1/payments', {
        method: 'POST',
        body: { orderId: 'ORD-OBSERVER-DOWN', amount: '25.00', currency: 'INR' }
      });
      assert.equal(blocked.status, 503);
      assert.equal(blocked.body.code, 'OBSERVERS_UNHEALTHY');

      const cod = await request('/api/v1/payments', {
        method: 'POST',
        body: { orderId: 'ORD-COD-WHILE-DOWN', amount: '25.00', method: 'COD' }
      });
      assert.equal(cod.status, 201);

      testDb.execute(`
        INSERT INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active, last_heartbeat_at, created_at)
        VALUES ('dev-phase1', '00000000-0000-0000-0000-000000000001', 'Pixel', 'Pixel', 'hash', 1, datetime('now'), datetime('now'))
      `);
      const allowed = await request('/api/v1/payments', {
        method: 'POST',
        body: { orderId: 'ORD-OBSERVER-UP', amount: '26.00', currency: 'INR' }
      });
      assert.equal(allowed.status, 201);
      assert.equal(allowed.body.status, 'INITIATED');
    });
  });

  describe('demo store fulfillment survives restart', () => {
    test('a second process cannot grant the same order again', () => {
      const file = path.join(os.tmpdir(), `youpi-phase1-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
      const first = new CoinWalletStoreServer({ idempotencyPath: file, webhookSecret: 'phase1-secret' });
      const claim = first.claimFulfillment({
        orderId: 'ORD-RESTART',
        deliveryId: 'delivery-1',
        paymentId: 'pay-1',
        amountPaise: 10000,
        coins: 100,
        packName: 'Pack'
      });
      assert.equal(claim.claimed, true);
      first.creditCoins('ORD-RESTART', 100, 'Pack');
      assert.equal(first.walletCoins, 150);
      first.ledger.close();

      const second = new CoinWalletStoreServer({ idempotencyPath: file, webhookSecret: 'phase1-secret' });
      assert.equal(second.walletCoins, 150);
      const replay = second.claimFulfillment({
        orderId: 'ORD-RESTART',
        deliveryId: 'delivery-2',
        paymentId: 'pay-1',
        amountPaise: 10000,
        coins: 100,
        packName: 'Pack'
      });
      assert.equal(replay.claimed, false);
      assert.equal(second.walletCoins, 150);
      assert.equal(second.receiptSeen('delivery-1'), false);
      second.noteReceipt('delivery-1', 'RECONCILED', 'ORD-RESTART');
      assert.equal(second.receiptSeen('delivery-1'), true);
      second.ledger.close();
      fs.rmSync(file, { force: true });
    });
  });
});
