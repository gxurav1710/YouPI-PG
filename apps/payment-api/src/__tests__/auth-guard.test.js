import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentMethod } from '@youpi/common';
import { TEST_ADMIN_TOKEN, TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';

describe('Auth guard: admin, observer and force-success endpoints', () => {
  let api;
  let baseUrl;
  let db;

  const call = (path, { method = 'GET', token, body } = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(path.startsWith('/api/v1/payments') ? { 'X-Merchant-Id': '00000000-0000-0000-0000-000000000001' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

  before(async () => {
    process.env.NODE_ENV = 'test';
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6197, db);
    baseUrl = `http://localhost:${api.port}`;
  });

  after(async () => {
    await api.close();
    db.close();
  });

  test('admin routes reject missing and wrong tokens, accept the admin token', async () => {
    assert.equal((await call('/api/v1/admin/merchant-settings')).status, 401);
    assert.equal((await call('/api/v1/admin/merchant-settings', { token: 'wrong' })).status, 401);
    assert.equal((await call('/api/v1/admin/merchant-settings', { token: TEST_OBSERVER_TOKEN })).status, 401);
    assert.equal((await call('/api/v1/admin/merchant-settings', { token: TEST_ADMIN_TOKEN })).status, 200);
  });

  test('tunnel/start and counter-confirm are not reachable anonymously', async () => {
    const tunnel = await call('/api/v1/admin/tunnel/start', { method: 'POST', body: { command: 'calc.exe' } });
    assert.equal(tunnel.status, 401);
    const confirm = await call('/api/v1/admin/counter-confirm', { method: 'POST', body: { paymentId: 'x', operatorId: 'y' } });
    assert.equal(confirm.status, 401);
  });

  test('tunnel/start refuses a command that contains no tunnel token (nothing is executed)', async () => {
    const res = await call('/api/v1/admin/tunnel/start', {
      method: 'POST',
      token: TEST_ADMIN_TOKEN,
      body: { command: 'calc.exe & echo pwned' }
    });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /No valid Cloudflare tunnel token/);
  });

  test('pollers/events needs the observer (or admin) token', async () => {
    const payload = { source: 'GOOGLE_MESSAGES', receivingAccountId: 'nope', rawText: 'Rs 10 credited UTR 123456789012', sender: 'HDFCBK' };
    assert.equal((await call('/api/v1/pollers/events', { method: 'POST', body: payload })).status, 401);
    assert.equal((await call('/api/v1/pollers/events', { method: 'POST', token: 'wrong', body: payload })).status, 401);
    const withObserver = await call('/api/v1/pollers/events', { method: 'POST', token: TEST_OBSERVER_TOKEN, body: payload });
    assert.notEqual(withObserver.status, 401);
  });

  test('simulate-observation is admin-only', async () => {
    const res = await call('/api/v1/checkout/any-id/simulate-observation', {
      method: 'POST',
      body: { rawText: 'Rs 500 credited Ref 612345678901', sender: 'HDFCBK' }
    });
    assert.equal(res.status, 401);
  });

  test('dev test-mode and simulator are admin-only', async () => {
    assert.equal((await call('/api/v1/admin/dev/test-mode', { method: 'POST', body: { enabled: true } })).status, 401);
    assert.equal((await call('/api/v1/admin/dev/simulator/inject', { method: 'POST', body: {} })).status, 401);
  });

  test('developer simulators are disabled in production, even for the admin token', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      for (const path of ['/api/v1/admin/dev/test-mode', '/api/v1/admin/dev/simulator/inject', '/api/v1/checkout/x/simulate-observation']) {
        const res = await call(path, { method: 'POST', token: TEST_ADMIN_TOKEN, body: {} });
        assert.equal(res.status, 403, path);
      }
      // Reads and unrelated admin routes keep working.
      assert.equal((await call('/api/v1/admin/merchant-settings', { token: TEST_ADMIN_TOKEN })).status, 200);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  test('counter-confirm cannot settle a UPI session, even with the admin token', async () => {
    const created = await call('/api/v1/payments', {
      method: 'POST',
      token: TEST_ADMIN_TOKEN,
      body: { orderId: 'UPI-NO-FORCE-1', amount: '100.00', method: PaymentMethod.UPI, autoActivate: true }
    });
    assert.equal(created.status, 201);
    const { paymentId } = await created.json();

    const res = await call('/api/v1/admin/counter-confirm', {
      method: 'POST',
      token: TEST_ADMIN_TOKEN,
      body: { paymentId, operatorId: 'op1' }
    });
    assert.equal(res.status, 400);

    const state = await (await call(`/api/v1/payments/${paymentId}`)).json();
    assert.notEqual(state.internalStatus, 'SUCCESS');
  });

  test('a counter session can be confirmed once, and not again', async () => {
    const created = await call('/api/v1/payments', {
      method: 'POST',
      token: TEST_ADMIN_TOKEN,
      body: { orderId: 'CASH-OK-1', amount: '50.00', method: PaymentMethod.CASH_COUNTER }
    });
    const { paymentId } = await created.json();
    const first = await call('/api/v1/admin/counter-confirm', { method: 'POST', token: TEST_ADMIN_TOKEN, body: { paymentId, operatorId: 'op1' } });
    assert.equal(first.status, 200);
    const second = await call('/api/v1/admin/counter-confirm', { method: 'POST', token: TEST_ADMIN_TOKEN, body: { paymentId, operatorId: 'op1' } });
    assert.equal(second.status, 409);
  });

  test('the APK download stays public', async () => {
    const apk = await call('/api/v1/admin/sms-gateway/download-apk');
    assert.notEqual(apk.status, 401);
  });

  test('a malformed Host header does not crash the server', async () => {
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(api.port, 'localhost', () => {
        socket.write('GET /api/v1/payments/none HTTP/1.1\r\nHost: a b[\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', c => { data += c; });
      socket.on('close', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 (400|404)/);
    assert.equal((await call('/api/v1/payments/none')).status, 404);
  });
});
