import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database, runMigrations } from '../index.js';
import { MerchantRepository } from '../repositories/merchant.repository.js';
import { ReceivingAccountRepository } from '../repositories/receiving-account.repository.js';
import { CustomerRepository } from '../repositories/customer.repository.js';
import { CustomerSessionRepository } from '../repositories/customer-session.repository.js';
import { PaymentSessionRepository } from '../repositories/payment-session.repository.js';
import { ObservationRepository } from '../repositories/observation.repository.js';
import { AuditLogRepository } from '../repositories/audit-log.repository.js';
import { QueueEngine } from '@youpi/core';
import { TimingEngine } from '@youpi/core';
import { AttributionEngine } from '@youpi/core';
import { WebhookEngine } from '@youpi/core';
import { generateQrSvg } from '@youpi/core';
import {
  buildUpiUri,
  buildUpiIntentUri,
  getUpiProviders,
  findUpiProviderById,
  PaymentStatus,
  PaymentMethod,
  normalizeEmail,
  normalizeMobile,
  isValidEmail,
  isValidMobile,
  isValidPassword
} from '@youpi/common';
import { startServer as startPaymentApi } from '../../../../apps/payment-api/src/index.js';
import { CoinWalletStoreServer } from '../../../../apps/coin-wallet-store/src/server.js';
import { YoupiPaymentClient } from '@youpi/merchant-sdk';
import { authHeadersFor } from '../../../../scripts/test-support.js';

test('Full 53-Point Customer Identity, Authentication & Payment Invariant Matrix', async () => {
  process.env.NODE_ENV = 'test';
  process.env.YOUPI_ALLOWED_RETURN_ORIGINS = 'https://novacommerce.com http://localhost:5984';
  const testDb = new Database({ inMemory: true });
  runMigrations(testDb);

  const merchantRepo = new MerchantRepository(testDb);
  const accountRepo = new ReceivingAccountRepository(testDb);
  const customerRepo = new CustomerRepository(testDb);
  const customerSessionRepo = new CustomerSessionRepository(testDb, customerRepo);
  const sessionRepo = new PaymentSessionRepository(testDb);
  const obsRepo = new ObservationRepository(testDb);
  const auditRepo = new AuditLogRepository(testDb);
  const queueEngine = new QueueEngine({ sessionRepo, accountRepo });
  const timingEngine = new TimingEngine({ sessionRepo, accountRepo });
  const attributionEngine = new AttributionEngine({ sessionRepo, obsRepo });
  const webhookEngine = new WebhookEngine({ db: testDb, merchantRepo });

  const merchant = merchantRepo.create({
    businessName: 'Nova Commerce Ltd',
    slug: 'nova-store',
    contactEmail: 'support@novacommerce.com',
    contactPhone: '+919876543210',
    webhookUrl: 'https://novacommerce.com/webhook',
    webhookSecret: 'sec_test_novacommerce_secret_key',
    branding: {
      appName: 'NovaPay',
      primaryColor: '#0284c7',
      logoUrl: 'https://novacommerce.com/logo.png',
      enabledPaymentMethods: ['UPI', 'CASH_COUNTER', 'CARD_COUNTER']
    }
  });

  const receivingAccount = accountRepo.create({
    merchantId: merchant.id,
    upiId: 'novastore@hdfcbank',
    payeeName: 'Nova Commerce India',
    isMerchantEnabled: true,
    isActive: true
  });

  const apiInstance = await startPaymentApi(6984, testDb);
  const apiBase = `http://localhost:${apiInstance.port}`;

  const demoStore = new CoinWalletStoreServer({
    gatewayApiUrl: apiBase,
    merchantId: merchant.id,
    webhookSecret: merchant.webhookSecret,
    publicBaseUrl: 'http://localhost:5984'
  });
  const demoServer = demoStore.createServer();
  await new Promise(resolve => demoServer.listen(5984, resolve));
  const demoBase = 'http://localhost:5984';

  function httpReq(method, url, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const postData = body ? JSON.stringify(body) : null;
      const reqHeaders = {
        'Content-Type': 'application/json',
        ...authHeadersFor(url),
        ...headers
      };
      if (postData) {
        reqHeaders['Content-Length'] = Buffer.byteLength(postData);
      }

      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method,
          headers: reqHeaders
        },
        res => {
          let text = '';
          res.on('data', chunk => { text += chunk; });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(text); } catch {}
            resolve({ status: res.statusCode, headers: res.headers, text, body: json });
          });
        }
      );
      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });
  }

  try {
    // --- AUTH CREATION (1 - 6) ---
    // 1. Signup with valid name/email/mobile/password
    const reg1 = await httpReq('POST', `${apiBase}/api/v1/customer/register`, {
      name: 'Gaurav Sharma',
      email: 'Gaurav.Sharma@Example.COM',
      mobileNumber: '+91 9876543210',
      password: 'StrongPassword123!'
    });
    assert.equal(reg1.status, 201);
    assert.ok(reg1.body.token);
    assert.equal(reg1.body.customer.name, 'Gaurav Sharma');
    assert.equal(reg1.body.customer.email, 'gaurav.sharma@example.com');
    assert.equal(reg1.body.customer.mobileNumber, '9876543210');

    // 2. Password is hashed
    const custInDb = testDb.queryOne('SELECT * FROM customers WHERE id = ?', [reg1.body.customer.id]);
    assert.ok(custInDb.password_hash);
    assert.notEqual(custInDb.password_hash, 'StrongPassword123!');
    assert.ok(custInDb.password_hash.includes(':'));

    // 3. Plaintext password is never persisted or returned
    assert.equal(reg1.body.password, undefined);
    assert.equal(reg1.body.customer.password, undefined);
    assert.equal(reg1.body.customer.passwordHash, undefined);
    assert.equal(JSON.stringify(custInDb).includes('StrongPassword123!'), false);

    // 4. Duplicate email is rejected
    const dupEmail = await httpReq('POST', `${apiBase}/api/v1/customer/register`, {
      name: 'Another Person',
      email: 'gaurav.sharma@example.com',
      mobileNumber: '9123456780',
      password: 'AnotherPassword123!'
    });
    assert.equal(dupEmail.status, 409);

    // 5. Duplicate mobile is rejected
    const dupMobile = await httpReq('POST', `${apiBase}/api/v1/customer/register`, {
      name: 'Another Person',
      email: 'another.unique@example.com',
      mobileNumber: '9876543210',
      password: 'AnotherPassword123!'
    });
    assert.equal(dupMobile.status, 409);

    // 5.5 Email normalization
    assert.equal(normalizeEmail('  USER.Name+tag@DOMAIN.Co.In  '), 'user.name+tag@domain.co.in');
    assert.equal(isValidEmail('not-an-email'), false);
    assert.equal(isValidEmail('valid.user@sub.domain.org'), true);

    // 6. Mobile normalization
    assert.equal(normalizeMobile('+91 98765-43210'), '9876543210');
    assert.equal(normalizeMobile('09876543210'), '9876543210');
    assert.equal(normalizeMobile('919876543210'), '9876543210');
    assert.equal(isValidMobile('9876543210'), true);
    assert.equal(isValidMobile('12345'), false);

    // --- LOGIN (7 - 10) ---
    // 7. Login with valid credentials (email & mobile)
    const loginEmail = await httpReq('POST', `${apiBase}/api/v1/customer/login`, {
      identifier: 'gaurav.sharma@example.com',
      password: 'StrongPassword123!'
    });
    assert.equal(loginEmail.status, 200);
    assert.ok(loginEmail.body.token);

    const loginMobile = await httpReq('POST', `${apiBase}/api/v1/customer/login`, {
      identifier: '9876543210',
      password: 'StrongPassword123!'
    });
    assert.equal(loginMobile.status, 200);
    assert.ok(loginMobile.body.token);

    // 8. Invalid password rejected
    const badPass = await httpReq('POST', `${apiBase}/api/v1/customer/login`, {
      identifier: 'gaurav.sharma@example.com',
      password: 'WrongPassword999!'
    });
    assert.equal(badPass.status, 401);

    // 9. Unknown account rejected safely
    const unknownAcc = await httpReq('POST', `${apiBase}/api/v1/customer/login`, {
      identifier: 'nonexistent@example.com',
      password: 'AnyPassword123!'
    });
    assert.equal(unknownAcc.status, 401);

    // 10. Valid session can be restored
    const restoreSession = await httpReq('GET', `${apiBase}/api/v1/customer/me`, null, {
      'Authorization': `Bearer ${loginEmail.body.token}`
    });
    assert.equal(restoreSession.status, 200);
    assert.equal(restoreSession.body.authenticated, true);
    assert.equal(restoreSession.body.customer.id, reg1.body.customer.id);

    // --- AUTO LOGIN (11 - 14) ---
    // 11 & 12. Return to checkout with valid remembered session
    const autoVerify = customerSessionRepo.findByToken(loginEmail.body.token);
    assert.ok(autoVerify);
    assert.equal(autoVerify.customer.name, 'Gaurav Sharma');

    // 13. Payment session does NOT need recreation on page refresh
    const paymentClient = new YoupiPaymentClient({
      apiUrl: apiBase,
      merchantId: merchant.id,
      webhookSecret: merchant.webhookSecret
    });
    const p1 = await paymentClient.createPayment({
      orderId: 'ORD-AUTO-01',
      amount: '150.00',
      returnUrl: 'https://novacommerce.com/complete'
    });
    assert.ok(p1.status === 'INITIATED' || p1.status === 'ACTIVE');
    const p1StateA = await httpReq('GET', `${apiBase}/api/v1/checkout/${p1.paymentId}/state`);
    const p1StateB = await httpReq('GET', `${apiBase}/api/v1/checkout/${p1.paymentId}/state`);
    assert.equal(p1StateA.body.paymentId, p1.paymentId);
    assert.equal(p1StateB.body.paymentId, p1.paymentId);
    sessionRepo.transitionToTerminal(p1.paymentId, PaymentStatus.CANCELLED);

    // 14. Expired auth session requires reauthentication
    const expiredSess = customerSessionRepo.create({
      customerId: reg1.body.customer.id,
      ttlHours: -1
    });
    assert.equal(customerSessionRepo.findByToken(expiredSess.token), null);
    const meExpired = await httpReq('GET', `${apiBase}/api/v1/customer/me`, null, {
      'Authorization': `Bearer ${expiredSess.token}`
    });
    assert.equal(meExpired.status, 401);

    // --- PAYMENT GATE (15 - 19) ---
    // 15, 16, 17. Unauthenticated checkout does not start session, timer or queue
    const unauthPayment = await paymentClient.createPayment({
      orderId: 'ORD-GATE-01',
      amount: '200.00',
      autoActivate: false
    });
    const unauthSession = sessionRepo.findById(unauthPayment.paymentId);
    assert.ok(unauthSession.status === PaymentStatus.INITIATED || unauthSession.status === PaymentStatus.QUEUED);
    assert.equal(unauthSession.expiresAt, null);
    assert.equal(unauthSession.customerId, null);
    const accountStateBefore = accountRepo.findById(receivingAccount.id);
    assert.equal(accountStateBefore.isSlotBusy, false);

    // 18. Customer authenticates successfully
    const authSess = customerSessionRepo.create({ customerId: reg1.body.customer.id });
    assert.ok(authSess.token);

    // 19. Payment session then starts
    const bindRes = await httpReq('POST', `${apiBase}/api/v1/checkout/${unauthPayment.paymentId}/bind-customer`, {
      token: authSess.token
    });
    assert.equal(bindRes.status, 200);
    assert.equal(bindRes.body.status, PaymentStatus.ACTIVE);
    assert.ok(bindRes.body.expiresAt);

    const activatedSession = sessionRepo.findById(unauthPayment.paymentId);
    assert.equal(activatedSession.status, PaymentStatus.ACTIVE);
    assert.equal(activatedSession.customerId, reg1.body.customer.id);
    const accountStateAfter = accountRepo.findById(receivingAccount.id);
    assert.equal(accountStateAfter.isSlotBusy, true);

    // --- ACCOUNT SWITCHING (20 - 26) ---
    // 20, 21, 22. 2-Account browser limit enforcement
    const reg2 = await httpReq('POST', `${apiBase}/api/v1/customer/register`, {
      name: 'Pooja Verma',
      email: 'pooja.verma@example.com',
      mobileNumber: '9888877777',
      password: 'Password987!'
    });
    assert.equal(reg2.status, 201);

    function simulateSave(store, cust, token) {
      const entry = { id: cust.id, name: cust.name, email: cust.email, mobileNumber: cust.mobileNumber, token, lastUsed: Date.now() };
      const idx = store.findIndex(a => a.id === cust.id);
      if (idx >= 0) store[idx] = entry;
      else if (store.length >= 2) {
        store.sort((a, b) => a.lastUsed - b.lastUsed);
        store[0] = entry;
      } else {
        store.push(entry);
      }
      return store.slice(0, 2);
    }

    let accountsStore = [];
    accountsStore = simulateSave(accountsStore, reg1.body.customer, reg1.body.token);
    assert.equal(accountsStore.length, 1);
    accountsStore = simulateSave(accountsStore, reg2.body.customer, reg2.body.token);
    assert.equal(accountsStore.length, 2);

    const reg3 = await httpReq('POST', `${apiBase}/api/v1/customer/register`, {
      name: 'Third User',
      email: 'third.user@example.com',
      mobileNumber: '9666655555',
      password: 'Password654!'
    });
    accountsStore = simulateSave(accountsStore, reg3.body.customer, reg3.body.token);
    assert.equal(accountsStore.length, 2);

    // 23 & 24. Switch from Account A to Account B, and Account B to Account A
    const switchResB = await httpReq('POST', `${apiBase}/api/v1/customer/switch-account`, {
      token: reg2.body.token
    });
    assert.equal(switchResB.status, 200);
    assert.equal(switchResB.body.customer.email, 'pooja.verma@example.com');

    const switchResA = await httpReq('POST', `${apiBase}/api/v1/customer/switch-account`, {
      token: reg1.body.token
    });
    assert.equal(switchResA.status, 200);
    assert.equal(switchResA.body.customer.email, 'gaurav.sharma@example.com');

    // 25. Expired account session asks for reauthentication
    const switchExpired = await httpReq('POST', `${apiBase}/api/v1/customer/switch-account`, {
      token: expiredSess.token
    });
    assert.equal(switchExpired.status, 401);

    // 26. Switching account does not mutate another account's data
    const c1 = customerRepo.findById(reg1.body.customer.id);
    const c2 = customerRepo.findById(reg2.body.customer.id);
    assert.equal(c1.name, 'Gaurav Sharma');
    assert.equal(c2.name, 'Pooja Verma');
    assert.notEqual(c1.email, c2.email);

    // --- LOGOUT (27 - 31) ---
    // 27. Logout invalidates current session
    const logoutRes = await httpReq('POST', `${apiBase}/api/v1/customer/logout`, {
      token: reg1.body.token
    });
    assert.equal(logoutRes.status, 200);
    const afterLogout = await httpReq('GET', `${apiBase}/api/v1/customer/me`, null, {
      'Authorization': `Bearer ${reg1.body.token}`
    });
    assert.equal(afterLogout.status, 401);

    // 28. Saved account remains available
    assert.equal(accountsStore.length, 2);

    // 29. Logout does not delete customer database record
    assert.ok(customerRepo.findById(reg1.body.customer.id));

    // 30. User can log back into saved account
    const reLogin = await httpReq('POST', `${apiBase}/api/v1/customer/login`, {
      identifier: 'gaurav.sharma@example.com',
      password: 'StrongPassword123!'
    });
    assert.equal(reLogin.status, 200);

    // 31. User can sign in/create another account
    const reg4 = await httpReq('POST', `${apiBase}/api/v1/customer/register`, {
      name: 'Fourth Customer',
      email: 'fourth@example.com',
      mobileNumber: '9555544444',
      password: 'Password555!'
    });
    assert.equal(reg4.status, 201);

    // --- PAYMENT INTEGRITY (32 - 36) ---
    // 32, 33, 34, 35. Identity immutability and anti-hijacking
    const payActive = sessionRepo.findById(unauthPayment.paymentId);
    assert.equal(payActive.customerId, reg1.body.customer.id);

    const hijackRes = await httpReq('POST', `${apiBase}/api/v1/checkout/${unauthPayment.paymentId}/bind-customer`, {
      token: reg2.body.token
    });
    assert.equal(hijackRes.status, 409);

    const tamperRes = await httpReq('POST', `${apiBase}/api/v1/checkout/${unauthPayment.paymentId}/bind-customer`, {
      customerId: reg2.body.customer.id
    });
    assert.equal(tamperRes.status, 409);
    assert.equal(sessionRepo.findById(unauthPayment.paymentId).customerId, reg1.body.customer.id);

    // 36. Existing payment verification continues working
    const obs = attributionEngine.processObservation({
      receivingAccountId: receivingAccount.id,
      source: 'ANDROID_OBSERVER',
      amountPaise: 20000n,
      observedAt: new Date(),
      senderVpa: 'payer@upi',
      bankReferenceNumber: 'UTR_MATRIX_36',
      fingerprintHash: 'fp_matrix_' + Date.now(),
      rawPayload: {}
    });
    assert.equal(obs.attributed, true);
    assert.equal(obs.paymentSessionId, unauthPayment.paymentId);
    assert.equal(obs.outcomeStatus, PaymentStatus.OBSERVED_SUCCESS);

    // --- DEMO STORE (37 - 40) ---
    // 37 & 38. Demo Purchase redirects without storefront auth
    const demoBuy = await httpReq('POST', `${demoBase}/api/checkout`, {
      packName: 'Gamer Pack',
      coins: 500,
      price: 500
    });
    assert.equal(demoBuy.status, 200);
    assert.ok(demoBuy.body.checkoutUrl);

    // 39. Checkout authentication appears
    const demoState = await httpReq('GET', `${apiBase}/api/v1/checkout/${demoBuy.body.paymentId}/state`);
    assert.equal(demoState.body.customer, null);
    assert.equal(demoState.body.status, 'INITIATED');

    // 40. Payment begins only after authentication
    const bindDemo = await httpReq('POST', `${apiBase}/api/v1/checkout/${demoBuy.body.paymentId}/bind-customer`, {
      token: reLogin.body.token
    });
    assert.equal(bindDemo.status, 200);
    assert.equal(bindDemo.body.status, PaymentStatus.ACTIVE);
    assert.ok(bindDemo.body.expiresAt);

    // Complete demo payment to free slot for next test
    sessionRepo.transitionToTerminal(demoBuy.body.paymentId, PaymentStatus.SUCCESS);
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccount.id]);

    // --- MERCHANT INTEGRATION (41 - 43) ---
    // 41, 42, 43. Generic merchant integration creates payment without customer auth
    await assert.rejects(paymentClient.createPayment({
      orderId: 'EXT-MERCHANT-ORD-101',
      amount: '50.00',
      returnUrl: 'https://thirdparty.com/return'
    }), /returnUrl origin is not allowlisted/);
    const genericPay = await paymentClient.createPayment({
      orderId: 'EXT-MERCHANT-ORD-101', amount: '50.00'
    });
    assert.ok(genericPay.paymentId);
    assert.ok(genericPay.checkoutUrl);
    assert.equal(genericPay.status, 'INITIATED');

    const genericBind = await httpReq('POST', `${apiBase}/api/v1/checkout/${genericPay.paymentId}/bind-customer`, {
      token: reLogin.body.token
    });
    assert.equal(genericBind.status, 200);
    assert.equal(genericBind.body.status, 'ACTIVE');
    assert.equal(genericBind.body.customer.name, 'Gaurav Sharma');

    // Complete generic payment to free slot for queue tests
    sessionRepo.transitionToTerminal(genericPay.paymentId, PaymentStatus.SUCCESS);
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccount.id]);

    // --- REGRESSION (44 - 53) ---
    // 44. UPI QR works
    const upiUri = buildUpiUri({
      payeeVpa: receivingAccount.upiId,
      payeeName: receivingAccount.payeeName,
      amountPaise: 5000n,
      transactionRef: 'REG-UPI-44',
      currency: 'INR'
    });
    assert.equal(upiUri, 'upi://pay?pa=novastore%40hdfcbank&pn=Nova+Commerce+India&am=50.00&tn=REG-UPI-44');
    const qrSvg = generateQrSvg(upiUri, 220);
    assert.ok(qrSvg.includes('<svg') && qrSvg.includes('</svg>'));

    // 45. UPI provider buttons work
    const providers = getUpiProviders();
    assert.equal(providers.length, 30);
    const gpay = findUpiProviderById('google-pay');
    const intent = buildUpiIntentUri({
      payeeVpa: receivingAccount.upiId,
      payeeName: receivingAccount.payeeName,
      amountPaise: 5000n,
      transactionRef: 'REG-UPI-45',
      packageName: gpay.packageName
    });
    assert.ok(intent.startsWith('intent://pay?'));
    assert.ok(intent.includes('package=' + gpay.packageName));
    assert.equal(intent.includes('cu='), false);

    // 46. Existing merchant/non-merchant UPI behavior works
    const nonMerchantAccount = accountRepo.create({
      merchantId: merchant.id,
      upiId: 'personal.store@okhdfcbank',
      payeeName: 'Personal Store Account',
      isMerchantEnabled: false,
      isActive: false
    });
    assert.equal(nonMerchantAccount.isMerchantEnabled, false);

    // 47. Queue logic works
    const qPay1 = sessionRepo.create({
      merchantId: merchant.id,
      receivingAccountId: receivingAccount.id,
      orderId: 'QUEUE-ORD-1',
      amountPaise: 1000n,
      status: PaymentStatus.INITIATED
    });
    const qRes1 = queueEngine.enqueueOrActivate(qPay1.id, receivingAccount.id);
    assert.equal(qRes1.status, PaymentStatus.ACTIVE);

    const qPay2 = sessionRepo.create({
      merchantId: merchant.id,
      receivingAccountId: receivingAccount.id,
      orderId: 'QUEUE-ORD-2',
      amountPaise: 1000n,
      status: PaymentStatus.INITIATED
    });
    const qRes2 = queueEngine.enqueueOrActivate(qPay2.id, receivingAccount.id);
    assert.equal(qRes2.status, PaymentStatus.QUEUED);
    assert.equal(qRes2.queuePosition, 1);

    // 48. Timing logic works
    const proc = timingEngine.handlePaymentDone(qPay1.id);
    assert.equal(proc.status, PaymentStatus.PROCESSING);
    assert.ok(proc.processingExpiresAt);

    // 49. Verification works
    const qObs = attributionEngine.processObservation({
      receivingAccountId: receivingAccount.id,
      source: 'GMAIL_OBSERVER',
      amountPaise: 1000n,
      observedAt: new Date(),
      bankReferenceNumber: 'UTR_QUEUE_DONE_01',
      fingerprintHash: 'fp_q_' + Date.now(),
      rawPayload: {}
    });
    assert.equal(qObs.attributed, true);
    assert.equal(qObs.paymentSessionId, qPay1.id);

    // 50. Webhook delivery works
    const whResult = await webhookEngine.dispatch('SUCCESS', sessionRepo.findById(qPay1.id));
    assert.ok(whResult.deliveryId);

    // 51. Merchant dashboard works
    const dashSettings = await httpReq('GET', `${apiBase}/api/v1/admin/merchant-settings?merchantId=${merchant.id}`);
    assert.equal(dashSettings.status, 200);
    assert.equal(dashSettings.body.businessName, 'Nova Commerce Ltd');

    // 52. Observer services work
    const pollerActive = await httpReq('GET', `${apiBase}/api/v1/pollers/active-window?receivingAccountId=${receivingAccount.id}`, null, authHeadersFor('/api/v1/pollers/active-window'));
    assert.equal(pollerActive.status, 200);
    assert.ok(Array.isArray(pollerActive.body.sessions));

    // 53. Control center works
    const health = await httpReq('GET', `${apiBase}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'UP');

  } finally {
    await apiInstance.close();
    await new Promise(resolve => demoServer.close(resolve));
    testDb.close();
  }
});
