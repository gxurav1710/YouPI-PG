import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { Database } from '@youpi/db';
import { hashApiKey } from '../../../../packages/db/src/repositories/merchant.repository.js';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startCoinWalletStore } from '../index.js';
import { generateHmac } from '@youpi/common';

describe('Coin Top-Up Wallet Demo Store Integration Tests', () => {
  let apiInstance;
  let storeInstance;
  let storeBaseUrl;
  let testDb;
  const storeSecret = 'wallet_store_secret_9988';

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.YOUPI_ALLOWED_RETURN_ORIGINS = 'http://localhost:5099';
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6193, testDb);

    // Update demo merchant with our store webhook secret
    testDb.execute('UPDATE merchants SET webhook_secret = ?, webhook_url = ?, api_key_hash = ? WHERE id = ?', [
      storeSecret,
      'http://localhost:5099/api/webhook',
      hashApiKey(storeSecret),
      '00000000-0000-0000-0000-000000000001'
    ]);

    storeInstance = await startCoinWalletStore(5099, {
      gatewayApiUrl: `http://localhost:${apiInstance.port}`,
      merchantId: '00000000-0000-0000-0000-000000000001',
      webhookSecret: storeSecret,
      publicBaseUrl: 'http://localhost:5099'
    });

    storeBaseUrl = `http://localhost:${storeInstance.port}`;
  });

  /** Headers the real gateway always sends with every signed delivery. */
  function gatewayHeaders(payloadString, overrides = {}) {
    return {
      'X-Gateway-Signature': `sha256=${generateHmac(payloadString, storeSecret)}`,
      'X-Gateway-Delivery-Id': crypto.randomUUID(),
      'X-Gateway-Timestamp': Date.now().toString(),
      ...overrides
    };
  }

  after(async () => {
    await storeInstance.close();
    await apiInstance.close();
    testDb.close();
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, storeBaseUrl);
      const req = http.request(url, {
        method: options.method || 'GET',
        headers: options.headers || {}
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
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });

      req.on('error', reject);
      if (options.body) {
        const payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        req.setHeader('Content-Type', 'application/json');
        req.write(payload);
      }
      req.end();
    });
  }

  test('GET /health returns UP and initial balance', async () => {
    const res = await request('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'UP');
    assert.equal(res.body.coins, 50);
  });

  test('GET / renders YOUPI Store product page with gateway showcase and demo checkout', async () => {
    const res = await request('/');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Self-Hosted UPI Payment Gateway'));
    assert.ok(res.body.includes('₹1.00'));
    assert.ok(res.body.includes('/assets/gateway_pc_checkout.png'));
  });

  test('POST /api/checkout initiates payment gateway session and returns checkoutUrl', async () => {
    const checkoutRes = await request('/api/checkout', {
      method: 'POST',
      body: {
        packName: 'Gamer Pack',
        coins: 550,
        price: 449.00,
        phoneNumber: '9876543210',
        gamerTag: 'ViperX'
      }
    });

    assert.equal(checkoutRes.status, 200);
    assert.ok(checkoutRes.body.orderId.startsWith('COIN-ORD-'));
    assert.ok(checkoutRes.body.paymentId);
    assert.ok(checkoutRes.body.checkoutUrl.includes('/checkout/'));
  });

  test('POST /api/webhook credits coins only on a signed RECONCILED event', async () => {
    const initialCoins = storeInstance.server.walletCoins;

    storeInstance.server.orders.set('COIN-ORD-555', {
      orderId: 'COIN-ORD-555',
      paymentId: 'pay_coin_test_123',
      amountPaise: 44900,
      coins: 550,
      packName: 'Gamer Pack',
      createdAt: Date.now()
    });
    storeInstance.server.orderPayments.set('COIN-ORD-555', 'pay_coin_test_123');

    const observed = JSON.stringify({
      event: 'OBSERVED_SUCCESS',
      paymentId: 'pay_coin_test_123',
      orderId: 'COIN-ORD-555',
      amount: '449.00',
      amountPaise: 44900,
      currency: 'INR',
      method: 'UPI'
    });
    const observedRes = await request('/api/webhook', {
      method: 'POST',
      headers: gatewayHeaders(observed),
      body: observed
    });
    assert.equal(observedRes.status, 200);
    assert.equal(observedRes.body.credited, false);
    assert.equal(observedRes.body.settlementState, 'NOT_RECONCILED');
    assert.equal(storeInstance.server.walletCoins, initialCoins);

    const payloadObj = {
      event: 'RECONCILED',
      paymentId: 'pay_coin_test_123',
      orderId: 'COIN-ORD-555',
      amount: '449.00',
      amountPaise: 44900,
      currency: 'INR',
      method: 'UPI',
      metadata: {
        coins: 550,
        packName: 'Gamer Pack'
      }
    };

    const payloadString = JSON.stringify(payloadObj);

    const hookRes = await request('/api/webhook', {
      method: 'POST',
      headers: gatewayHeaders(payloadString),
      body: payloadString
    });

    assert.equal(hookRes.status, 200);
    assert.equal(hookRes.body.credited, true);

    // Verify coins were credited to wallet!
    assert.equal(storeInstance.server.walletCoins, initialCoins + 550);

    // Verify recorded in ledger
    const balanceRes = await request('/api/wallet-balance');
    assert.equal(balanceRes.body.coins, initialCoins + 550);
    assert.ok(balanceRes.body.history.length >= 1);
    assert.equal(balanceRes.body.history[0].orderId, 'COIN-ORD-555');
  });

  test('POST /api/webhook rejects unknown orders and mismatched amounts, and ignores inflated metadata.coins', async () => {
    const before = storeInstance.server.walletCoins;

    // 1. Unknown orderId rejected with 404
    const unknownPayload = JSON.stringify({
      event: 'RECONCILED',
      paymentId: 'pay_unknown_999',
      orderId: 'COIN-ORD-UNKNOWN-999',
      amount: '1.00',
      amountPaise: 100,
      currency: 'INR',
      method: 'UPI',
      metadata: { coins: 99999 }
    });
    const unknownRes = await request('/api/webhook', {
      method: 'POST',
      headers: gatewayHeaders(unknownPayload),
      body: unknownPayload
    });
    assert.equal(unknownRes.status, 404);
    assert.equal(storeInstance.server.walletCoins, before);

    // 2. Mismatched amountPaise rejected with 400
    const checkout = await request('/api/checkout', {
      method: 'POST',
      body: { packName: 'Ten Rupee Pack', price: 10.00 }
    });
    assert.equal(checkout.status, 200);
    const { orderId, paymentId } = checkout.body;

    const mismatchPayload = JSON.stringify({
      event: 'RECONCILED',
      paymentId,
      orderId,
      amount: '1.00',
      amountPaise: 100,
      currency: 'INR',
      method: 'UPI',
      metadata: { coins: 99999 }
    });
    const mismatchRes = await request('/api/webhook', {
      method: 'POST',
      headers: gatewayHeaders(mismatchPayload),
      body: mismatchPayload
    });
    assert.equal(mismatchRes.status, 400);
    assert.equal(storeInstance.server.walletCoins, before);

    // 3. Matching amountPaise credits local order.coins (10), ignoring inflated metadata.coins (99999)
    const validPayload = JSON.stringify({
      event: 'RECONCILED',
      paymentId,
      orderId,
      amount: '10.00',
      amountPaise: 1000,
      currency: 'INR',
      method: 'UPI',
      metadata: { coins: 99999 }
    });
    const validRes = await request('/api/webhook', {
      method: 'POST',
      headers: gatewayHeaders(validPayload),
      body: validPayload
    });
    assert.equal(validRes.status, 200);
    assert.equal(storeInstance.server.walletCoins, before + 10);
  });

  test('POST /api/webhook rejects fraudulent signature', async () => {
    const payloadString = JSON.stringify({ event: 'SUCCESS', orderId: 'FAKE' });
    const hookRes = await request('/api/webhook', {
      method: 'POST',
      headers: gatewayHeaders(payloadString, { 'X-Gateway-Signature': 'sha256=invalid_fake_signature_hash' }),
      body: payloadString
    });

    assert.equal(hookRes.status, 401);
    assert.ok(hookRes.body.error.includes('signature'));
  });

  test('GET /wallet renders wallet page with updated balance', async () => {
    const res = await request('/wallet?orderId=COIN-ORD-555');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Customer Account') || res.body.includes('YOUPI Store'));
    assert.ok(res.body.includes('Top-Up Successful!'));
    assert.ok(res.body.includes('Current Vault Balance'));
  });

  test('custom top-up: initiates custom amount payment and credits calculated coins on webhook', async () => {
    const initialCoins = storeInstance.server.walletCoins;
    const customAmount = 250.00;
    const customCoins = 250; // 1 rs = 1 coin

    const checkoutRes = await request('/api/checkout', {
      method: 'POST',
      body: {
        packName: 'Custom Top-Up',
        coins: customCoins,
        price: customAmount,
        phoneNumber: '9876543210',
        gamerTag: 'CustomGamer'
      }
    });

    assert.equal(checkoutRes.status, 200);
    assert.ok(checkoutRes.body.checkoutUrl);
    const orderId = checkoutRes.body.orderId;

    // Simulate signed webhook receipt
    const payloadObj = {
      event: 'RECONCILED',
      paymentId: checkoutRes.body.paymentId,
      orderId,
      amount: '250.00',
      amountPaise: 25000,
      currency: 'INR',
      method: 'UPI',
      metadata: {
        coins: customCoins,
        packName: 'Custom Top-Up'
      }
    };

    const payloadString = JSON.stringify(payloadObj);

    const hookRes = await request('/api/webhook', {
      method: 'POST',
      headers: gatewayHeaders(payloadString),
      body: payloadString
    });

    assert.equal(hookRes.status, 200);
    assert.equal(storeInstance.server.walletCoins, initialCoins + customCoins);
  });

  test('minimum amount: allows exactly ₹1.00 top-up and credits 1 coin', async () => {
    const initialCoins = storeInstance.server.walletCoins;

    const checkoutRes = await request('/api/checkout', {
      method: 'POST',
      body: {
        packName: 'Micro Top-Up',
        coins: 1,
        price: 1.00,
        phoneNumber: '9876543210'
      }
    });

    assert.equal(checkoutRes.status, 200);
    const orderId = checkoutRes.body.orderId;

    const payloadObj = {
      event: 'RECONCILED',
      paymentId: checkoutRes.body.paymentId,
      orderId,
      amount: '1.00',
      amountPaise: 100,
      currency: 'INR',
      method: 'UPI',
      metadata: { coins: 1, packName: 'Micro Top-Up' }
    };
    const payloadString = JSON.stringify(payloadObj);

    const hookRes = await request('/api/webhook', {
      method: 'POST',
      headers: gatewayHeaders(payloadString),
      body: payloadString
    });

    assert.equal(hookRes.status, 200);
    assert.equal(storeInstance.server.walletCoins, initialCoins + 1);
  });

  test('minimum amount: rejects top-up of less than ₹1.00', async () => {
    const checkoutRes = await request('/api/checkout', {
      method: 'POST',
      body: {
        packName: 'Zero Top-Up',
        coins: 0,
        price: 0.50
      }
    });

    assert.equal(checkoutRes.status, 400);
    assert.ok(checkoutRes.body.error.includes('Minimum top-up amount is ₹1.00'));
  });

  test('GET /order-failed renders failed order page with deep link to support', async () => {
    const res = await request('/order-failed?orderId=COIN-ORD-999&reason=FAILED&paymentId=pay_fail_123');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Payment Unsuccessful'));
    assert.ok(res.body.includes('COIN-ORD-999'));
    assert.ok(res.body.includes('Contact Payment Support'));
    assert.ok(res.body.includes('Try Again'));
  });

  test('POST /api/verify-payment refuses to credit unknown orders and unpaid payments', async () => {
    const before = storeInstance.server.walletCoins;

    const unknown = await request('/api/verify-payment', {
      method: 'POST',
      body: { orderId: 'COIN-ORD-FORGED', coins: 999999, paymentId: 'x' }
    });
    assert.equal(unknown.status, 404);

    const checkout = await request('/api/checkout', { method: 'POST', body: { price: 100, coins: 100, packName: 'Starter Pack' } });
    assert.equal(checkout.status, 200);
    const unpaid = await request('/api/verify-payment', {
      method: 'POST',
      body: { orderId: checkout.body.orderId, coins: 999999 }
    });
    assert.equal(unpaid.status, 402);
    assert.equal(storeInstance.server.walletCoins, before);
  });

  test('POST /api/verify-payment never grants coins from a browser callback', async () => {
    const initialCoins = storeInstance.server.walletCoins;
    const checkout = await request('/api/checkout', { method: 'POST', body: { price: 100, coins: 100, packName: 'Starter Pack' } });
    assert.equal(checkout.status, 200);
    const { orderId, paymentId } = checkout.body;

    testDb.execute("UPDATE payment_sessions SET status = 'SUCCESS', method = 'UPI' WHERE id = ?", [paymentId]);
    const successRes = await request('/api/verify-payment', {
      method: 'POST',
      body: { orderId, coins: 999999, packName: 'Ignored' }
    });
    assert.equal(successRes.status, 202);
    assert.equal(successRes.body.credited, false);
    assert.equal(storeInstance.server.walletCoins, initialCoins);

    testDb.execute("UPDATE payment_sessions SET status = 'RECONCILED', method = 'UPI' WHERE id = ?", [paymentId]);
    const reconciledRes = await request('/api/verify-payment', { method: 'POST', body: { orderId } });
    assert.equal(reconciledRes.status, 202);
    assert.equal(reconciledRes.body.credited, false);
    assert.equal(storeInstance.server.walletCoins, initialCoins);
  });

  test('GET /order-success renders verified payment page with parameters', async () => {
    const res = await request('/order-success?order_id=ORD-SUCC-123&amount=499.00&utr=998877665544&mode=UPI');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Payment Successful!'));
    assert.ok(res.body.includes('ORD-SUCC-123'));
    assert.ok(res.body.includes('499.00'));
    assert.ok(res.body.includes('998877665544'));
    assert.ok(res.body.includes('VERIFIED BY YOUPI PG'));
  });

  test('GET /order-suspicious renders held for review security notice', async () => {
    const res = await request('/order-suspicious?order_id=ORD-SUSP-456');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Payment Under Review'));
    assert.ok(res.body.includes('ORD-SUSP-456'));
    assert.ok(res.body.includes('SECURITY NOTICE'));
  });

  test('GET /order-expired renders expired session notice', async () => {
    const res = await request('/order-expired?order_id=ORD-EXP-789');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Payment Session Expired'));
    assert.ok(res.body.includes('ORD-EXP-789'));
  });

  test('GET /order-cancelled renders cancelled session notice', async () => {
    const res = await request('/order-cancelled?order_id=ORD-CAN-000');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Payment Cancelled'));
    assert.ok(res.body.includes('ORD-CAN-000'));
  });

  test('GET /youpi.js is served with CORS for universal frontend integration', async () => {
    const res = await request('/youpi.js');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('YoupiCheckout'));
    assert.ok(res.body.includes('data-youpi-pay'));
  });

  test('Reverse proxy: proxies /api/v1/* requests to payment API directly', async () => {
    const res = await request('/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'UP');
  });

  test('Reverse proxy: /checkout/* does not return 404 Route Not Found', async () => {
    const res = await request('/checkout/some-session-id');
    // It should either return 200/502 (if portal not up on that test port), but NEVER 404 "Route Not Found"
    assert.notEqual(res.body, 'Route Not Found');
  });

  test('GET /css/store.css serves modular stylesheet with proper Content-Type', async () => {
    const res = await request('/css/store.css');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/css'));
    assert.ok(res.body.includes('--primary: #2563eb'));
    assert.ok(res.body.includes('table-responsive-wrapper'));
  });

  test('GET /js/store.js serves modular client script with proper Content-Type', async () => {
    const res = await request('/js/store.js');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/javascript'));
    assert.ok(res.body.includes('startGatewayPurchase'));
    assert.ok(res.body.includes('youpi:payment:success'));
  });

  test('Security: directory traversal attempts on public static assets are blocked', async () => {
    const res = await request('/css/../../package.json');
    // Traversal should not return package.json content with 200
    assert.ok(res.status === 404 || res.status === 502 || !res.body.includes('"name": "youpi-pg"'));
  });
});
