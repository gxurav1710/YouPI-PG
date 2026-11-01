import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { createPaymentApp } from '../index.js';
import { Database } from '@youpi/db';
import { authFetch } from '../../../../scripts/test-support.js';
import { createOfflineWhatsApp } from './fixtures/offline-whatsapp.js';

test('WhatsApp Berry Protocol OTP Customer Auth & Merchant Configuration Suite', async (t) => {
  const customDb = new Database({ inMemory: true });
  const whatsapp = createOfflineWhatsApp();
  const app = createPaymentApp(customDb, { otpCooldownMs: 0, whatsappBerryService: whatsapp });
  const testPort = 6288;

  const serverInstance = await new Promise(resolve => {
    const s = app.rawServer.listen(testPort, () => resolve(s));
  });

  t.after(() => {
    app.destroy();
    serverInstance.close();
  });

  const apiBase = `http://localhost:${testPort}`;

  await t.test('1. POST /api/v1/customer/check-user identifies new unregistered mobile', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/check-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: '9123456789' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.exists, false);
    assert.equal(data.mobileNumber, '9123456789');
    assert.equal(data.customer, null);
  });

  await t.test('2. POST /api/v1/customer/check-user rejects malformed phone numbers', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/check-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: '123' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  let signupOtp = null;

  await t.test('3. POST /api/v1/customer/send-otp creates challenge for new customer signup', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobileNumber: '9123456789',
        name: 'Rohan Sharma',
        email: 'rohan@sharma.local',
        isNewUser: true
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.mobileNumber, '9123456789');
    assert.ok(data.devOtp);
    assert.equal(data.devOtp.length, 6);
    signupOtp = data.devOtp;
  });

  await t.test('4. POST /api/v1/customer/verify-otp rejects incorrect OTP code', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobileNumber: '9123456789',
        otp: '000000'
      })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Invalid'));
  });

  let authToken = null;
  let customerId = null;

  await t.test('5. POST /api/v1/customer/verify-otp completes signup and issues session token', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobileNumber: '9123456789',
        otp: signupOtp
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.token);
    assert.equal(data.customer.name, 'Rohan Sharma');
    assert.equal(data.customer.email, 'rohan@sharma.local');
    assert.equal(data.customer.mobileNumber, '9123456789');

    authToken = data.token;
    customerId = data.customerId;
  });

  await t.test('6. POST /api/v1/customer/check-user detects now-existing customer', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/check-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: '9123456789' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.exists, true);
    assert.equal(data.customer.name, 'Rohan Sharma');
  });

  let loginOtp = null;

  // The signup OTP was requested moments earlier.
  // Wait until the 30-second resend cooldown expires.
  await new Promise(resolve => setTimeout(resolve, 31_000));

  await t.test('7. POST /api/v1/customer/send-otp dispatches WhatsApp OTP for existing user', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobileNumber: '9123456789' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.devOtp);
    loginOtp = data.devOtp;
  });

  await t.test('8. POST /api/v1/customer/verify-otp logs in existing user', async () => {
    const res = await authFetch(`${apiBase}/api/v1/customer/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobileNumber: '9123456789',
        otp: loginOtp
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.token);
    assert.equal(data.customer.id, customerId);
  });

  await t.test('9. Merchant WhatsApp status API responds with BerryProtocol metadata', async () => {
    const res = await authFetch(`${apiBase}/api/v1/admin/whatsapp/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.platform, 'BerryProtocol v0.1.10');
    assert.ok(data.status);
  });

  await t.test('10. Merchant WhatsApp reconnect API triggers pairing QR code generation', async () => {
    const res = await authFetch(`${apiBase}/api/v1/admin/whatsapp/reconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.qrCode);
    assert.ok(whatsapp.calls.some(call => call.method === 'initialize'));
  });

  await t.test('11. Merchant WhatsApp pairing-code API accepts phone and returns 8-digit code', async () => {
    const res = await authFetch(`${apiBase}/api/v1/admin/whatsapp/pairing-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '919999999999' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.pairingCode, '12345678');
    assert.deepEqual(whatsapp.calls.find(call => call.method === 'requestPairingCode'), {
      method: 'requestPairingCode', phoneNumber: '919999999999'
    });
  });

  await t.test('12. Merchant WhatsApp disconnect API safely clears session', async () => {
    const res = await authFetch(`${apiBase}/api/v1/admin/whatsapp/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'DISCONNECTED');
  });
});
