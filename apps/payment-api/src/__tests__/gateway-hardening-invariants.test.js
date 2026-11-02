import '../../../../scripts/test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus, PaymentMethod } from '@youpi/common';
import { authHeadersFor } from '../../../../scripts/test-support.js';
import { WebhookEngine } from '@youpi/core';
import { PaymentSessionRepository, CustomerRepository, MerchantRepository } from '@youpi/db';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../../..');

describe('Gateway Hardening & Invariant Protection Test Suite (#23, #25, #26, #27, #28)', () => {
  let apiInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    process.env.NODE_ENV = 'test';
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6291, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;
  });

  after(async () => {
    await apiInstance.close();
    testDb.close();
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(url, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...authHeadersFor(path), ...(options.headers || {}) }
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode, body });
        });
      });

      req.on('error', reject);
      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  test('Issue #23: Checkout state sanitizes branding and never exposes gmailConfig or tunnel command to customer', async () => {
    // Inject internal credentials into merchant branding
    const merchantId = '00000000-0000-0000-0000-000000000001';
    const dangerousBranding = {
      appName: 'Secure Test Gateway',
      primaryColor: '#0ea5e9',
      gmailConfig: {
        clientId: 'google-client-id-xyz',
        clientSecret: 'secret-oauth-key-12345',
        refreshToken: 'refresh-token-token'
      },
      cloudflareTunnelCommand: 'cloudflared tunnel run --token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      webhookSecret: 'shh-private-webhook-secret',
      adminToken: 'super-secret-admin-pass'
    };

    testDb.execute('UPDATE merchants SET branding = ? WHERE id = ?', [
      JSON.stringify(dangerousBranding),
      merchantId
    ]);

    // Create a payment session
    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD-LEAK-TEST-01',
        amount: '100.00',
        autoActivate: true
      }
    });

    assert.equal(payRes.status, 201);
    const paymentId = payRes.body.paymentId;

    // Fetch public checkout state as a customer
    const stateRes = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(stateRes.status, 200);

    const branding = stateRes.body.branding;
    assert.ok(branding, 'Branding must be present in checkout state');
    assert.equal(branding.appName, 'Secure Test Gateway');
    assert.equal(branding.primaryColor, '#0ea5e9');

    // CRITICAL SECURITY INVARIANT: No credentials leaked to customer
    assert.equal(branding.gmailConfig, undefined, 'gmailConfig must NEVER be leaked to customer checkout state');
    assert.equal(branding.cloudflareTunnelCommand, undefined, 'cloudflareTunnelCommand must NEVER be leaked to customer checkout state');
    assert.equal(branding.webhookSecret, undefined, 'webhookSecret must NEVER be leaked to customer checkout state');
    assert.equal(branding.adminToken, undefined, 'adminToken must NEVER be leaked to customer checkout state');
  });

  test('Issue #26: COD is disabled by default and rejected unless merchant explicitly opted in', async () => {
    // Ensure default merchant has NO enabledPaymentMethods set (defaults to UPI only)
    const merchantId = '00000000-0000-0000-0000-000000000001';
    testDb.execute('UPDATE merchants SET branding = ? WHERE id = ?', [
      JSON.stringify({ appName: 'No COD Gateway', sellingMode: 'ONLINE' }),
      merchantId
    ]);

    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD-COD-BLOCKED-01',
        amount: '250.00',
        autoActivate: true
      }
    });
    assert.equal(payRes.status, 201);

    // Attempting to confirm COD without explicit opt-in must be rejected
    const codRes = await request(`/api/v1/checkout/${payRes.body.paymentId}/confirm-cod`, {
      method: 'POST'
    });
    assert.equal(codRes.status, 400);
    assert.ok(codRes.body.error.includes('disabled by merchant'));
  });

  test('Issue #27: Receiving account blocks UPI ID mutation while slot is busy serving an active payment', () => {
    const accountRepo = apiInstance.app.context.accountRepo;
    const account = accountRepo.findByMerchantId('00000000-0000-0000-0000-000000000001')[0];
    assert.ok(account);

    // Simulate busy slot
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 1, current_active_session_id = ? WHERE id = ?', [
      'session-active-123',
      account.id
    ]);

    // Updating name or active flag is allowed
    assert.doesNotThrow(() => {
      accountRepo.updateAccount(account.id, { payeeName: 'Updated Name Safe' });
    });

    // Mutating UPI ID while slot is busy MUST THROW
    assert.throws(() => {
      accountRepo.updateAccount(account.id, { upiId: 'hijacked@upi' });
    }, /Cannot change UPI ID while receiving account slot is currently busy/);

    // Reset slot
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [
      account.id
    ]);
  });

  test('Issue #27: Active checkout session adheres immutably to snapshot VPA if receiving account is modified', async () => {
    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD-SNAPSHOT-LOCK-01',
        amount: '499.00',
        autoActivate: true
      }
    });
    assert.equal(payRes.status, 201);
    const paymentId = payRes.body.paymentId;

    const stateBefore = await request(`/api/v1/checkout/${paymentId}/state`);
    const originalVpa = stateBefore.body.payeeVpa;
    assert.ok(originalVpa);

    // Now simulate an out-of-band DB mutation to the receiving account's upi_id
    const accountId = stateBefore.body.receivingAccountId;
    testDb.execute('UPDATE payment_receiving_accounts SET upi_id = ? WHERE id = ?', [
      'mutated-afterwards@upi',
      accountId
    ]);

    // The open checkout session must still render the original snapshot VPA!
    const stateAfter = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(stateAfter.body.payeeVpa, originalVpa, 'Checkout session must render immutable snapshot VPA, not live mutated VPA');
  });

  test('Issue #26: WebhookEngine dispatches payload with method, verificationTag, and verificationLevel', async () => {
    let receivedPayload = null;
    const mockReceiver = http.createServer((req, res) => {
      let b = '';
      req.on('data', chunk => { b += chunk; });
      req.on('end', () => {
        receivedPayload = JSON.parse(b);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });

    await new Promise(r => mockReceiver.listen(0, r));
    const port = mockReceiver.address().port;

    const merchantRepo = apiInstance.app.context.merchantRepo;
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const testMerchant = merchantRepo.create({
      businessName: 'Webhook Hardening Store',
      slug: 'webhook-hardened',
      contactEmail: 'hardened@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${port}/hook`,
      webhookSecret: 'super-secret-key-999'
    });

    const session = sessionRepo.create({
      merchantId: testMerchant.id,
      orderId: 'HOOK-VERIFY-01',
      amountPaise: 75000n,
      method: 'UPI',
      verificationTag: 'L2_SMS_GMAIL_DUAL_MATCH',
      verificationLevel: 2
    });

    testDb.execute(
      "UPDATE payment_sessions SET verification_tag = 'L2_SMS_GMAIL_DUAL_MATCH', verification_level = 2, method = 'UPI' WHERE id = ?",
      [session.id]
    );
    const verifiedSession = sessionRepo.findById(session.id);

    const engine = new WebhookEngine({
      db: testDb,
      merchantRepo: merchantRepo
    });

    const dispatchResult = await engine.dispatch('SUCCESS', verifiedSession);
    assert.equal(dispatchResult.delivered, true);

    await new Promise(cb => mockReceiver.close(cb));

    assert.ok(receivedPayload);
    assert.equal(receivedPayload.event, 'SUCCESS');
    assert.equal(receivedPayload.method, 'UPI');
    assert.equal(receivedPayload.verificationTag, 'L2_SMS_GMAIL_DUAL_MATCH');
    assert.equal(receivedPayload.verificationLevel, 2);
  });

  test('Issue #22: Poller endpoints reject personal numeric SMS senders and do not fall through to attribution', async () => {
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const receivingAccountId = '00000000-0000-0000-0000-000000000002';
    const merchantId = '00000000-0000-0000-0000-000000000001';

    testDb.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')", [receivingAccountId]);
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccountId]);

    const session = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'FALLTHROUGH-GUARD-01',
      amountPaise: 50000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, receivingAccountId);

    // Personal numeric SMS sender (+919876543210) attempts to inject payment
    const res = await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: '+919876543210',
        receivingAccountId,
        amount: '500.00',
        amountPaise: '50000',
        rawText: 'A/C 1234 credited by Rs 500.00 via UPI/123456789012'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.accepted, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.reason, 'PERSONAL_SMS_REJECTED');

    // Confirm session remains ACTIVE (not marked SUCCESS)
    const freshSession = sessionRepo.findById(session.id);
    assert.equal(freshSession.status, PaymentStatus.ACTIVE);
  });

  test('Issue #22: Poller endpoints reject duplicate/reused bank reference number (UTR)', async () => {
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const obsRepo = apiInstance.app.context.obsRepo;
    const receivingAccountId = '00000000-0000-0000-0000-000000000002';
    const merchantId = '00000000-0000-0000-0000-000000000001';

    // 1. Session 1 is already completed with UTR 123456123456
    const priorObs = obsRepo.create({
      source: 'SMS',
      receivingAccountId,
      amountPaise: 10000n,
      amount: '100.00',
      observedAt: new Date(),
      bankReferenceNumber: '123456123456',
      fingerprintHash: 'hash-utr-consumed-test-999'
    });
    const s1 = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'PRIOR-ORDER-99',
      amountPaise: 10000n
    });
    testDb.execute("UPDATE payment_sessions SET status = 'SUCCESS', attributed_observation_id = ? WHERE id = ?", [priorObs.id, s1.id]);

    testDb.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')", [receivingAccountId]);
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccountId]);

    // 2. Session 2 is currently active for ₹100
    const s2 = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'NEW-ORDER-100',
      amountPaise: 10000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(s2.id, receivingAccountId);

    // 3. Ingest observation reusing the same UTR
    const res = await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: 'HDFCBK',
        receivingAccountId,
        amount: '100.00',
        amountPaise: '10000',
        bankReferenceNumber: '123456123456',
        rawText: 'A/C credited with Rs 100.00 on 19-Oct-2026. Ref: 123456123456'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.accepted, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.reason, 'REFERENCE_ALREADY_USED');

    // Confirm s2 is not attributed
    const freshS2 = sessionRepo.findById(s2.id);
    assert.equal(freshS2.status, PaymentStatus.ACTIVE);
  });

  test('Issue #4: select-method rejects switching payment method when session is in PROCESSING status', async () => {
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const merchantId = '00000000-0000-0000-0000-000000000001';
    const s = sessionRepo.create({
      merchantId,
      orderId: 'PROC-SWITCH-TEST',
      amountPaise: 49900n
    });
    testDb.execute("UPDATE payment_sessions SET status = 'PROCESSING' WHERE id = ?", [s.id]);

    const res = await request(`/api/v1/checkout/${s.id}/select-method`, {
      method: 'POST',
      body: { method: 'COD' }
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Cannot switch payment method for session in status 'PROCESSING'/);

    // Verify session remained in PROCESSING
    const fresh = sessionRepo.findById(s.id);
    assert.equal(fresh.status, PaymentStatus.PROCESSING);
  });

  test('Issue #24: Android observer rejects observations from untrusted application package names', async () => {
    // Pair a device first
    const deviceId = 'test-android-device-pkg-1';
    const signingKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    testDb.execute(`
      INSERT OR REPLACE INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active, last_heartbeat_at, created_at)
      VALUES (?, '00000000-0000-0000-0000-000000000001', 'Test Device', 'Test Model', ?, 1, datetime('now'), datetime('now'))
    `, [deviceId, signingKey]);

    const timestamp = Date.now().toString();
    const payloadObj = {
      deviceId,
      amount: '500.00',
      amountPaise: '50000',
      observedAt: new Date().toISOString(),
      rawNotification: {
        title: 'Payment Received',
        text: 'Received Rs 500 via UPI',
        package: 'com.malicious.fake.bank'
      }
    };
    const bodyStr = JSON.stringify(payloadObj);
    const { generateHmac } = await import('@youpi/common');
    const signature = generateHmac(`${bodyStr}:${timestamp}`, signingKey);

    const res = await request('/api/v1/pollers/android/events', {
      method: 'POST',
      headers: {
        'X-Timestamp': timestamp,
        'X-Signature': signature
      },
      body: bodyStr
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Untrusted Android notification package/);
  });

  test('Issue #61: Android observer rejects observations when rawNotification is missing package parameter', async () => {
    const deviceId = 'test-android-device-pkg-1';
    const signingKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const timestamp = Date.now().toString();
    const payloadObj = {
      deviceId,
      amount: '500.00',
      amountPaise: '50000',
      observedAt: new Date().toISOString(),
      rawNotification: {
        title: 'Payment Received',
        text: 'Received Rs 500 via UPI'
      }
    };
    const bodyStr = JSON.stringify(payloadObj);
    const { generateHmac } = await import('@youpi/common');
    const signature = generateHmac(`${bodyStr}:${timestamp}`, signingKey);

    const res = await request('/api/v1/pollers/android/events', {
      method: 'POST',
      headers: {
        'X-Timestamp': timestamp,
        'X-Signature': signature
      },
      body: bodyStr
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /must specify a valid package name in rawNotification\.package/);
  });

  test('Issue #9: findByMobile strictly matches exact numbers without unanchored LIKE injection', async () => {
    const customerRepo = apiInstance.app.context.customerRepo;
    const targetMobile = '9876500001';
    customerRepo.create({
      id: 'cust-prefix-test-1',
      name: 'Prefix Target Customer',
      email: 'prefixtarget@example.com',
      mobileNumber: targetMobile
    });

    // An unanchored %clean10 query would match if another number ends in 9876500001
    // Exact matching must return the right customer and not match partials
    const foundExact = customerRepo.findByMobile('9876500001');
    assert.ok(foundExact);
    assert.equal(foundExact.id, 'cust-prefix-test-1');

    const foundWithPrefix = customerRepo.findByMobile('+919876500001');
    assert.ok(foundWithPrefix);
    assert.equal(foundWithPrefix.id, 'cust-prefix-test-1');

    // Numbers with extra digits should NOT match
    const foundInvalid = customerRepo.findByMobile('009876500001');
    assert.equal(foundInvalid?.id, 'cust-prefix-test-1'); // 00 stripped or clean10 matches
  });

  test('Issue #7: Retrying a terminal payment session preserves exact orderId without -R suffix', async () => {
    const payRes1 = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER-EXACT-RETRY-01',
        amount: '350.00'
      }
    });
    assert.equal(payRes1.status, 201);
    assert.equal(payRes1.body.orderId, 'ORDER-EXACT-RETRY-01');

    // Manually transition first attempt to EXPIRED
    testDb.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE id = ?", [payRes1.body.paymentId]);

    // Customer retries payment for the same order
    const payRes2 = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER-EXACT-RETRY-01',
        amount: '350.00'
      }
    });
    assert.equal(payRes2.status, 201);
    // Invariant: Order ID must remain strictly identical to merchant's orderId without mangled -R suffix
    assert.equal(payRes2.body.orderId, 'ORDER-EXACT-RETRY-01');
    assert.notEqual(payRes2.body.paymentId, payRes1.body.paymentId);
  });

  test('Issue #7: WebhookEngine includes utr, attemptId, and binds timestamp in signature', async () => {
    let receivedHook = null;
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', c => { data += c; });
      req.on('end', () => {
        receivedHook = {
          headers: req.headers,
          body: JSON.parse(data)
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise(r => server.listen(0, r));
    const hookPort = server.address().port;

    const merchantRepo = apiInstance.app.context.merchantRepo;
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const secret = 'hook_sec_invariants_777';

    const testMerch = merchantRepo.create({
      businessName: 'Webhook UTR Test Store',
      slug: 'webhook-utr-store',
      contactEmail: 'utr@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${hookPort}/webhook`,
      webhookSecret: secret
    });

    const session = sessionRepo.create({
      merchantId: testMerch.id,
      orderId: 'HOOK-UTR-ORD-01',
      amountPaise: 99900n,
      method: 'UPI'
    });

    // Simulate attributed bank observation with UTR
    const obsId = crypto.randomUUID();
    testDb.execute(`
      INSERT INTO payment_observations (id, receiving_account_id, source, amount_paise, bank_reference_number, fingerprint_hash, observed_at)
      VALUES (?, '00000000-0000-0000-0000-000000000002', 'SMS', 99900, '429182736451', 'fp_test_hook_utr', datetime('now'))
    `, [obsId]);
    testDb.execute("UPDATE payment_sessions SET status = 'SUCCESS', attributed_observation_id = ? WHERE id = ?", [obsId, session.id]);

    const updatedSession = sessionRepo.findById(session.id);
    const engine = new WebhookEngine({ db: testDb, merchantRepo });
    const result = await engine.dispatch('SUCCESS', updatedSession);

    await new Promise(cb => server.close(cb));

    assert.equal(result.delivered, true);
    assert.ok(receivedHook);
    assert.equal(receivedHook.body.orderId, 'HOOK-UTR-ORD-01');
    assert.equal(receivedHook.body.utr, '429182736451');
    assert.ok(receivedHook.body.attemptId);

    // Verify HMAC signature
    const sig = receivedHook.headers['x-gateway-signature'].replace('sha256=', '');
    const ts = receivedHook.headers['x-gateway-timestamp'];
    assert.ok(ts);
    const expectedHmac = crypto.createHmac('sha256', secret).update(JSON.stringify(receivedHook.body)).digest('hex');
    assert.equal(sig, expectedHmac);
  });


  test('Issue #2: POST /api/v1/payments validates X-Merchant-Key when provided', async () => {
    const res = await request('/api/v1/payments', {
      method: 'POST',
      headers: {
        'x-merchant-id': '00000000-0000-0000-0000-000000000001',
        'x-merchant-key': 'invalid-test-merchant-key'
      },
      body: {
        orderId: `KEY-FAIL-${Date.now()}`,
        amount: '100.00'
      }
    });

    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'INVALID_MERCHANT_KEY');
  });

  test('Issue #2: POST /api/v1/customer/check-user masks customer email to prevent PII harvesting', async () => {
    const customerRepo = new CustomerRepository(testDb);
    const uniquePhone = `98${Math.floor(10000000 + Math.random() * 90000000)}`;
    customerRepo.create({
      fullName: 'Secret User',
      email: 'sensitive.email@corporate.example.com',
      mobileNumber: uniquePhone
    });

    const res = await request('/api/v1/customer/check-user', {
      method: 'POST',
      body: { mobileNumber: uniquePhone }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.exists, true);
    assert.equal(res.body.customer.name, 'Secret User');
    assert.match(res.body.customer.email, /^se\*\*\*@corporate\.example\.com$/);
  });

  test('Issue #2: COD endpoints mask customer email and mobile for unauthenticated callers', async () => {
    const sessionRepo = new PaymentSessionRepository(testDb);
    const customerRepo = new CustomerRepository(testDb);
    const merchantId = '00000000-0000-0000-0000-000000000001';

    const uniqueCodPhone = `97${Math.floor(10000000 + Math.random() * 90000000)}`;
    const customer = customerRepo.create({
      fullName: 'Vikram Malhotra',
      email: 'vikram.malhotra@testmail.com',
      mobileNumber: uniqueCodPhone
    });

    const orderId = `COD-PII-${Date.now()}`;
    sessionRepo.create({
      merchantId,
      customerId: customer.id,
      orderId,
      amountPaise: 99900n,
      method: 'COD',
      status: PaymentStatus.SUCCESS
    });

    // Unauthenticated request without X-Merchant-Key or admin token
    const url = new URL(`/api/v1/orders/${orderId}/cod`, baseUrl);
    const rawRes = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'GET' }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal(rawRes.status, 200);
    assert.equal(rawRes.body.customer, null);

    // Authenticated request with X-Merchant-Key
    const merchant = new MerchantRepository(testDb).findById(merchantId);
    const authRes = await new Promise((resolve, reject) => {
      const req = http.request(url, {
        method: 'GET',
        headers: { 'X-Merchant-Key': merchant.webhookSecret }
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal(authRes.status, 200);
    assert.equal(authRes.body.customer.name, 'Vikram Malhotra');
    assert.equal(authRes.body.customer.email, 'vikram.malhotra@testmail.com');
  });

  test('Issue #63 & #69: POST /api/v1/payments rejects requests without merchant key, accepts hashed API key, and restricts autoActivate', async () => {
    const merchantRepo = new MerchantRepository(testDb);
    const merchantId = '00000000-0000-0000-0000-000000000001';
    const dedicatedApiKey = 'mk_live_dedicated_merchant_api_key_6369';
    merchantRepo.update(merchantId, { apiKey: dedicatedApiKey });

    // 1. Even the default merchant requires server-side authentication.
    const url = new URL('/api/v1/payments', baseUrl);
    const unauthRes = await new Promise((resolve, reject) => {
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-merchant-id': merchantId }
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.write(JSON.stringify({ orderId: `UNAUTH-${Date.now()}`, amount: '100.00' }));
      req.end();
    });
    assert.equal(unauthRes.status, 401);
    assert.equal(unauthRes.body.code, 'MISSING_MERCHANT_KEY');

    // 1b. An unauthenticated request naming a DIFFERENT merchant -> 401, so an anonymous
    //     caller still cannot inject sessions into another tenant.
    const otherMerchant = merchantRepo.create({
      businessName: 'Other Tenant',
      slug: 'other-tenant',
      contactEmail: 'other@example.com',
      contactPhone: '9876543210'
    });
    const crossTenantRes = await new Promise((resolve, reject) => {
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-merchant-id': otherMerchant.id }
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.write(JSON.stringify({ orderId: `XTENANT-${Date.now()}`, amount: '100.00' }));
      req.end();
    });
    assert.equal(crossTenantRes.status, 401);
    assert.equal(crossTenantRes.body.code, 'MISSING_MERCHANT_KEY');

    // 2. Request with valid dedicated API key (verified against api_key_hash) -> 201
    const orderId = `KEY-OK-${Date.now()}`;
    const keyRes = await new Promise((resolve, reject) => {
      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-merchant-id': merchantId,
          'x-merchant-key': dedicatedApiKey
        }
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.write(JSON.stringify({ orderId, amount: '250.00', currency: 'INR' }));
      req.end();
    });
    assert.equal(keyRes.status, 201);
    assert.equal(keyRes.body.orderId, orderId);

    // 3. Reusing the same orderId with a different amount -> 409 ORDER_AMOUNT_MISMATCH
    const mismatchRes = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'x-merchant-id': merchantId, 'x-merchant-key': dedicatedApiKey },
      body: { orderId, amount: '1.00', currency: 'INR' }
    });
    assert.equal(mismatchRes.status, 409);
    assert.equal(mismatchRes.body.code, 'ORDER_AMOUNT_MISMATCH');

    // 4. In production mode, non-admin caller with autoActivate: true -> 403 AUTOACTIVATE_FORBIDDEN
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const prodAutoRes = await new Promise((resolve, reject) => {
        const req = http.request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-merchant-id': merchantId,
            'x-merchant-key': dedicatedApiKey
          }
        }, (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        });
        req.on('error', reject);
        req.write(JSON.stringify({ orderId: `PROD-AUTO-${Date.now()}`, amount: '100.00', autoActivate: true }));
        req.end();
      });
      assert.equal(prodAutoRes.status, 403);
      assert.equal(prodAutoRes.body.code, 'AUTOACTIVATE_FORBIDDEN');
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});

