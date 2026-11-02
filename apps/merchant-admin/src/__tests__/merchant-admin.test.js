import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { getAdminToken } from '@youpi/common';
import { startAdminServer } from '../index.js';
import { AdminServer } from '../server.js';

describe('Merchant Admin Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    serverInstance = await startAdminServer(6101, { db: testDb });
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
    testDb.close();
  });

  function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, { headers }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      }).on('error', reject);
    });
  }

  test('GET /health returns UP', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.equal(json.status, 'UP');
    assert.equal(json.service, 'merchant-admin');
  });

  test('GET / renders dashboard with queue monitor, observers, counter desk & pairing modal', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));

    assert.ok(res.text.includes('Real-Time Receiving Account Slot Ownership'));
    assert.ok(res.text.includes('Active Slot (5-Minute Window)'));
    assert.ok(res.text.includes('Processing Slot (30s Verification Window)'));
    assert.ok(res.text.includes('Live Counter Payment Requests'));
    assert.ok(res.text.includes('Payment Observers (SMS & Gmail)'));
    assert.ok(res.text.includes('Android SMS Gateway'));
    assert.ok(res.text.includes('Gmail Direct API'));
    assert.ok(res.text.includes('Payment QR Stand Studio'));
    assert.ok(res.text.includes('subViewStoreStand'));
    assert.ok(res.text.includes('Accepts payments above ₹2,000'));
  });

  test('GET /api/admin/tickets requires the admin token', async () => {
    const anonymous = await get('/api/admin/tickets');
    assert.equal(anonymous.status, 401);

    const res = await get('/api/admin/tickets', { Authorization: `Bearer ${getAdminToken()}` });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.ok(Array.isArray(json));
  });

  test('Control Center supervisor proxy routes (/api/services* and /api/logs/stream) require the admin token', async () => {
    const anonServices = await get('/api/services');
    assert.equal(anonServices.status, 401);

    const wrongToken = await get('/api/services', { Authorization: 'Bearer wrong-token' });
    assert.equal(wrongToken.status, 401);

    const anonLogs = await get('/api/logs/stream');
    assert.equal(anonLogs.status, 401);

    const wrongQueryLogs = await get('/api/logs/stream?token=wrong-token');
    assert.equal(wrongQueryLogs.status, 401);
  });

  test('renderHtml injects dynamic DEFAULT_APP_NAME into title and brand header', () => {
    const origEnv = { ...process.env };
    process.env.DEFAULT_APP_NAME = 'ApexMerchant Suite';

    const adminServer = new AdminServer({ db: testDb });
    const html = adminServer.renderHtml();

    assert.ok(html.includes('<title>Merchant &amp; Supervisor Hub - ApexMerchant Suite</title>') || html.includes('<title>Merchant & Supervisor Hub - ApexMerchant Suite</title>'));
    assert.ok(html.includes('<span>🛡️ ApexMerchant Suite</span>'));
    assert.ok(html.includes('Security Engine v2 &bull; ApexMerchant Suite'));

    process.env = { ...origEnv };
  });

  test('Payment QR Stand Studio tab and stand controls are present in admin dashboard', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('Payment QR Stand Studio'));
    assert.ok(res.text.includes('id="subViewStoreStand"'));
    assert.ok(res.text.includes('standInputVpa'));
    assert.ok(res.text.includes('standInputMobile'));
    assert.ok(res.text.includes('Accepts payments above ₹2,000'));
  });
});
