import crypto from 'node:crypto';
import { PaymentSessionRepository } from '@youpi/db';
import { generateHmac, toRupeesString, validateOutboundWebhookUrl } from '@youpi/common';
import { toPublicOutcome, isDispatchableOutcome, settlementStateFor } from './state-machine.js';

export class WebhookEngine {
  /**
   * @param {{
   *   db: import('@youpi/db').Database,
   *   merchantRepo: import('@youpi/db').MerchantRepository,
   *   maxRetries?: number
   * }} options
   */
  constructor(options) {
    this.db = options.db;
    this.merchantRepo = options.merchantRepo;
    this.sessionRepo = options.sessionRepo || new PaymentSessionRepository(this.db);
    this.maxRetries = Math.max(2, Math.min(20, Number(options.maxRetries) || 5));
  }

  /**
   * Builds the canonical webhook payload object for a payment session and outcome.
   * @param {string} publicOutcome
   * @param {any} session
   * @param {string} deliveryId
   * @param {number} timestampNum
   */
  _buildPayload(publicOutcome, session, deliveryId, timestampNum) {
    // Resolve UTR / bank reference number if attributed.
    // The bank reference (UTR/RRN) lives on the attributed observation, not on the
    // session row. Merchants need it to reconcile a webhook against their bank
    // statement, and it is part of the documented webhook contract.
    let utr = session.customerUtr || session.customer_utr || session.utr || session.bankReferenceNumber || session.bank_reference_number || '';
    const attributedObsId = session.attributedObservationId || session.attributed_observation_id;
    if (!utr && attributedObsId) {
      try {
        const obsRow = this.db.queryOne(
          'SELECT bank_reference_number FROM payment_observations WHERE id = ?',
          [attributedObsId]
        );
        if (obsRow?.bank_reference_number) utr = obsRow.bank_reference_number;
      } catch {}
    }

    const amountPaiseVal = session.amountPaise !== undefined ? session.amountPaise : session.amount_paise;
    const orderIdVal = session.orderId || session.order_id;
    const attemptIdVal = session.attemptId || session.attempt_id || session.id;
    const completedAtRaw = session.completedAt || session.completed_at;
    let metadataVal = session.metadata;
    if (typeof metadataVal === 'string') {
      try { metadataVal = JSON.parse(metadataVal); } catch { metadataVal = {}; }
    }

    return {
      event: publicOutcome,
      deliveryId,
      timestamp: timestampNum,
      paymentId: session.id,
      orderId: orderIdVal,
      attemptId: attemptIdVal,
      amount: toRupeesString(amountPaiseVal),
      amountPaise: Number(amountPaiseVal),
      currency: session.currency || 'INR',
      method: session.method || 'UPI',
      utr: String(utr || ''),
      verificationTag: session.verificationTag || session.verification_tag || (session.method === 'COD' ? 'COD_ORDER_PLACED' : 'UNVERIFIED'),
      verificationLevel: session.verificationLevel != null ? Number(session.verificationLevel) : (session.verification_level != null ? Number(session.verification_level) : (session.method === 'COD' ? 1 : 0)),
      completedAt: completedAtRaw ? (typeof completedAtRaw.toISOString === 'function' ? completedAtRaw.toISOString() : String(completedAtRaw)) : new Date().toISOString(),
      metadata: metadataVal || {},
      settlementState: settlementStateFor(publicOutcome)
    };
  }

  /**
   * Formats and dispatches a signed webhook for a payment event.
   * Persists the pending delivery row in `webhook_deliveries` BEFORE making the outbound
   * HTTP call so that if the process crashes while the first delivery is in flight,
   * `retryPending()` will pick up and deliver the webhook upon restart.
   *
   * @param {string} event E.g. 'SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED'
   * @param {any} session The payment session entity
   * @returns {Promise<{ delivered: boolean, deliveryId: string, status?: number, error?: string }>}
   */
  async dispatch(event, session) {
    const merchantId = session.merchantId || session.merchant_id;
    const merchant = this.merchantRepo.findById(merchantId);
    if (!merchant || !merchant.webhookUrl) {
      return { delivered: false, deliveryId: '', error: 'No webhook URL configured for merchant.' };
    }

    const publicOutcome = isDispatchableOutcome(event) ? toPublicOutcome(event) : event;
    const nowIso = new Date().toISOString();

    // One durable delivery per payment/event, including duplicate or replayed in-process
    // events. SQLite serializes the final create-or-read in the transaction below.
    const prior = this.db.queryOne(
      'SELECT id, is_successful, response_status, response_body FROM webhook_deliveries WHERE payment_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT 1',
      [session.id, publicOutcome]
    );
    if (prior) {
      return { delivered: Boolean(prior.is_successful), deliveryId: prior.id, status: prior.response_status, error: prior.is_successful ? undefined : prior.response_body };
    }

    // Terminal transitions already have a durable outbox entry. If configuration
    // is missing or unsafe, KEEP that entry instead of recording an irrecoverable
    // synthetic failure row; the operator can repair configuration and replay.
    const isOutboxed = Boolean(this.db.queryOne(
      'SELECT payment_id FROM payment_webhook_outbox WHERE payment_id = ? AND event_type = ?',
      [session.id, publicOutcome]
    ));

    // Direct non-outboxed dispatches still write an auditable failure record.
    if (!merchant.webhookSecret) {
      if (isOutboxed) {
        return { delivered: false, deliveryId: '', status: 500, error: 'Merchant webhookSecret is not configured.' };
      }
      const deliveryId = crypto.randomUUID();
      this.db.execute(`
        INSERT INTO webhook_deliveries (
          id, merchant_id, payment_id, event_type, payload, endpoint_url,
          response_status, response_body, attempt_count, is_successful, next_retry_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 500, 'Merchant webhookSecret is not configured.', 1, 0, NULL, ?)
      `, [
        deliveryId,
        merchant.id,
        session.id,
        publicOutcome,
        JSON.stringify({ error: 'Missing webhookSecret', paymentId: session.id, orderId: session.orderId || session.order_id }),
        merchant.webhookUrl,
        nowIso
      ]);
      return { delivered: false, deliveryId, status: 500, error: 'Merchant webhookSecret is not configured.' };
    }

    // 2. Re-validate at dispatch time (SSRF guard)
    const endpointCheck = validateOutboundWebhookUrl(merchant.webhookUrl);
    if (!endpointCheck.valid) {
      if (isOutboxed) {
        return { delivered: false, deliveryId: '', status: 400, error: `Webhook delivery blocked: ${endpointCheck.error}` };
      }
      const deliveryId = crypto.randomUUID();
      this.db.execute(`
        INSERT INTO webhook_deliveries (
          id, merchant_id, payment_id, event_type, payload, endpoint_url,
          response_status, response_body, attempt_count, is_successful, next_retry_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 400, ?, 1, 0, NULL, ?)
      `, [
        deliveryId,
        merchant.id,
        session.id,
        publicOutcome,
        JSON.stringify({ error: 'SSRF blocked', paymentId: session.id, orderId: session.orderId || session.order_id }),
        merchant.webhookUrl,
        `Webhook delivery blocked: ${endpointCheck.error}`,
        nowIso
      ]);
      return { delivered: false, deliveryId, status: 400, error: `Webhook delivery blocked: ${endpointCheck.error}` };
    }

    // 3. Persist pending delivery row BEFORE outbound HTTP request (crash-safe write-ahead record).
    // Check if an unsent row already exists for this payment + event (e.g., created by recovery backfill).
    const existingPending = this.db.queryOne(`
      SELECT id, payload FROM webhook_deliveries
      WHERE payment_id = ? AND event_type = ? AND is_successful = 0
      ORDER BY created_at DESC LIMIT 1
    `, [session.id, publicOutcome]);

    let deliveryId;
    let timestamp;
    let payloadString;
    const inFlightLeaseIso = new Date(Date.now() + 15000).toISOString();

    if (existingPending && existingPending.payload) {
      deliveryId = existingPending.id;
      payloadString = existingPending.payload;
      let parsedTs = null;
      try {
        const parsed = JSON.parse(payloadString);
        if (parsed && parsed.timestamp != null) parsedTs = String(parsed.timestamp);
        if (parsed && parsed.deliveryId) deliveryId = String(parsed.deliveryId);
      } catch {}
      timestamp = parsedTs || Date.now().toString();
      this.db.execute(`
        UPDATE webhook_deliveries
        SET next_retry_at = ?, endpoint_url = ?
        WHERE id = ?
      `, [inFlightLeaseIso, merchant.webhookUrl, existingPending.id]);
    } else {
      deliveryId = crypto.randomUUID();
      const timestampNum = Date.now();
      timestamp = timestampNum.toString();
      const payloadObj = this._buildPayload(publicOutcome, session, deliveryId, timestampNum);
      payloadString = JSON.stringify(payloadObj);

      this.db.execute(`
        INSERT INTO webhook_deliveries (
          id, merchant_id, payment_id, event_type, payload, endpoint_url,
          response_status, response_body, attempt_count, is_successful, next_retry_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?)
      `, [
        deliveryId,
        merchant.id,
        session.id,
        publicOutcome,
        payloadString,
        merchant.webhookUrl,
        inFlightLeaseIso,
        nowIso
      ]);
    }

    // Outbox cleanup commits together with durable delivery preparation.
    this.db.execute('DELETE FROM payment_webhook_outbox WHERE payment_id = ? AND event_type = ?', [session.id, publicOutcome]);

    const signature = generateHmac(payloadString, merchant.webhookSecret);
    const timestampedSignature = generateHmac(`${timestamp}.${payloadString}`, merchant.webhookSecret);

    const headers = {
      'Content-Type': 'application/json',
      'X-Gateway-Event': publicOutcome,
      'X-Gateway-Signature': `sha256=${signature}`,
      'X-Gateway-Signature-V2': `sha256=${timestampedSignature}`,
      'X-Gateway-Delivery-Id': deliveryId,
      'X-Gateway-Timestamp': timestamp
    };

    // Clear the outbox entry in the same operation that finalizes the write-ahead row,
    // so a crash cannot leave both an orphaned outbox entry and a delivery row.
    // NOTE: The write-ahead row itself was already INSERTed above (either reusing
    // existingPending.id or via the fresh `else` branch). Re-querying here would find
    // that row and skip the fetch — every first dispatch returned
    // { delivered: false, status: null, error: null } because of that re-query.
    if (isOutboxed) {
      this.db.execute('DELETE FROM payment_webhook_outbox WHERE payment_id = ? AND event_type = ?', [session.id, publicOutcome]);
    }

    let responseStatus = null;
    let responseBody = null;
    let isSuccessful = false;

    try {
      const res = await fetch(endpointCheck.url.toString(), {
        method: 'POST',
        headers,
        body: payloadString,
        // Never follow redirects: a public URL could otherwise 302 into internal network (SSRF)
        redirect: 'manual',
        signal: AbortSignal.timeout(10000) // 10s timeout
      });

      responseStatus = res.status;
      responseBody = (await res.text()).substring(0, 1000);
      isSuccessful = res.ok;
    } catch (err) {
      responseBody = err.message || 'Network timeout';
    }
    // 4. Finalize the delivery record in webhook_deliveries
    const nextRetryAt = isSuccessful
      ? null
      : new Date(Date.now() + 5000).toISOString();

    this.db.execute(`
      UPDATE webhook_deliveries
      SET response_status = ?,
          response_body = ?,
          attempt_count = MAX(1, attempt_count + 1),
          is_successful = ?,
          next_retry_at = ?
      WHERE id = ?
    `, [
      responseStatus,
      responseBody,
      isSuccessful ? 1 : 0,
      nextRetryAt,
      existingPending ? existingPending.id : deliveryId
    ]);

    return {
      delivered: isSuccessful,
      deliveryId,
      status: responseStatus,
      error: isSuccessful ? undefined : responseBody
    };
  }

  /**
   * Prepare and send terminal events committed before a crash but not yet turned
   * into delivery records. The trigger records only new terminal transitions;
   * historic SUCCESS rows are never swept into webhooks on upgrade.
   */
  async recoverOutbox() {
    const rows = this.db.query(`
      SELECT o.payment_id, o.event_type
      FROM payment_webhook_outbox o
      WHERE NOT EXISTS (
        SELECT 1 FROM webhook_deliveries d
        WHERE d.payment_id = o.payment_id AND d.event_type = o.event_type
      )
      ORDER BY o.created_at, o.payment_id LIMIT 20
    `);
    const outcomes = [];
    for (const row of rows) {
      const session = this.sessionRepo.findById(row.payment_id);
      if (!session) continue;
      const merchant = this.merchantRepo.findById(session.merchantId);
      // Keep unconfigured merchants' events in the outbox for human remediation.
      if (!merchant?.webhookUrl || !merchant.webhookSecret) continue;
      outcomes.push(await this.dispatch(row.event_type, session));
    }
    return outcomes;
  }

  /**
   * Recovers webhook deliveries that were interrupted mid-flight by a process crash
   * or terminal payment sessions that transitioned just before `dispatch()` could run.
   *
   * @param {{ resetInFlight?: boolean }} [options]
   * @returns {number} Number of recovered/backfilled webhook delivery rows
   */
  recoverMissingDeliveries(options = {}) {
    const { resetInFlight = false } = options;
    const nowIso = new Date().toISOString();
    let recoveredCount = 0;

    if (resetInFlight) {
      // Any row with attempt_count = 0 and response_status IS NULL was in-flight when the previous process died.
      // Reset its next_retry_at to now so retryPending() claims it immediately on boot.
      const res = this.db.execute(`
        UPDATE webhook_deliveries
        SET next_retry_at = ?
        WHERE is_successful = 0 AND attempt_count = 0 AND response_status IS NULL
      `, [nowIso]);
      recoveredCount += Number(res?.changes || 0);
    }

    // Find terminal payment sessions for merchants with configured webhooks that have NO webhook_deliveries row at all.
    const orphanedSessions = this.db.query(`
      SELECT ps.*
      FROM payment_sessions ps
      JOIN merchants m ON m.id = ps.merchant_id
      WHERE ps.status IN ('SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED')
        AND m.webhook_url IS NOT NULL AND m.webhook_url != ''
        AND m.webhook_secret IS NOT NULL AND m.webhook_secret != ''
        AND NOT EXISTS (
          SELECT 1 FROM webhook_deliveries wd WHERE wd.payment_id = ps.id
        )
      LIMIT 100
    `);

    for (const sessionRow of orphanedSessions) {
      const merchant = this.merchantRepo.findById(sessionRow.merchant_id);
      if (!merchant || !merchant.webhookUrl || !merchant.webhookSecret) continue;

      const endpointCheck = validateOutboundWebhookUrl(merchant.webhookUrl);
      if (!endpointCheck.valid) continue;

      const publicOutcome = isDispatchableOutcome(sessionRow.status)
        ? toPublicOutcome(sessionRow.status)
        : sessionRow.status;
      const deliveryId = crypto.randomUUID();
      const timestampNum = Date.now();
      const payloadObj = this._buildPayload(publicOutcome, sessionRow, deliveryId, timestampNum);
      const payloadString = JSON.stringify(payloadObj);

      this.db.execute(`
        INSERT INTO webhook_deliveries (
          id, merchant_id, payment_id, event_type, payload, endpoint_url,
          response_status, response_body, attempt_count, is_successful, next_retry_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?)
      `, [
        deliveryId,
        merchant.id,
        sessionRow.id,
        publicOutcome,
        payloadString,
        merchant.webhookUrl,
        nowIso,
        nowIso
      ]);
      recoveredCount++;
    }

    return recoveredCount;
  }

  /**
   * Retries overdue pending webhook deliveries with atomic claim & exponential backoff.
   * Backoff strategy: 5s, 30s, 2m, 10m, 1h
   */
  async retryPending() {
    // Ensure any terminal session whose dispatch() was skipped before creating a row is backfilled first.
    try {
      this.recoverMissingDeliveries({ resetInFlight: false });
    } catch {}

    const nowIso = new Date().toISOString();

    // Snapshot a bounded batch, but claim each delivery only immediately before sending.
    // Twenty sequential 10s requests can outlive a shared 60s lease, allowing another
    // sweep to reclaim waiting items and consume attempts without a network request.
    const candidates = this.db.query(`
      SELECT id FROM webhook_deliveries
      WHERE is_successful = 0 AND attempt_count < ? AND next_retry_at <= ?
      ORDER BY next_retry_at, id
      LIMIT 20
    `, [this.maxRetries, nowIso]);

    const results = [];
    const backoffs = [5000, 30000, 120000, 600000, 3600000];

    for (const candidate of candidates) {
      const item = this.db.transaction(() => {
        // Another worker may have claimed or completed this item since the snapshot.
        const pending = this.db.queryOne(`
          SELECT id, merchant_id, payment_id, event_type, payload, endpoint_url, attempt_count
          FROM webhook_deliveries
          WHERE id = ? AND is_successful = 0 AND attempt_count < ? AND next_retry_at <= ?
        `, [candidate.id, this.maxRetries, new Date().toISOString()]);
        if (!pending) return null;

        this.db.execute(`
          UPDATE webhook_deliveries
          SET next_retry_at = ?, attempt_count = attempt_count + 1
          WHERE id = ?
        `, [new Date(Date.now() + 60000).toISOString(), pending.id]);
        return pending;
      });
      if (!item) continue;
      const merchant = this.merchantRepo.findById(item.merchant_id);
      if (!merchant || !merchant.webhookSecret || !item.endpoint_url) {
        this.db.execute(`
          UPDATE webhook_deliveries
          SET is_successful = 0, next_retry_at = NULL, response_body = 'Missing merchant or webhookSecret'
          WHERE id = ?
        `, [item.id]);
        continue;
      }

      // Re-validate the stored endpoint before every retry (SSRF guard).
      const retryEndpoint = validateOutboundWebhookUrl(item.endpoint_url);
      if (!retryEndpoint.valid) {
        this.db.execute(`
          UPDATE webhook_deliveries
          SET is_successful = 0, next_retry_at = NULL, response_body = ?
          WHERE id = ?
        `, [`SSRF blocked: ${retryEndpoint.error}`, item.id]);
        continue;
      }

      // The retry resends the ORIGINAL body byte for byte, so the headers must describe
      // that same body. Recomputing a fresh timestamp here would make the header disagree
      // with the timestamp embedded in the payload, and the merchant's verification (which
      // cross-checks the two) would reject every retry.
      let storedTimestamp = null;
      let storedDeliveryId = item.id;
      try {
        const storedPayload = JSON.parse(item.payload);
        if (storedPayload && storedPayload.timestamp !== undefined && storedPayload.timestamp !== null) {
          storedTimestamp = String(storedPayload.timestamp);
        }
        if (storedPayload && storedPayload.deliveryId) {
          storedDeliveryId = String(storedPayload.deliveryId);
        }
      } catch {}

      const timestamp = storedTimestamp || Date.now().toString();
      const signature = generateHmac(item.payload, merchant.webhookSecret);
      const timestampedSignature = generateHmac(`${timestamp}.${item.payload}`, merchant.webhookSecret);

      let isSuccess = false;
      let respStatus = null;
      let respBody = null;

      try {
        const res = await fetch(retryEndpoint.url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Gateway-Event': item.event_type,
            'X-Gateway-Signature': `sha256=${signature}`,
            'X-Gateway-Signature-V2': `sha256=${timestampedSignature}`,
            'X-Gateway-Delivery-Id': storedDeliveryId,
            'X-Gateway-Timestamp': timestamp
          },
          body: item.payload,
          redirect: 'manual',
          signal: AbortSignal.timeout(10000)
        });
        respStatus = res.status;
        respBody = (await res.text()).substring(0, 1000);
        isSuccess = res.ok;
      } catch (err) {
        respBody = err.message;
      }

      const nextAttempt = item.attempt_count + 1; // item.attempt_count was already incremented during claim
      const nextRetryDelay = backoffs[Math.min(nextAttempt - 1, backoffs.length - 1)];
      const nextRetryAt = isSuccess || nextAttempt >= this.maxRetries
        ? null
        : new Date(Date.now() + nextRetryDelay).toISOString();

      this.db.execute(`
        UPDATE webhook_deliveries
        SET is_successful = ?, response_status = ?, response_body = ?, next_retry_at = ?
        WHERE id = ?
      `, [isSuccess ? 1 : 0, respStatus, respBody, nextRetryAt, item.id]);

      results.push({ id: item.id, success: isSuccess, attempt: nextAttempt });
    }

    return results;
  }
}
