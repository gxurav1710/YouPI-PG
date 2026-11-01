import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../apps/payment-api/src/index.js';
import { AndroidObserverDriver } from '../driver.js';
import { PaymentStatus, resolveSecret } from '@youpi/common';

describe('Android Payment Observer Integration Tests', () => {
  let apiInstance;
  let driver;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6217, testDb);
    driver = new AndroidObserverDriver({
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      deviceName: 'Pixel 8 Pro Tester',
      deviceModel: 'Pixel 8 Pro'
    });
  });

  after(async () => {
    driver.stopHeartbeat();
    await apiInstance.close();
    testDb.close();
  });

  async function ensurePaired() {
    if (!driver.deviceId || !driver.signingKey) {
      const enrollmentSecret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');
      await driver.pair(enrollmentSecret);
    }
  }

  function resetReceivingSlot(receivingAccountId = '00000000-0000-0000-0000-000000000002') {
    testDb.execute(
      "UPDATE payment_sessions SET status = 'EXPIRED' WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')",
      [receivingAccountId]
    );
    testDb.execute(
      'UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?',
      [receivingAccountId]
    );
  }

  test('rejects pairing with invalid enrollment token', async () => {
    await assert.rejects(
      () => driver.pair('invalid_token_123'),
      /Device pairing failed/
    );
  });

  test('successfully pairs Android device with valid enrollment token', async () => {
    const enrollmentSecret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');
    const pairResult = await driver.pair(enrollmentSecret);

    assert.ok(pairResult.paired);
    assert.ok(pairResult.deviceId);
    assert.ok(pairResult.signingKey);

    assert.equal(driver.deviceId, pairResult.deviceId);
    assert.equal(driver.signingKey, pairResult.signingKey);
  });

  test('sends heartbeat acknowledging liveness', async () => {
    await ensurePaired();
    const hbResult = await driver.sendHeartbeat();
    assert.equal(hbResult.status, 'HEARTBEAT_ACK');
    assert.ok(hbResult.timestamp);
  });

  test('rejects observation with expired/drifted timestamp (Replay Protection)', async () => {
    await ensurePaired();
    // Timestamp 2 minutes in the past (> 60s drift)
    const oldTimestamp = Date.now() - 120000;
    const res = await driver.submitObservation({
      amount: '200.00',
      timestampOverride: oldTimestamp
    });

    assert.equal(res.status, 401);
    assert.ok(res.body.error.includes('validity window'));
  });

  test('submits valid HMAC-signed observation and confirms payment in Payment API', async () => {
    await ensurePaired();
    resetReceivingSlot();
    // 1. Create and activate a payment session for ₹350
    const session = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'ANDR-ORD-350',
      amountPaise: 35000n
    });

    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

    // 2. Android observer submits observation for ₹350
    const res = await driver.submitObservation({
      amount: '350.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-ANDR-9876',
      senderVpa: 'customer@paytm',
      notificationText: 'Payment of ₹350 received from customer@paytm on PhonePe'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.attribution.attributed, true);
    assert.equal(res.body.attribution.paymentSessionId, session.id);
    assert.equal(res.body.attribution.outcomeStatus, PaymentStatus.OBSERVED_SUCCESS);

    // 3. Verify session in DB updated to SUCCESS
    const updated = apiInstance.app.context.sessionRepo.findById(session.id);
    assert.equal(updated.status, PaymentStatus.OBSERVED_SUCCESS);
  });

  test('Issue #61: rejects notification observation when rawNotification has missing or empty package', async () => {
    await ensurePaired();
    const resWithoutPkg = await driver.submitObservation({
      amount: '100.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-MISSING-PKG',
      notificationText: 'Payment of ₹100 received from user@bank on UPI',
      package: ''
    });

    assert.equal(resWithoutPkg.status, 400);
    assert.match(resWithoutPkg.body.error, /must specify a valid package name/);
  });

  test('Issue #61: rejects notification observation from untrusted/unallowed package name', async () => {
    await ensurePaired();
    const resUntrusted = await driver.submitObservation({
      amount: '100.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-UNTRUSTED-PKG',
      notificationText: 'Payment of ₹100 received from fake@bank on FakeApp',
      package: 'com.attacker.fake.banking'
    });

    assert.equal(resUntrusted.status, 400);
    assert.match(resUntrusted.body.error, /Untrusted Android notification package/);
  });

  test('submits observation with clientMessageId and returns it in response', async () => {
    await ensurePaired();
    resetReceivingSlot();
    const session = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'ANDR-CLIENT-MSG-1',
      amountPaise: 15000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

    const clientMsgId = 'msg-uuid-999-client';
    const res = await driver.submitObservation({
      amount: '150.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-MSG-112233',
      clientMessageId: clientMsgId,
      notificationText: 'Payment of ₹150 received via UPI'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.clientMessageId, clientMsgId);
  });

  test('submits raw bank SMS with clientMessageId and processes through pipeline', async () => {
    await ensurePaired();
    resetReceivingSlot();
    const session = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'ANDR-CLIENT-SMS-1',
      amountPaise: 50000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

    const clientMsgId = 'sms-uuid-777-client';
    const res = await driver.submitSms({
      sender: 'VK-HDFCBK',
      body: 'Dear Customer, INR 500.00 credited to your A/C ending 4321 via UPI Ref 999888777666 on 20-OCT-26.',
      clientMessageId: clientMsgId
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.clientMessageId, clientMsgId);

    // Also verify clientMessageId is echoed on rejected/unresolved poller responses (400)
    const rejectedMsgId = 'sms-uuid-400-rejected';
    const rejectedRes = await driver.submitObservation({
      amount: '999.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-NO-ACTIVE-999',
      clientMessageId: rejectedMsgId,
      notificationText: 'Payment of ₹999 received via UPI'
    });
    assert.equal(rejectedRes.status, 400);
    assert.equal(rejectedRes.body.accepted, false);
    assert.equal(rejectedRes.body.clientMessageId, rejectedMsgId);
  });

  test('on-device bank SMS filter logic validates institutional senders and rejects personal numbers', () => {
    const INSTITUTIONAL_SENDER_PATTERN = /^(?:[A-Za-z]{2}-)?([A-Za-z0-9]{3,9})$/;
    const NUMERIC_PHONE_PATTERN = /^\+?[0-9]{7,15}$/;
    const CREDIT_KEYWORD_PATTERN = /(?:credited|received|deposit(?:ed)?|payment\s+received|transferred\s+to\s+your|has\s+transferred|deposited\s+in|cr\b|upi\s+credit)/i;
    const EXPLICIT_DEBIT_PATTERN = /(?:debited\b|spent\s+on|paid\s+to|withdrawn\s+from|dr\b|payment\s+sent)/i;

    // Test institutional senders
    assert.ok(INSTITUTIONAL_SENDER_PATTERN.test('VK-HDFCBK'));
    assert.ok(INSTITUTIONAL_SENDER_PATTERN.test('AD-SBIINB'));
    assert.ok(INSTITUTIONAL_SENDER_PATTERN.test('BZ-ICICIB'));
    assert.ok(INSTITUTIONAL_SENDER_PATTERN.test('VM-AXISBK'));
    assert.ok(INSTITUTIONAL_SENDER_PATTERN.test('HDFCBK'));

    // Test rejection of personal phone numbers
    assert.ok(NUMERIC_PHONE_PATTERN.test('+919876543210'));
    assert.ok(NUMERIC_PHONE_PATTERN.test('9876543210'));
    assert.ok(NUMERIC_PHONE_PATTERN.test('+14155552671'));

    // Test credit vs debit intent
    const creditSms = 'INR 500.00 credited to your A/C ending 4321 via UPI';
    const debitSms = 'INR 500.00 debited from your A/C ending 4321 towards Amazon';
    assert.ok(CREDIT_KEYWORD_PATTERN.test(creditSms));
    assert.ok(EXPLICIT_DEBIT_PATTERN.test(debitSms));
  });
});
