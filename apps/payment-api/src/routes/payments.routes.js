import { HttpServer } from '../server.js';
import { toPaise, toRupeesString, resolveRuntimeUrls, PaymentStatus, PaymentMethod } from '@youpi/common';
import { isTerminalStatus, toPublicOutcome, settlementStateFor, verifyRegisteredDeviceCredentials } from '@youpi/core';
import { isAdminRequest, isPaymentOwner } from '../auth-guard.js';
import { checkUpiServerHealth, observerHealthEnforced, upiObserversAcceptingPayments } from './checkout.routes.js';

/**
 * Registers merchant-facing payment routes.
 * @param {HttpServer} server
 * @param {{
 *   merchantRepo: import('@youpi/db').MerchantRepository,
 *   accountRepo: import('@youpi/db').ReceivingAccountRepository,
 *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
 *   queueEngine: import('@youpi/core').QueueEngine,
 *   timingEngine: import('@youpi/core').TimingEngine,
 *   auditRepo: import('@youpi/db').AuditLogRepository,
 *   checkoutBaseUrl: string
 * }} ctx
 */
export function registerPaymentRoutes(server, ctx) {
  function resolvePublicDeploymentOrigin() {
    const configured = process.env.CHECKOUT_PUBLIC_URL || process.env.PUBLIC_APP_URL;
    if (configured) return configured.replace(/\/+$/, '');
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    return null;
  }

  function resolveCheckoutBaseUrl(merchant) {
    // Service bindings are private and must never be returned to a browser.
    // On Vercel, build checkout links from the public deployment origin instead.
    const publicOrigin = resolvePublicDeploymentOrigin();
    if (publicOrigin) return publicOrigin;
    if (merchant?.branding) {
      try {
        const urls = resolveRuntimeUrls(merchant.branding);
        if (urls && urls.checkoutUrl) return urls.checkoutUrl;
      } catch {}
    }
    return ctx.checkoutBaseUrl || resolvePublicDeploymentOrigin() || 'http://localhost:7000';
  }

  // POST /api/v1/payments
  server.post('/api/v1/payments', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;

    // Resolve merchant (default to first/demo merchant if none passed in header)
    const rawMerchantId = (req.headers['x-merchant-id'] || body.merchantId || '').toString().trim();
    const docPlaceholders = new Set([
      'YOUR_MERCHANT_KEY',
      'YOUR_MERCHANT_PUBLIC_KEY',
      'YOUR_PUBLIC_KEY',
      'MERCHANT_PUBLIC_KEY',
      'YOUR_MERCHANT_ID'
    ]);
    let merchant = null;
    if (rawMerchantId && !docPlaceholders.has(rawMerchantId.toUpperCase())) {
      merchant = ctx.merchantRepo.findById(rawMerchantId);
      if (!merchant && typeof ctx.merchantRepo.findBySlug === 'function') {
        merchant = ctx.merchantRepo.findBySlug(rawMerchantId);
      }
    } else {
      HttpServer.json(res, 400, { error: 'X-Merchant-Id is required.' });
      return;
    }

    if (!merchant) {
      HttpServer.json(res, 400, { error: 'Merchant not found or not configured.' });
      return;
    }

    const presentedMerchantKey = req.headers['x-merchant-key'] !== undefined
      ? req.headers['x-merchant-key']
      : undefined;
    if (presentedMerchantKey !== undefined && presentedMerchantKey !== null) {
      const keyValid = typeof ctx.merchantRepo.verifyApiKey === 'function'
        && ctx.merchantRepo.verifyApiKey(merchant, String(presentedMerchantKey));
      if (!keyValid) {
        HttpServer.json(res, 401, { error: 'Invalid merchant key', code: 'INVALID_MERCHANT_KEY' });
        return;
      }
    } else if (!isAdminRequest(req)) {
      HttpServer.json(res, 401, {
        error: 'A server-side merchant API key is required.',
        code: 'MISSING_MERCHANT_KEY'
      });
      return;
    }

    if (!body.orderId || !body.amount) {
      HttpServer.json(res, 400, { error: 'Missing required fields: orderId and amount.' });
      return;
    }

    let amountPaise;
    try {
      amountPaise = toPaise(body.amount);
    } catch (err) {
      HttpServer.json(res, 400, { error: err.message });
      return;
    }
    const requestedCurrency = (body.currency || 'INR').toUpperCase();

    const isExplicitTestAutoActivate = body.autoActivate === true || body.autoActivate === 'true';
    if (isExplicitTestAutoActivate) {
      const autoActivateAllowed =
        process.env.NODE_ENV === 'test' ||
        process.env.ALLOW_TEST_AUTOACTIVATE === 'true' ||
        isAdminRequest(req);
      if (!autoActivateAllowed) {
        HttpServer.json(res, 403, {
          error: 'autoActivate is restricted to admin or test environments.',
          code: 'AUTOACTIVATE_FORBIDDEN'
        });
        return;
      }
    }

    // returnUrl is echoed back to the customer's browser as a redirect target after
    // payment, so only absolute http(s) URLs are ever stored. This is the write-side
    // complement to the checkout page's sanitizeRedirectUrl.
    if (body.returnUrl !== undefined && body.returnUrl !== null && body.returnUrl !== '') {
      if (typeof body.returnUrl !== 'string') {
        HttpServer.json(res, 400, { error: 'returnUrl must be a string.' });
        return;
      }
      let parsedReturnUrl;
      try {
        parsedReturnUrl = new URL(body.returnUrl.trim());
      } catch {
        HttpServer.json(res, 400, { error: 'returnUrl must be an absolute http(s) URL.' });
        return;
      }
      if ((parsedReturnUrl.protocol !== 'http:' && parsedReturnUrl.protocol !== 'https:')
        || parsedReturnUrl.username || parsedReturnUrl.password) {
        HttpServer.json(res, 400, { error: 'returnUrl must use the http or https scheme.' });
        return;
      }
      const allowedReturnOrigins = String(process.env.YOUPI_ALLOWED_RETURN_ORIGINS || '')
        .split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
      if (!allowedReturnOrigins.includes(parsedReturnUrl.origin)) {
        HttpServer.json(res, 400, { error: 'returnUrl origin is not allowlisted for this gateway.' });
        return;
      }
      body.returnUrl = parsedReturnUrl.href;
    }

    const deviceId = body.deviceId || req.headers['x-device-id'] || null;
    const deviceToken = body.deviceToken || req.headers['x-device-token'] || null;
    const deviceSignature = body.deviceSignature || req.headers['x-device-signature'] || null;
    const signaturePayload = body.signaturePayload || req.headers['x-device-payload'] || null;

    if (deviceId) {
      const credCheck = verifyRegisteredDeviceCredentials({
        deviceId,
        deviceToken,
        deviceSignature,
        signaturePayload,
        deviceRepo: ctx.deviceRepo
      });
      if (!credCheck.valid) {
        HttpServer.json(res, 401, {
          error: credCheck.error || 'DEVICE_CREDENTIALS_INVALID',
          message: credCheck.message || 'A registered device and valid device credential are required.'
        });
        return;
      }
    }

    // Check idempotency & active session state
    const requestedMethod = body.method || PaymentMethod.UPI;
    if (![PaymentMethod.UPI, PaymentMethod.MANUAL_UPI, PaymentMethod.COD, PaymentMethod.CASH_COUNTER, PaymentMethod.CARD_COUNTER].includes(requestedMethod)) {
      HttpServer.json(res, 400, { error: 'Unsupported payment method.' });
      return;
    }
    const existing = ctx.sessionRepo.findByOrderId(merchant.id, body.orderId);
    if (existing) {
      if (existing.method !== requestedMethod) {
        HttpServer.json(res, 409, { error: 'ORDER_PAYMENT_METHOD_MISMATCH', code: 'ORDER_PAYMENT_METHOD_MISMATCH' });
        return;
      }
      const existingCurrency = (existing.currency || 'INR').toUpperCase();
      if (existing.amountPaise !== amountPaise || existingCurrency !== requestedCurrency) {
        HttpServer.json(res, 409, {
          error: 'ORDER_AMOUNT_MISMATCH',
          code: 'ORDER_AMOUNT_MISMATCH',
          message: `Order ${body.orderId} already exists with a different amount or currency.`
        });
        return;
      }

      // If SUCCESS: order is already paid, return existing completed session
      if (existing.status === PaymentStatus.SUCCESS
        || existing.status === PaymentStatus.OBSERVED_SUCCESS
        || existing.status === PaymentStatus.RECONCILED
        || existing.status === PaymentStatus.MANUAL_REVIEW) {
        HttpServer.json(res, 200, {
          paymentId: existing.id,
          orderId: existing.orderId,
          amount: toRupeesString(existing.amountPaise),
          amountPaise: existing.amountPaise.toString(),
          currency: existing.currency,
          status: existing.status,
          checkoutUrl: `${resolveCheckoutBaseUrl(merchant)}/checkout/${existing.id}`
        });
        return;
      }

      // Check if existing session is stale
      const now = Date.now();
      const isStale = (existing.status === PaymentStatus.ACTIVE && existing.expiresAt && existing.expiresAt.getTime() <= now) ||
        (existing.status === PaymentStatus.PROCESSING && existing.processingExpiresAt && existing.processingExpiresAt.getTime() <= now);
      if (isStale) {
        const terminalStatus = existing.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
        ctx.sessionRepo.transitionToTerminal(existing.id, terminalStatus);
        if (existing.receivingAccountId) {
          ctx.queueEngine.promoteNext(existing.receivingAccountId);
        }
        existing.status = terminalStatus;
        if (ctx.eventEmitter) {
          ctx.eventEmitter.emit(`PAYMENT.${terminalStatus}`, {
            paymentId: existing.id,
            orderId: existing.orderId,
            merchantId: existing.merchantId,
            amountPaise: existing.amountPaise
          });
        }
      }

      // If existing is non-terminal (ACTIVE, PROCESSING, QUEUED, INITIATED):
      if ([PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED, PaymentStatus.INITIATED].includes(existing.status)) {
        // CASE 3: Active session bound to a device + missing or different device -> DUPLICATE_SESSION_DETECTED
        if (existing.deviceId && (!deviceId || deviceId !== existing.deviceId)) {
          HttpServer.json(res, 409, {
            error: 'DUPLICATE_SESSION_DETECTED',
            code: 'DEVICE_SESSION_MISMATCH',
            session_id: existing.id,
            activeSession: {
              paymentId: existing.id,
              orderId: existing.orderId,
              amount: toRupeesString(existing.amountPaise)
            },
            action: 'END_SESSION_AND_CREATE_NEW',
            message: 'This payment session was created on another device. For security reasons, this session cannot be continued from this device.'
          });
          return;
        }

        // CASE 2: Active session + Same device -> CONTINUE ACTIVE SESSION
        HttpServer.json(res, 200, {
          paymentId: existing.id,
          orderId: existing.orderId,
          amount: toRupeesString(existing.amountPaise),
          amountPaise: existing.amountPaise.toString(),
          currency: existing.currency,
          status: existing.status,
          activeSessionDetected: true,
          checkoutUrl: `${resolveCheckoutBaseUrl(merchant)}/checkout/${existing.id}`
        });
        return;
      }

      // CASE 4: Previous session is TERMINAL (FAILED, EXPIRED, CANCELLED) -> RETRY / NEW ATTEMPT!
      // Invariant: Keep merchant's exact orderId untouched so webhooks, reconciliations, and reporting align.
      body.orderId = body.orderId.replace(/-R\d+$/, '');
    }

    const isCounterPayment = requestedMethod === PaymentMethod.CASH_COUNTER || requestedMethod === PaymentMethod.CARD_COUNTER;
    const isCod = requestedMethod === PaymentMethod.COD;
    const isManualUpi = requestedMethod === PaymentMethod.MANUAL_UPI;
    if (!isCounterPayment && !isCod && !isManualUpi && observerHealthEnforced()) {
      const health = await checkUpiServerHealth(ctx, [], 'ONLINE', merchant.id);
      if (!upiObserversAcceptingPayments(health)) {
        HttpServer.json(res, 503, {
          error: 'UPI observers are offline. New payments are not accepted until the SMS observer heartbeat is fresh.',
          code: 'OBSERVERS_UNHEALTHY',
          smsHealthy: Boolean(health.smsHealthy),
          gmailHealthy: Boolean(health.gmailHealthy),
          retryAfterSeconds: 60,
          recovery: 'Pair or reconnect the Android or Google Messages observer. A heartbeat within 5 minutes allows new UPI sessions. In-flight sessions are left to their existing timers.'
        });
        return;
      }
    }

    let receivingAccountId = null;
    let receivingAccountSnapshot = null;
    if (!isCounterPayment) {
      // Resolve active receiving account for UPI
      const receivingAccount = ctx.accountRepo.findActiveForMerchant(merchant.id);
      if (!receivingAccount) {
        HttpServer.json(res, 500, { error: 'No active UPI receiving account configured for merchant.' });
        return;
      }
      receivingAccountId = receivingAccount.id;
      receivingAccountSnapshot = {
        id: receivingAccount.id,
        upiId: receivingAccount.upiId,
        payeeName: receivingAccount.payeeName,
        isMerchantEnabled: receivingAccount.isMerchantEnabled
      };
    }

    // Resolve customer if provided (optional pre-existing customer)
    let customerId = body.customerId || null;
    if (!customerId && (body.customer?.mobileNumber || body.customer?.phoneNumber || body.customer?.email) && ctx.customerRepo) {
      const ident = body.customer.email || body.customer.mobileNumber || body.customer.phoneNumber;
      const existingCust = ctx.customerRepo.findByIdentifier(ident);
      if (existingCust) {
        customerId = existingCust.id;
      }
    }

    // Server-side Ban Enforcement (Section 3)
    if (customerId && ctx.customerRepo && ctx.customerRepo.isBanned(customerId)) {
      HttpServer.json(res, 403, {
        status: 'BLOCKED',
        error: 'ACCESS BLOCKED: Your account has been temporarily blocked because suspicious payment activity was detected. Our team will review the activity before access can be restored.',
        message: 'Your account has been temporarily blocked because suspicious payment activity was detected. Our team will review the activity before access can be restored.',
        isBanned: true
      });
      return;
    }

    // Check if customer already has an active payment session on another device (CASE 3)
    if (customerId && ctx.sessionRepo) {
      const activeForCust = ctx.sessionRepo.findActiveForCustomer ? ctx.sessionRepo.findActiveForCustomer(customerId) : null;
      if (activeForCust) {
        if (activeForCust.deviceId && (!deviceId || deviceId !== activeForCust.deviceId)) {
          HttpServer.json(res, 409, {
            error: 'DUPLICATE_SESSION_DETECTED',
            code: 'DEVICE_SESSION_MISMATCH',
            session_id: activeForCust.id,
            activeSession: {
              paymentId: activeForCust.id,
              orderId: activeForCust.orderId,
              amount: toRupeesString(activeForCust.amountPaise)
            },
            action: 'END_SESSION_AND_CREATE_NEW',
            message: 'This customer already has an active payment session on another device. For security reasons, this session cannot be continued from this device.'
          });
          return;
        }
      }
    }

    // Invariant: Do NOT start payment session timer until customer is authenticated/logged in!
    // Customer sign in or sign up in the checkout portal is mandatory before slot activation or timer start.
    // Digital UPI payments MUST ALWAYS start in status INITIATED without acquiring a concurrency slot or timer.
    // Only physical counter payments (CASH_COUNTER, CARD_COUNTER) start as ACTIVE (they do not use UPI slots).
    // The only exception for UPI auto-activation is explicit developer test suite flag: body.autoActivate === true.
    const shouldActivateNow = isCounterPayment || isExplicitTestAutoActivate;
    const initialStatus = isCounterPayment ? PaymentStatus.ACTIVE : PaymentStatus.INITIATED;

    const sessionMetadata = {
      ...(body.metadata || {}),
      ...(receivingAccountSnapshot ? { receivingAccountSnapshot } : {})
    };

    if (deviceId && customerId && ctx.deviceRepo) {
      try { ctx.deviceRepo.associateCustomer(deviceId, customerId); } catch {}
    }

    // Create session in DB
    const session = ctx.sessionRepo.create({
      merchantId: merchant.id,
      customerId,
      receivingAccountId,
      orderId: body.orderId,
      amountPaise,
      currency: body.currency || 'INR',
      method: requestedMethod,
      status: initialStatus,
      returnUrl: body.returnUrl || null,
      idempotencyKey: idempotencyKey || null,
      deviceId,
      metadata: sessionMetadata
    });

    // Enqueue or Activate slot via QueueEngine ONLY when counter payment or explicitly requested by automated test runner
    let queueResult = { status: initialStatus, queuePosition: 0, expiresAt: null };
    if (!isCounterPayment && receivingAccountId && shouldActivateNow) {
      const activeDurationMs = ctx.timingEngine ? ctx.timingEngine.activeDurationMs : 300000;
      queueResult = ctx.queueEngine.enqueueOrActivate(session.id, receivingAccountId, activeDurationMs);

      // If activated immediately, start Timer 1 (5 minutes)
      if (queueResult.expiresAt) {
        ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
      }
      server.broadcastSse('admin_counter_events', 'status_change', {
        status: queueResult.status,
        sessionId: session.id,
        orderId: session.orderId,
        amountPaise: session.amountPaise ? session.amountPaise.toString() : '0'
      });
    }

    HttpServer.json(res, 201, {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(amountPaise),
      amountPaise: amountPaise.toString(),
      currency: session.currency,
      status: queueResult.status,
      queuePosition: queueResult.queuePosition,
      checkoutUrl: `${resolveCheckoutBaseUrl(merchant)}/checkout/${session.id}`
    });
  });

  // GET /api/v1/payments/:id
  server.get('/api/v1/payments/:id', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const publicStatus = isTerminalStatus(session.status)
      ? toPublicOutcome(session.status)
      : session.status;

    // Fields any payment-id holder may read. Everything else is merchant-private: the raw
    // state machine status, verification internals, merchant metadata and the return URL.
    const publicView = {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      status: publicStatus,
      settlementState: settlementStateFor(publicStatus),
      method: session.method,
      completedAt: session.completedAt ? session.completedAt.toISOString() : null
    };

    if (!isPaymentOwner(req, session, ctx)) {
      HttpServer.json(res, 200, publicView);
      return;
    }

    HttpServer.json(res, 200, {
      ...publicView,
      internalStatus: session.status,
      verificationLevel: session.verificationLevel || 0,
      verificationSources: session.verificationSources || [],
      verificationTag: session.verificationTag || 'UNVERIFIED',
      returnUrl: session.returnUrl,
      metadata: session.metadata
    });
  });

  // GET /api/v1/payments/:id/cod (Developer COD Info Endpoint)
  server.get('/api/v1/payments/:id/cod', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    // Order ids are merchant-chosen and often sequential, so the delivery contact and metadata
    // are only for the owning merchant (or the gateway); anyone else gets the order status.
    const owner = isPaymentOwner(req, session, ctx);
    let customer = null;
    if (owner && session.customerId && ctx.customerRepo) {
      const c = ctx.customerRepo.findById(session.customerId);
      if (c) {
        const isOwner = isPaymentOwner(req, session, ctx);
        customer = {
          id: c.id,
          name: c.name,
          email: isOwner ? c.email : (c.email ? `${c.email.slice(0, 2)}***@${c.email.split('@')[1] || '***'}` : null),
          mobileNumber: isOwner ? c.mobileNumber : (c.mobileNumber ? `${c.mobileNumber.slice(0, 2)}******${c.mobileNumber.slice(-2)}` : null)
        };
      }
    }

    HttpServer.json(res, 200, {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      method: session.method,
      status: session.status,
      verificationTag: session.verificationTag,
      isCod: session.method === 'COD',
      customer: owner ? customer : null,
      placedAt: session.completedAt ? (session.completedAt.toISOString ? session.completedAt.toISOString() : session.completedAt) : (session.createdAt?.toISOString ? session.createdAt.toISOString() : session.createdAt),
      ...(owner ? { metadata: session.metadata } : {})
    });
  });

  // GET /api/v1/orders/:orderId/cod (Developer COD Info by Merchant Order ID)
  server.get('/api/v1/orders/:orderId/cod', async (req, res, params) => {
    const merchantId = req.headers['x-merchant-id'] || req.query.merchantId;
    let merchant;
    if (merchantId) {
      merchant = ctx.merchantRepo.findById(merchantId);
    } else {
      merchant = ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
    }

    if (!merchant) {
      HttpServer.json(res, 404, { error: 'Merchant not found.' });
      return;
    }

    const session = ctx.sessionRepo.findByOrderId(merchant.id, params.orderId);
    if (!session) {
      HttpServer.json(res, 404, { error: `Order not found: ${params.orderId}` });
      return;
    }

    // Order ids are merchant-chosen and often sequential, so the delivery contact and metadata
    // are only for the owning merchant (or the gateway); anyone else gets the order status.
    const owner = isPaymentOwner(req, session, ctx);
    let customer = null;
    if (owner && session.customerId && ctx.customerRepo) {
      const c = ctx.customerRepo.findById(session.customerId);
      if (c) {
        const isOwner = isPaymentOwner(req, session, ctx);
        customer = {
          id: c.id,
          name: c.name,
          email: isOwner ? c.email : (c.email ? `${c.email.slice(0, 2)}***@${c.email.split('@')[1] || '***'}` : null),
          mobileNumber: isOwner ? c.mobileNumber : (c.mobileNumber ? `${c.mobileNumber.slice(0, 2)}******${c.mobileNumber.slice(-2)}` : null)
        };
      }
    }

    HttpServer.json(res, 200, {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      method: session.method,
      status: session.status,
      verificationTag: session.verificationTag,
      isCod: session.method === 'COD',
      customer: owner ? customer : null,
      placedAt: session.completedAt ? (session.completedAt.toISOString ? session.completedAt.toISOString() : session.completedAt) : (session.createdAt?.toISOString ? session.createdAt.toISOString() : session.createdAt),
      ...(owner ? { metadata: session.metadata } : {})
    });
  });
}
