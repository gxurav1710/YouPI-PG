import { HttpServer } from '../server.js';
import { toRupeesString, buildUpiUri, PaymentStatus, PaymentMethod, UPI_PROVIDERS, isInternalServiceRequest, isValidTransition, getObserverToken } from '@youpi/common';
import { validateSessionDeviceAccess, verifyRegisteredDeviceCredentials } from '@youpi/core';
import { isAdminRequest, isPaymentOwner } from '../auth-guard.js';

const CLOSED_CHECKOUT_STATES = [
  PaymentStatus.SUCCESS,
  PaymentStatus.OBSERVED_SUCCESS,
  PaymentStatus.RECONCILED,
  PaymentStatus.MANUAL_REVIEW,
  PaymentStatus.FAILED,
  PaymentStatus.EXPIRED,
  PaymentStatus.CANCELLED
];

/**
 * Validates device access to an active payment session.
 * Enforces:
 * 1. If session has no device binding yet, binds to requesting device only if it is registered and presents valid credentials.
 * 2. If session is bound to Device A, any request omitting Device A's credentials or presenting Device B receives DUPLICATE_SESSION_DETECTED (HTTP 409).
 */
function checkSessionDeviceAccess(session, req, body = null, ctx = null) {
  // If session is already in a terminal state, allow access so terminal status can be rendered
  if (CLOSED_CHECKOUT_STATES.includes(session.status)) {
    return { allowed: true, boundDeviceId: session.deviceId, isTerminal: true };
  }

  // Only a co-located service on loopback holding the shared internal token (or an admin) may bypass device blocking.
  // The `X-Internal-Render` flag on its own is attacker-controlled and proves nothing.
  if (isInternalServiceRequest(req) || isAdminRequest(req)) {
    return { allowed: true, boundDeviceId: session.deviceId };
  }

  const requestingDeviceId = req.headers['x-device-id'] ||
    body?.deviceId ||
    (req.query && req.query.deviceId) ||
    null;
  const deviceToken = req.headers['x-device-token'] ||
    body?.deviceToken ||
    (req.query && req.query.deviceToken) ||
    null;
  const deviceSignature = req.headers['x-device-signature'] ||
    body?.deviceSignature ||
    null;
  const signaturePayload = req.headers['x-device-payload'] ||
    body?.signaturePayload ||
    null;

  // If session does not have a device binding yet:
  if (!session.deviceId) {
    if (requestingDeviceId) {
      const credCheck = verifyRegisteredDeviceCredentials({
        deviceId: requestingDeviceId,
        deviceToken,
        deviceSignature,
        signaturePayload,
        deviceRepo: ctx?.deviceRepo
      });
      if (!credCheck.valid) {
        return {
          allowed: false,
          statusCode: 409,
          body: {
            error: credCheck.error === 'DEVICE_SIGNATURE_INVALID' ? 'DEVICE_SIGNATURE_INVALID' : 'DUPLICATE_SESSION_DETECTED',
            code: credCheck.error,
            session_id: session.id,
            conflicting_session_id: session.id,
            action: 'END_SESSION_AND_CREATE_NEW',
            message: credCheck.message || 'Unregistered or unverified device identity.',
            boundDeviceId: null,
            requestingDeviceId
          }
        };
      }
      if (ctx?.deviceRepo) {
        ctx.deviceRepo.touch(requestingDeviceId);
      }
      if (ctx?.sessionRepo) {
        try {
          ctx.sessionRepo.bindDevice(session.id, requestingDeviceId);
          session.deviceId = requestingDeviceId;
        } catch (err) {
          console.warn('[checkSessionDeviceAccess] bindDevice error:', err.message);
        }
      }
    }
    return { allowed: true, boundDeviceId: session.deviceId };
  }

  // Session HAS a bound device:
  // Require matching deviceId AND valid cryptographic credential (token or signature).
  const validation = validateSessionDeviceAccess({
    session,
    requestingDeviceId,
    deviceToken,
    deviceSignature,
    signaturePayload,
    deviceRepo: ctx?.deviceRepo
  });

  if (!validation.allowed) {
    return {
      allowed: false,
      statusCode: 409,
      body: {
        ...validation,
        conflicting_session_id: session.id
      }
    };
  }

  if (ctx?.deviceRepo) {
    ctx.deviceRepo.touch(session.deviceId);
  }
  return { allowed: true, boundDeviceId: session.deviceId };
}

/**
 * Allowlist-based sanitizer for customer-facing branding (Issue #23).
 * Prevents internal credentials (gmailConfig, cloudflareTunnelCommand, tokens) from leaking to public checkouts.
 */
function sanitizePublicBranding(raw = {}) {
  const envAppName = (process.env.DEFAULT_APP_NAME || '').trim();
  const envPrimaryColor = (process.env.DEFAULT_PRIMARY_COLOR || '').trim();
  const defaultAppName = envAppName || 'YOUPI PG';
  const defaultPrimaryColor = envPrimaryColor || '#2563eb';

  // Strict explicit allowlist to prevent arbitrary internal metadata leaks (CWE-200 / OWASP A01)
  return {
    appName: raw.appName || defaultAppName,
    primaryColor: raw.primaryColor || defaultPrimaryColor,
    headerTheme: raw.headerTheme || 'gradient',
    logoUrl: raw.logoUrl !== undefined ? raw.logoUrl : ((process.env.DEFAULT_LOGO_URL || '').trim() || null),
    counterInstructions: raw.counterInstructions || 'Please visit the billing counter and present this screen to the cashier.',
    cardCounterInstructions: raw.cardCounterInstructions || 'Please swipe, insert, or tap your credit or debit card on the store POS terminal at the billing desk.',
    supportEmails: Array.isArray(raw.supportEmails) ? raw.supportEmails : [],
    supportMobiles: Array.isArray(raw.supportMobiles) ? raw.supportMobiles : [],
    privacyPolicyUrl: raw.privacyPolicyUrl || null,
    termsUrl: raw.termsUrl || null,
    sellingMode: raw.sellingMode || 'ONLINE',
    customCss: raw.customCss || null,
    enabledPaymentMethods: Array.isArray(raw.enabledPaymentMethods) ? raw.enabledPaymentMethods : ['UPI'],
    sidebarNotice: raw.sidebarNotice || undefined,
    checkoutNotice: raw.checkoutNotice || undefined,
    footerGuarantee: raw.footerGuarantee || (process.env.DEFAULT_FOOTER_GUARANTEE || '').trim() || undefined,
    trustBadgeText: raw.trustBadgeText || (process.env.DEFAULT_TRUST_BADGE_TEXT || '').trim() || undefined,
    hideTrustBadge: raw.hideTrustBadge !== undefined ? Boolean(raw.hideTrustBadge) : undefined,
    subbannerText: raw.subbannerText || undefined,
    hideSubbanner: raw.hideSubbanner !== undefined ? Boolean(raw.hideSubbanner) : undefined,
    hidePoweredBy: raw.hidePoweredBy !== undefined ? Boolean(raw.hidePoweredBy) : (process.env.DEFAULT_HIDE_POWERED_BY === 'true' ? true : undefined),
    hideTimeSavingBanner: raw.hideTimeSavingBanner !== undefined ? Boolean(raw.hideTimeSavingBanner) : undefined
  };
}

/**
 * Registers customer checkout portal routes.
 * @param {HttpServer} server
 * @param {{
 *   merchantRepo: import('@youpi/db').MerchantRepository,
 *   accountRepo: import('@youpi/db').ReceivingAccountRepository,
 *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
 *   queueEngine: import('@youpi/core').QueueEngine,
 *   timingEngine: import('@youpi/core').TimingEngine
 * }} ctx
 */
/**
 * New UPI sessions require a live SMS observer (Android heartbeat within 5 minutes,
 * or Google Messages connected). Gmail alone is supporting evidence and is not enough.
 * The gate is always on outside tests. Tests opt in with YOUPI_ENFORCE_OBSERVER_HEALTH=true.
 * Recovery: the next create succeeds once a heartbeat is fresh. In-flight sessions are not cancelled.
 */
export function observerHealthEnforced() {
  if (process.env.YOUPI_ENFORCE_OBSERVER_HEALTH === 'true') return true;
  if (process.env.NODE_ENV === 'test') return false;
  return true;
}

export function upiObserversAcceptingPayments(health) {
  return health?.smsHealthy === true && health?.isFalseNarrative !== true;
}

/**
 * Healthy (WORKING) only when both Gmail and an SMS observer are up.
 * New UPI payments additionally require smsHealthy. Gmail alone does not accept new sessions.
 */
export async function checkUpiServerHealth(ctx, enabledMethods = [], sellingMode = 'OFFLINE', merchantId = '00000000-0000-0000-0000-000000000001') {
  // 0. Check False Narrative Dev Switch (Active for 10 minutes from enabling time)
  const productionLock = process.env.NODE_ENV === 'production' || process.env.YOUPI_MODE === 'production';
  try {
    const merchant = ctx.merchantRepo?.findById ? ctx.merchantRepo.findById(merchantId) : null;
    const falseNarrativeUntil = merchant?.branding?.falseNarrativeUntil;
    const falseNarrativeMode = (merchant?.branding?.falseNarrativeMode || 'GREEN').toUpperCase();
    if (!productionLock && falseNarrativeUntil && Number(falseNarrativeUntil) > Date.now()) {
      const remainingSeconds = Math.max(0, Math.round((Number(falseNarrativeUntil) - Date.now()) / 1000));
      if (falseNarrativeMode === 'GREEN') {
        return {
          status: 'WORKING',
          tier: 'GREEN',
          label: 'Server Is Working',
          isWorking: true,
          reason: 'False Narrative Active (Dev Override: GREEN): UPI servers interpreted as operational',
          smsHealthy: true,
          gmailHealthy: true,
          warning: null,
          recommendedAlternative: null,
          isFalseNarrative: true,
          narrative: 'GREEN',
          falseNarrativeRemainingSeconds: remainingSeconds
        };
      } else if (falseNarrativeMode === 'YELLOW') {
        return {
          status: 'BUSY',
          tier: 'YELLOW',
          label: 'UPI Server Busy',
          isWorking: true,
          reason: 'False Narrative Active (Dev Override: YELLOW): UPI servers experiencing processing delays',
          smsHealthy: true,
          gmailHealthy: false,
          warning: 'Your payment may go through extra processing seconds.',
          recommendedAlternative: null,
          isFalseNarrative: true,
          narrative: 'YELLOW',
          falseNarrativeRemainingSeconds: remainingSeconds
        };
      } else if (falseNarrativeMode === 'RED') {
        return {
          status: 'ISSUES',
          tier: 'RED',
          label: 'Server Facing Issues',
          isWorking: false,
          reason: 'False Narrative Active (Dev Override: RED): UPI servers facing downtime',
          smsHealthy: false,
          gmailHealthy: false,
          warning: 'It is not recommended to pay by UPI right now as the server is facing downtime.',
          recommendedAlternative: null,
          isFalseNarrative: true,
          narrative: 'RED',
          falseNarrativeRemainingSeconds: remainingSeconds
        };
      }
    }
  } catch (err) {}

  let smsHealthy = false;
  let gmailHealthy = false;
  let smsReason = 'SMS gateway disconnected';
  let gmailReason = 'Gmail OAuth unconfigured';

  // 1. Check SMS Gateway (Android app or Google Messages)
  try {
    if (ctx.db) {
      const activeAndroid = ctx.db.queryOne(`
        SELECT id, device_name, last_heartbeat_at
        FROM android_devices
        WHERE is_active = 1 AND last_heartbeat_at >= datetime('now', '-5 minutes')
        LIMIT 1
      `);
      if (activeAndroid) {
        smsHealthy = true;
        smsReason = `Android SMS Gateway Active (${activeAndroid.device_name || 'Enrolled Device'})`;
      }
    }
  } catch (err) {}

  if (!smsHealthy) {
    try {
      const smsBaseUrl = process.env.SMS_OBSERVER_URL || `http://127.0.0.1:${process.env.SMS_OBSERVER_PORT || 6002}`;
      const res = await fetch(new URL('/api/browser/status', smsBaseUrl), {
          headers: { 'Authorization': `Bearer ${getObserverToken()}` },
          signal: AbortSignal.timeout(800)
        });
      if (res.ok) {
        const data = await res.json();
        const isRecent = data.lastSeenAt && (Date.now() - new Date(data.lastSeenAt).getTime() < 300000);
        if (data.isPaired === true && data.status === 'CONNECTED' && data.mode === 'BACKGROUND' && (data.isPolling === true || isRecent)) {
          smsHealthy = true;
          smsReason = 'Google Messages SMS Gateway active & paired';
        }
      }
    } catch (err) {}
  }

  // 2. Check Gmail OAuth Configuration & Active Poller
  try {
    const merchant = ctx.merchantRepo?.findById ? ctx.merchantRepo.findById(merchantId) : null;
    const gmailConfig = merchant?.branding?.gmailConfig || {};
    const hasRefreshToken = Boolean(gmailConfig.refreshToken && gmailConfig.refreshToken.trim());
    const hasApiKey = Boolean(gmailConfig.apiKey && gmailConfig.apiKey.trim());

    if (hasRefreshToken || hasApiKey) {
      let pollerActive = false;
      const gmailBaseUrl = process.env.GMAIL_OBSERVER_URL || `http://127.0.0.1:${process.env.GMAIL_OBSERVER_PORT || 6003}`;

      try {
        const res = await fetch(new URL('/health', gmailBaseUrl), { signal: AbortSignal.timeout(800) });
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'UP') {
            pollerActive = true;
          }
        }
      } catch (e) {}

      if (!pollerActive) {
        try {
          const res = await fetch(new URL('/api/browser/status', gmailBaseUrl), {
          headers: { 'Authorization': `Bearer ${getObserverToken()}` },
          signal: AbortSignal.timeout(800)
        });
          if (res.ok) {
            const data = await res.json();
            if (data.isLoggedIn || data.status === 'CONNECTED' || data.isPolling) {
              pollerActive = true;
            }
          }
        } catch (e) {}
      }

      if (!pollerActive) {
        try {
          const res = await fetch(`http://127.0.0.1:6099/health`, { signal: AbortSignal.timeout(800) });
          if (res.ok) {
            const data = await res.json();
            if (data.status === 'UP' && (data.isPolling || data.pollerActive !== false)) {
              pollerActive = true;
            }
          }
        } catch (e) {}
      }

      if (pollerActive || hasRefreshToken) {
        gmailHealthy = true;
        gmailReason = 'Gmail OAuth connected and actively polling';
      } else {
        gmailReason = 'Gmail OAuth configured but observer service is offline';
      }
    } else {
      // Check if browser-based Gmail automator is actively logged in
      try {
        const gmailBaseUrl = process.env.GMAIL_OBSERVER_URL || `http://127.0.0.1:${process.env.GMAIL_OBSERVER_PORT || 6003}`;
        const res = await fetch(new URL('/api/browser/status', gmailBaseUrl), {
          headers: { 'Authorization': `Bearer ${getObserverToken()}` },
          signal: AbortSignal.timeout(800)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.isLoggedIn === true && data.status === 'CONNECTED') {
            gmailHealthy = true;
            gmailReason = 'Gmail browser automator logged in';
          }
        }
      } catch (e) {}

      if (!gmailHealthy) {
        gmailReason = 'Gmail OAuth not configured';
      }
    }
  } catch (err) {
    gmailReason = `Gmail check error: ${err.message}`;
  }

  // 3-Tier Health Model:
  // Green: Both SMS + Gmail connected -> healthy
  // Yellow: Either SMS OR Gmail connected -> extra processing time
  // Red: Neither connected -> server facing issues
  const hasCash = sellingMode === 'ONLINE'
    ? enabledMethods.includes('COD')
    : enabledMethods.includes('CASH_COUNTER');

  if (smsHealthy && gmailHealthy) {
    return {
      status: 'WORKING',
      tier: 'GREEN',
      label: 'Server Is Working',
      isWorking: true,
      reason: 'All observers active: Gmail OAuth polling & SMS Gateway connected',
      smsHealthy: true,
      gmailHealthy: true,
      warning: null,
      recommendedAlternative: null
    };
  }

  if (smsHealthy || gmailHealthy) {
    return {
      status: 'BUSY',
      tier: 'YELLOW',
      label: 'UPI Server Busy',
      isWorking: true,
      reason: smsHealthy ? 'SMS observer active, Gmail observer offline' : 'Gmail observer active, SMS observer offline',
      smsHealthy,
      gmailHealthy,
      warning: 'Your payment may go through extra processing seconds.',
      recommendedAlternative: null
    };
  }

  return {
    status: 'ISSUES',
    tier: 'RED',
    label: 'Server Facing Issues',
    isWorking: false,
    reason: 'Both Gmail OAuth and SMS Gateway are offline or unconfigured',
    smsHealthy: false,
    gmailHealthy: false,
    warning: 'It is not recommended to pay by UPI right now as the server is facing downtime. We recommend paying by cash instead.',
    recommendedAlternative: hasCash ? 'CASH' : null
  };
}

export function registerCheckoutRoutes(server, ctx) {
  // GET /api/v1/checkout/:id/state
  server.get('/api/v1/checkout/:id/state', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Checkout session not found: ${params.id}` });
      return;
    }

    // Server-side Ban & Fraud Enforcement
    const isCustomerBanned = session.customerId && ctx.customerRepo && ctx.customerRepo.isBanned(session.customerId);
    const isSessionBlocked = session.status === 'BLOCKED' || (session.metadata?.banReason === 'FRAUDULENT_PAYMENT_INJECTION');

    if (isCustomerBanned || isSessionBlocked) {
      const cust = session.customerId ? ctx.customerRepo.findById(session.customerId) : null;
      HttpServer.json(res, 200, {
        id: session.id,
        orderId: session.orderId,
        amount: toRupeesString(session.amountPaise),
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        customerName: cust?.name || 'Customer',
        blockedNotice: {
          title: 'FRAUDULENT ACTIVITY DETECTED',
          subtitle: 'Payment Session Terminated & Account Suspended',
          message: 'Our automated verification engine detected fraudulent payment activity associated with this account. Access has been immediately suspended while our security operations team investigates the issue.',
          investigating: true,
          reason: cust?.banReason || 'FRAUDULENT_PAYMENT_INJECTION'
        }
      });
      return;
    }

    // Authoritative Server-Side Expiration Enforcer
    const now = Date.now();
    if (session.status === PaymentStatus.ACTIVE && session.expiresAt && session.expiresAt.getTime() <= now) {
      ctx.sessionRepo.transitionToTerminal(session.id, PaymentStatus.EXPIRED);
      session.status = PaymentStatus.EXPIRED;
      if (session.receivingAccountId) {
        ctx.queueEngine.promoteNext(session.receivingAccountId);
      }
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.EXPIRED });
    } else if (session.status === PaymentStatus.PROCESSING && session.processingExpiresAt && session.processingExpiresAt.getTime() <= now) {
      ctx.sessionRepo.transitionToTerminal(session.id, PaymentStatus.FAILED);
      session.status = PaymentStatus.FAILED;
      if (session.receivingAccountId) {
        ctx.queueEngine.promoteNext(session.receivingAccountId);
      }
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.FAILED });
    }

    // Terminal session handling: if session is terminal, return terminal state directly (CASE 4)
    if ([PaymentStatus.SUCCESS, PaymentStatus.OBSERVED_SUCCESS, PaymentStatus.RECONCILED, PaymentStatus.MANUAL_REVIEW, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      const merchant = ctx.merchantRepo.findById(session.merchantId);
      const branding = sanitizePublicBranding(merchant?.branding || {});
      HttpServer.json(res, 200, {
        id: session.id,
        paymentId: session.id,
        orderId: session.orderId,
        amount: toRupeesString(session.amountPaise),
        amountPaise: session.amountPaise.toString(),
        currency: session.currency,
        status: session.status,
        method: session.method,
        verificationTag: session.verificationTag || 'UNVERIFIED',
        returnUrl: session.returnUrl || null,
        timeRemainingSeconds: 0,
        isTerminal: true,
        // The return URL belongs to the terminal payload too. The checkout
        // page reads it from the *state* it was last given, and a terminal
        // session is answered by this branch — so a session that ends without
        // it loses the merchant's return address, and the customer is left
        // staring at a success screen with no way back to the store. The
        // field is already public in the non-terminal payload below, so
        // including it here exposes nothing new.
        returnUrl: session.returnUrl,
        branding
      });
      return;
    }

    // Device-level session binding validation (Section 8 & 9)
    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    const merchant = ctx.merchantRepo.findById(session.merchantId);
    const snapshot = session.metadata?.receivingAccountSnapshot;
    let receivingAccount = session.receivingAccountId
      ? ctx.accountRepo.findById(session.receivingAccountId)
      : null;

    if (!receivingAccount && snapshot?.id) {
      receivingAccount = ctx.accountRepo.findById(snapshot.id);
    }
    if (!receivingAccount && [PaymentMethod.UPI, PaymentMethod.MANUAL_UPI].includes(session.method)) {
      receivingAccount = ctx.accountRepo.findActiveForMerchant(session.merchantId);
    }

    // Invariant: Prefer immutable session snapshot VPA to prevent live VPA mutations from altering open checkout sessions (Issue #27)
    const payeeVpa = snapshot?.upiId || receivingAccount?.upiId || null;
    const payeeName = snapshot?.payeeName || receivingAccount?.payeeName || merchant?.businessName || 'Merchant Store';
    const isMerchantEnabled = (snapshot?.isMerchantEnabled !== undefined)
      ? Boolean(snapshot.isMerchantEnabled)
      : (receivingAccount ? Boolean(receivingAccount.isMerchantEnabled) : true);
    const upiMode = isMerchantEnabled ? 'MERCHANT' : 'NON_MERCHANT';

    let timeRemainingSeconds = 0;
    if (session.status === PaymentStatus.ACTIVE && session.expiresAt) {
      timeRemainingSeconds = Math.max(0, Math.ceil((session.expiresAt.getTime() - now) / 1000));
    } else if (session.status === PaymentStatus.PROCESSING && session.processingExpiresAt) {
      timeRemainingSeconds = Math.max(0, Math.ceil((session.processingExpiresAt.getTime() - now) / 1000));
    } else if (session.status === PaymentStatus.QUEUED) {
      timeRemainingSeconds = ctx.queueEngine.calculateEstimatedWaitSeconds(
        session.receivingAccountId,
        session.queuePosition
      );
    }

    let upiUri = null;
    if (session.status === PaymentStatus.ACTIVE && payeeVpa) {
      try {
        upiUri = buildUpiUri({
          payeeVpa,
          payeeName,
          amountPaise: session.amountPaise,
          transactionRef: session.orderId,
          currency: session.currency || 'INR'
        });
      } catch {
        upiUri = null;
      }
    }

    const merchantBranding = merchant?.branding || {};
    const isCounterSession = session.method === 'CASH_COUNTER' || session.method === 'CARD_COUNTER';
    const sellingMode = merchantBranding.sellingMode || (isCounterSession ? 'OFFLINE' : 'ONLINE');
    const supportEmails = merchantBranding.supportEmails || (merchant?.contactEmail ? [merchant.contactEmail] : []);
    const supportMobiles = merchantBranding.supportMobiles || (merchant?.contactPhone ? [merchant.contactPhone] : []);
    const privacyPolicyUrl = merchantBranding.privacyPolicyUrl || null;

    let rawEnabled = merchantBranding.enabledPaymentMethods || (sellingMode === 'ONLINE' ? ['UPI'] : ['UPI', 'CASH_COUNTER', 'CARD_COUNTER']);
    let enabledMethods = ['UPI'];
    if (sellingMode === 'ONLINE') {
      if (rawEnabled.includes('COD')) {
        enabledMethods.push('COD');
      }
    } else {
      if (rawEnabled.includes('CASH_COUNTER')) {
        enabledMethods.push('CASH_COUNTER');
      }
      if (rawEnabled.includes('CARD_COUNTER')) {
        enabledMethods.push('CARD_COUNTER');
      }
    }

    const branding = sanitizePublicBranding({
      ...merchantBranding,
      sellingMode,
      supportEmails,
      supportMobiles,
      privacyPolicyUrl,
      enabledPaymentMethods: enabledMethods
    });

    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.headers['x-customer-token'] || null);

    // Customer PII is only disclosed to a party that is entitled to it:
    //   - the owning merchant (admin/observer credential or X-Merchant-Key),
    //   - the co-located checkout renderer,
    //   - the customer themselves, presenting their own customer session token.
    // An anonymous holder of a payment id must not receive name/email/phone.
    const isOwnerCaller = isPaymentOwner(req, session, ctx) || isInternalServiceRequest(req);
    const tokenAuth = (bearerToken && ctx.customerSessionRepo) ? ctx.customerSessionRepo.findByToken(bearerToken) : null;
    const isSelfCaller = Boolean(tokenAuth?.customer && session.customerId && tokenAuth.customer.id === session.customerId);

    let customer = null;
    if (session.customerId && ctx.customerRepo && (isOwnerCaller || isSelfCaller)) {
      const c = ctx.customerRepo.findById(session.customerId);
      if (c) {
        customer = {
          id: c.id,
          name: c.name,
          email: c.email,
          mobileNumber: c.mobileNumber,
          fullName: c.name,
          phoneNumber: c.mobileNumber
        };
      }
    } else if (!customer && tokenAuth?.customer) {
      const c = tokenAuth.customer;
      customer = {
        id: c.id,
        name: c.name,
        email: c.email,
        mobileNumber: c.mobileNumber,
        fullName: c.name,
        phoneNumber: c.mobileNumber
      };
    }

    // Merchant metadata is merchant-private: only the owner (or the internal renderer)
    // may read it. The cancellation reason is exposed separately for the customer UI.
    const publicMetadata = isOwnerCaller ? (session.metadata || {}) : {};

    // Single active payment session check (Section 1 & 2)
    const requestingDeviceId = req.headers['x-device-id'] || null;
    let hasActiveSessionConflict = false;
    let conflictingSession = null;
    const conflictingActive = ctx.sessionRepo.findConflictingActiveSession
      ? ctx.sessionRepo.findConflictingActiveSession({
          customerId: session.customerId,
          deviceId: requestingDeviceId || session.deviceId || null,
          excludeSessionId: session.id
        })
      : null;

    if (conflictingActive && conflictingActive.id !== session.id && [PaymentStatus.INITIATED, PaymentStatus.ACTIVE, PaymentStatus.QUEUED].includes(session.status)) {
      if (conflictingActive.deviceId && (!requestingDeviceId || requestingDeviceId !== conflictingActive.deviceId)) {
        // CASE 3: Active session on another device -> DUPLICATE_SESSION_DETECTED
        HttpServer.json(res, 409, {
          error: 'DUPLICATE_SESSION_DETECTED',
          session_id: session.id,
          conflicting_session_id: conflictingActive.id,
          action: 'END_SESSION_AND_CREATE_NEW',
          message: 'This payment session was created on another device. For security reasons, this session cannot be continued from this device.',
          boundDeviceId: conflictingActive.deviceId,
          requestingDeviceId
        });
        return;
      }

      // CASE 2: Active session on same device -> CONTINUE ACTIVE SESSION or END & START NEW
      hasActiveSessionConflict = true;
      conflictingSession = {
        id: conflictingActive.id,
        paymentId: conflictingActive.id,
        orderId: conflictingActive.orderId,
        amount: toRupeesString(conflictingActive.amountPaise),
        status: conflictingActive.status,
        checkoutUrl: `/checkout/${conflictingActive.id}`
      };
    }

    // Build URI and compute remaining time ONLY if session is already active (e.g. after customer bound or counter active)
    if (session.status === PaymentStatus.ACTIVE) {
      if (payeeVpa && !upiUri) {
        try {
          upiUri = buildUpiUri({
            payeeVpa,
            payeeName,
            amountPaise: session.amountPaise,
            transactionRef: session.orderId,
            currency: session.currency || 'INR'
          });
        } catch {}
      }
      if (session.expiresAt) {
        timeRemainingSeconds = Math.max(0, Math.ceil((session.expiresAt.getTime() - now) / 1000));
      }
    }

    const upiServerIndicator = await checkUpiServerHealth(ctx, enabledMethods, sellingMode, session.merchantId);

    HttpServer.json(res, 200, {
      paymentId: session.id,
      orderId: session.orderId,
      merchantName: merchant?.businessName || 'Merchant',
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      status: session.status,
      reason: session.metadata?.cancelledReason || null,
      cancelledReason: session.metadata?.cancelledReason || null,
      metadata: publicMetadata,
      method: session.method,
      verificationLevel: session.verificationLevel || 0,
      verificationSources: session.verificationSources || [],
      verificationTag: session.verificationTag || 'UNVERIFIED',
      sellingMode,
      enabledMethods,
      customer,
      hasActiveSessionConflict,
      conflictingSession,
      queuePosition: session.queuePosition || 0,
      timeRemainingSeconds,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
      serverNow: new Date().toISOString(),
      upiUri,
      payeeVpa,
      payeeName,
      isMerchantEnabled,
      upiMode,
      upiServerIndicator,
      receivingAccountId: receivingAccount?.id || snapshot?.id || null,
      providers: UPI_PROVIDERS,
      canClickPaymentDone: session.status === PaymentStatus.ACTIVE,
      returnUrl: session.returnUrl,
      supportEmails,
      supportMobiles,
      privacyPolicyUrl,
      deviceId: session.deviceId || null,
      branding
    });
  });

  // GET /api/v1/checkout/server-health
  server.get('/api/v1/checkout/server-health', async (req, res) => {
    const merchantId = req.query?.merchantId || '00000000-0000-0000-0000-000000000001';
    const health = await checkUpiServerHealth(ctx, [], 'OFFLINE', merchantId);
    HttpServer.json(res, 200, health);
  });

  // POST /api/v1/checkout/:id/bind-customer
  server.post('/api/v1/checkout/:id/bind-customer', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const token = body.token ||
      body.sessionToken ||
      req.headers['x-customer-token'] ||
      ((req.headers['authorization'] || '').startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);
    const { customerId } = body;

    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    // INVARIANT: Payment session identity is IMMUTABLE once bound!
    // Cannot mutate or hijack an active session to another customer identity.
    if (session.customerId && customerId && session.customerId !== customerId) {
      HttpServer.json(res, 409, {
        error: 'Payment session is already bound to another customer identity and cannot be mutated or reassigned.'
      });
      return;
    }

    // Require a valid customer session token; never accept a bare client-asserted customerId!
    if (!token || typeof token !== 'string' || !ctx.customerSessionRepo) {
      HttpServer.json(res, 401, {
        error: 'A valid customer session token is required to bind a customer identity.',
        code: 'CUSTOMER_SESSION_REQUIRED'
      });
      return;
    }

    const authContext = ctx.customerSessionRepo.findByToken(token.trim());
    if (!authContext || !authContext.customer) {
      HttpServer.json(res, 401, {
        error: 'Invalid or expired customer session token.',
        code: 'CUSTOMER_SESSION_REQUIRED'
      });
      return;
    }

    const customer = authContext.customer;
    if (customerId && customerId !== customer.id) {
      HttpServer.json(res, 401, {
        error: 'Customer ID does not match authenticated session token.',
        code: 'CUSTOMER_SESSION_MISMATCH'
      });
      return;
    }

    // Device-level session binding validation
    const deviceAccess = checkSessionDeviceAccess(session, req, body, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }
    if (deviceAccess.boundDeviceId && ctx.deviceRepo) {
      try { ctx.deviceRepo.associateCustomer(deviceAccess.boundDeviceId, customer.id); } catch {}
    }

    if (session.customerId && session.customerId !== customer.id) {
      HttpServer.json(res, 409, {
        error: 'Payment session is already bound to another customer identity and cannot be mutated or reassigned.'
      });
      return;
    }

    // Check for active customer session conflict
    const otherActive = ctx.sessionRepo.findActiveForCustomer
      ? ctx.sessionRepo.findActiveForCustomer(customer.id, params.id)
      : null;

    let hasActiveSessionConflict = false;
    let conflictingSession = null;
    if (otherActive && otherActive.id !== params.id) {
      hasActiveSessionConflict = true;
      conflictingSession = {
        id: otherActive.id,
        paymentId: otherActive.id,
        orderId: otherActive.orderId,
        amount: toRupeesString(otherActive.amountPaise),
        status: otherActive.status,
        checkoutUrl: `/checkout/${otherActive.id}`
      };
    }

    // If already bound to this exact customer and already activated, return current state with conflict status
    if (session.customerId === customer.id && session.status !== PaymentStatus.INITIATED) {
      HttpServer.json(res, 200, {
        success: true,
        status: session.status,
        queuePosition: session.queuePosition || 0,
        expiresAt: session.expiresAt,
        hasActiveSessionConflict,
        conflictingSession,
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          mobileNumber: customer.mobileNumber,
          fullName: customer.name,
          phoneNumber: customer.mobileNumber
        }
      });
      return;
    }

    // Bind customer to payment session
    ctx.db.execute(`
      UPDATE payment_sessions
      SET customer_id = ?, updated_at = ?
      WHERE id = ?
    `, [customer.id, new Date().toISOString(), params.id]);

    // INVARIANT: Single Active Payment Session per Customer
    if (otherActive && otherActive.id !== params.id) {
      const requestingDeviceId = req.headers['x-device-id'] || body?.deviceId || null;
      if (otherActive.deviceId && (!requestingDeviceId || requestingDeviceId !== otherActive.deviceId)) {
        // CASE 3: Active session on another device -> DUPLICATE_SESSION_DETECTED
        HttpServer.json(res, 409, {
          error: 'DUPLICATE_SESSION_DETECTED',
          session_id: params.id,
          conflicting_session_id: otherActive.id,
          action: 'END_SESSION_AND_CREATE_NEW',
          message: 'This customer already has an active payment session on another device. For security reasons, this session cannot be continued from this device.',
          boundDeviceId: otherActive.deviceId,
          requestingDeviceId
        });
        return;
      }

      hasActiveSessionConflict = true;
      conflictingSession = {
        id: otherActive.id,
        paymentId: otherActive.id,
        orderId: otherActive.orderId,
        amount: toRupeesString(otherActive.amountPaise),
        status: otherActive.status,
        checkoutUrl: `/checkout/${otherActive.id}`
      };
    }

    // INVARIANT: When customer logs in or signs up, activate session and start 5-minute timer NOW (unless conflict exists)!
    let queueResult = { status: session.status, queuePosition: session.queuePosition, expiresAt: session.expiresAt };
    const targetAccountId = session.receivingAccountId || ctx.accountRepo?.findActiveForMerchant(session.merchantId)?.id || session.metadata?.receivingAccountSnapshot?.id;
    if (!hasActiveSessionConflict && session.status === PaymentStatus.INITIATED && targetAccountId) {
      queueResult = ctx.queueEngine.enqueueOrActivate(session.id, targetAccountId, ctx.timingEngine?.activeDurationMs || 300000);
      if (queueResult.expiresAt) {
        ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
      }
      server.broadcastSse(session.id, 'status_change', {
        status: queueResult.status,
        queuePosition: queueResult.queuePosition,
        expiresAt: queueResult.expiresAt
      });
      server.broadcastSse('admin_counter_events', 'status_change', {
        status: queueResult.status,
        sessionId: session.id,
        orderId: session.orderId,
        amountPaise: session.amountPaise ? session.amountPaise.toString() : '0'
      });
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: 'CUSTOMER_AUTHENTICATED_AND_BOUND',
        actorType: 'CUSTOMER',
        actorId: customer.id,
        details: { email: customer.email, mobileNumber: customer.mobileNumber, sessionStatus: queueResult.status, hasActiveSessionConflict }
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      status: queueResult.status,
      queuePosition: queueResult.queuePosition,
      expiresAt: queueResult.expiresAt,
      hasActiveSessionConflict,
      conflictingSession,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        fullName: customer.name,
        phoneNumber: customer.mobileNumber
      }
    });
  });

  // POST /api/v1/checkout/:id/retry-new-payment - Cancels previous abandoned active session and activates new payment
  server.post('/api/v1/checkout/:id/retry-new-payment', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if (session.status === PaymentStatus.PROCESSING) {
      HttpServer.json(res, 409, {
        error: 'SESSION_PROCESSING',
        message: 'Cannot retry payment while session is in PROCESSING status.'
      });
      return;
    }

    if (CLOSED_CHECKOUT_STATES.includes(session.status)) {
      HttpServer.json(res, 400, { error: `Cannot retry payment for terminal session in status '${session.status}'` });
      return;
    }

    const customerId = session.customerId;
    const requestingDeviceId = req.headers['x-device-id'] || session.deviceId || null;

    // Never cancel a session that is in PROCESSING (in-flight bank verification).
    const processingConflict = ctx.db.query(`
      SELECT id FROM payment_sessions
      WHERE id != ? AND status = 'PROCESSING'
        AND (
          (? IS NOT NULL AND customer_id = ?)
          OR (? IS NOT NULL AND device_id = ?)
        )
    `, [session.id, customerId, customerId, requestingDeviceId, requestingDeviceId]);
    if (processingConflict.length > 0) {
      HttpServer.json(res, 409, {
        error: 'SESSION_PROCESSING',
        message: 'Another payment session for this customer or device is currently in bank verification (PROCESSING) and cannot be cancelled.'
      });
      return;
    }

    // Find all conflicting active/queued sessions for this customer OR device
    const conflicting = ctx.db.query(`
      SELECT id, receiving_account_id, status FROM payment_sessions
      WHERE id != ? AND status IN ('ACTIVE', 'QUEUED')
        AND (
          (? IS NOT NULL AND customer_id = ?)
          OR (? IS NOT NULL AND device_id = ?)
        )
    `, [session.id, customerId, customerId, requestingDeviceId, requestingDeviceId]);

    for (const c of conflicting) {
      ctx.sessionRepo.transitionToTerminal(c.id, PaymentStatus.CANCELLED, {
        reason: 'USER_RETRY_NEW_PAYMENT',
        replacedBySessionId: session.id
      });
      if (ctx.timingEngine) {
        ctx.timingEngine.cancelActiveTimer(c.id);
        if (typeof ctx.timingEngine.clearTimers === 'function') {
          ctx.timingEngine.clearTimers(c.id);
        }
      }
      server.broadcastSse(c.id, 'status_change', {
        status: PaymentStatus.CANCELLED,
        reason: 'USER_RETRY_NEW_PAYMENT'
      });
    }

    // Target receiving account
    const activeMerchantAcc = ctx.accountRepo ? ctx.accountRepo.findActiveForMerchant(session.merchantId) : null;
    const targetAccountId = activeMerchantAcc?.id ||
      session.receivingAccountId ||
      session.metadata?.receivingAccountSnapshot?.id;

    if (targetAccountId && session.receivingAccountId !== targetAccountId) {
      ctx.db.execute('UPDATE payment_sessions SET receiving_account_id = ? WHERE id = ?', [targetAccountId, session.id]);
      session.receivingAccountId = targetAccountId;
    }

    // Now activate current session immediately on the newly freed slot
    let queueResult = { status: session.status, queuePosition: session.queuePosition, expiresAt: session.expiresAt };
    if (targetAccountId) {
      queueResult = ctx.queueEngine.enqueueOrActivate(session.id, targetAccountId, ctx.timingEngine?.activeDurationMs || 300000);
      if (queueResult.expiresAt) {
        ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
      }
      server.broadcastSse(session.id, 'status_change', {
        status: queueResult.status,
        queuePosition: queueResult.queuePosition,
        expiresAt: queueResult.expiresAt
      });
      server.broadcastSse('admin_counter_events', 'status_change', {
        status: queueResult.status,
        sessionId: session.id,
        orderId: session.orderId,
        amountPaise: session.amountPaise ? session.amountPaise.toString() : '0'
      });
      ctx.sessionRepo.reindexQueue(targetAccountId);
    }

    const updated = ctx.sessionRepo.findById(session.id);
    HttpServer.json(res, 200, {
      success: true,
      paymentId: updated.id,
      status: updated.status,
      queuePosition: updated.queuePosition || 0,
      expiresAt: updated.expiresAt,
      message: 'Previous active session cancelled. New payment session activated.'
    });
  });

  // Manual UTR is a customer claim for independent review, never a payment confirmation.
  server.post('/api/v1/checkout/:id/manual-utr', async (req, res, params) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: 'Payment session not found.' });
      return;
    }
    if (session.method !== PaymentMethod.MANUAL_UPI) {
      HttpServer.json(res, 409, { error: 'This checkout does not use manual UPI verification.' });
      return;
    }
    if (session.status !== PaymentStatus.ACTIVE && session.status !== PaymentStatus.MANUAL_REVIEW) {
      HttpServer.json(res, 409, { error: 'This checkout is no longer accepting a transaction reference.' });
      return;
    }
    const deviceAccess = checkSessionDeviceAccess(session, req, body, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }
    const utr = String(body.utr || body.reference || '').trim();
    if (!/^[A-Za-z0-9-]{6,35}$/.test(utr)) {
      HttpServer.json(res, 400, { error: 'Enter a valid UPI reference (6–35 letters or digits).' });
      return;
    }
    try {
      const updated = ctx.sessionRepo.submitManualUtr(session.id, utr);
      if (updated.status === PaymentStatus.MANUAL_REVIEW && session.status !== PaymentStatus.MANUAL_REVIEW) {
        ctx.eventEmitter?.emit('PAYMENT.MANUAL_REVIEW', {
          paymentId: updated.id,
          orderId: updated.orderId,
          merchantId: updated.merchantId,
          amountPaise: updated.amountPaise,
          reason: 'CUSTOMER_UTR_SUBMITTED'
        });
        server.broadcastSse(updated.id, 'status_change', {
          status: PaymentStatus.MANUAL_REVIEW,
          settlementState: 'PENDING_VERIFICATION'
        });
      }
      HttpServer.json(res, 200, {
        paymentId: updated.id,
        orderId: updated.orderId,
        status: 'PENDING_VERIFICATION',
        settlementState: 'PENDING_VERIFICATION',
        customerUtr: updated.customerUtr,
        utrSubmittedAt: updated.utrSubmittedAt?.toISOString() || null,
        message: 'Payment submitted. The merchant must verify it in the bank account.'
      });
    } catch (err) {
      const duplicate = String(err?.message || '').includes('idx_manual_upi_utr_per_receiving_account')
        || String(err?.message || '').includes('UNIQUE constraint failed');
      HttpServer.json(res, duplicate ? 409 : 400, {
        error: duplicate ? 'This UPI reference has already been submitted.' : (err.message || 'Could not submit the UPI reference.')
      });
    }
  });

  // POST /api/v1/checkout/:id/payment-done
  server.post('/api/v1/checkout/:id/payment-done', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    if (session.method === PaymentMethod.MANUAL_UPI) {
      HttpServer.json(res, 409, { error: 'Manual UPI checkouts require a transaction reference; automatic observer verification is disabled.' });
      return;
    }

    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if (session.status === PaymentStatus.PROCESSING) {
      // Idempotent
      HttpServer.json(res, 200, {
        status: PaymentStatus.PROCESSING,
        message: 'Already in verification processing.'
      });
      return;
    }

    const now = Date.now();
    if (session.status === PaymentStatus.ACTIVE && session.expiresAt && session.expiresAt.getTime() <= now) {
      ctx.sessionRepo.transitionToTerminal(session.id, PaymentStatus.EXPIRED);
      if (session.receivingAccountId) {
        ctx.queueEngine.promoteNext(session.receivingAccountId);
      }
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.EXPIRED });
      HttpServer.json(res, 400, {
        error: 'Cannot start verification: payment session has EXPIRED.'
      });
      return;
    }

    if (session.status !== PaymentStatus.ACTIVE) {
      HttpServer.json(res, 400, {
        error: `Cannot start verification: session is in status '${session.status}', must be 'ACTIVE'.`
      });
      return;
    }

    const updated = ctx.timingEngine.handlePaymentDone(params.id);

    // Broadcast SSE update
    server.broadcastSse(params.id, 'status_change', {
      status: PaymentStatus.PROCESSING,
      processingExpiresAt: updated.processingExpiresAt
    });
    server.broadcastSse('admin_counter_events', 'status_change', {
      status: PaymentStatus.PROCESSING,
      sessionId: updated.id,
      orderId: updated.orderId,
      amountPaise: updated.amountPaise ? updated.amountPaise.toString() : '0'
    });

    HttpServer.json(res, 200, {
      paymentId: updated.id,
      status: PaymentStatus.PROCESSING,
      processingExpiresAt: updated.processingExpiresAt
    });
  });

  // POST /api/v1/checkout/:id/cancel
  server.post('/api/v1/checkout/:id/cancel', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    if (CLOSED_CHECKOUT_STATES.includes(session.status)) {
      HttpServer.json(res, 200, {
        paymentId: session.id,
        status: session.status
      });
      return;
    }

    if (session.status === PaymentStatus.PROCESSING) {
      HttpServer.json(res, 409, {
        error: 'SESSION_PROCESSING',
        message: 'Cannot cancel a payment session while bank verification is in progress (PROCESSING).'
      });
      return;
    }

    // Cancelling releases the merchant's scarce UPI slot and ends a live payment, so it is
    // subject to the same device-binding check as the other state-changing checkout actions.
    // Without this, anyone holding a payment id could grief an in-flight checkout.
    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    const updated = ctx.timingEngine.handleCancel(params.id);

    server.broadcastSse(params.id, 'status_change', {
      status: PaymentStatus.CANCELLED
    });

    HttpServer.json(res, 200, {
      paymentId: updated?.id || session.id,
      status: PaymentStatus.CANCELLED
    });
  });

  // POST /api/v1/checkout/:id/select-method (Switches payment method e.g. Cash/Card at Counter, COD, or UPI)
  server.post('/api/v1/checkout/:id/select-method', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const { method } = body;

    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = checkSessionDeviceAccess(session, req, body, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if (session.status === PaymentStatus.PROCESSING) {
      HttpServer.json(res, 400, { error: `Cannot switch payment method while payment is in PROCESSING status: Cannot switch payment method for session in status 'PROCESSING'` });
      return;
    }

    if (CLOSED_CHECKOUT_STATES.includes(session.status)) {
      HttpServer.json(res, 400, { error: `Cannot switch payment method for session in status '${session.status}'` });
      return;
    }

    if (session.method === PaymentMethod.MANUAL_UPI && method !== PaymentMethod.MANUAL_UPI) {
      HttpServer.json(res, 409, { error: 'Manual UPI sessions cannot switch into an automatic payment flow.' });
      return;
    }
    const validMethods = [PaymentMethod.UPI, PaymentMethod.COD, PaymentMethod.CASH_COUNTER, PaymentMethod.CARD_COUNTER];
    if (!validMethods.includes(method)) {
      HttpServer.json(res, 400, { error: `Invalid payment method '${method}'. Allowed: ${validMethods.join(', ')}` });
      return;
    }

    const merchant = ctx.merchantRepo.findById(session.merchantId);
    const merchantBranding = merchant?.branding || {};
    const isCounterRequested = method === PaymentMethod.CASH_COUNTER || method === PaymentMethod.CARD_COUNTER;
    let sellingMode = merchantBranding.sellingMode || (isCounterRequested ? 'OFFLINE' : 'ONLINE');
    let rawEnabled = merchantBranding.enabledPaymentMethods || (sellingMode === 'ONLINE' ? ['UPI', 'COD'] : ['UPI', 'CASH_COUNTER', 'CARD_COUNTER']);
    let enabledMethods = ['UPI'];
    if (sellingMode === 'ONLINE') {
      if (rawEnabled.includes('COD')) enabledMethods.push('COD');
    } else {
      if (rawEnabled.includes('CASH_COUNTER')) enabledMethods.push('CASH_COUNTER');
      if (rawEnabled.includes('CARD_COUNTER')) enabledMethods.push('CARD_COUNTER');
    }

    if (!enabledMethods.includes(method)) {
      HttpServer.json(res, 400, { error: `Payment method '${method}' is disabled by the merchant.` });
      return;
    }

    const previousMethod = session.method;
    const isCounter = method === PaymentMethod.CASH_COUNTER || method === PaymentMethod.CARD_COUNTER;
    const isCod = method === PaymentMethod.COD;
    const wasCounter = previousMethod === PaymentMethod.CASH_COUNTER || previousMethod === PaymentMethod.CARD_COUNTER;
    const wasCod = previousMethod === PaymentMethod.COD;
    const wasUpi = previousMethod === PaymentMethod.UPI || (!wasCounter && !wasCod);
    const nowIso = new Date().toISOString();

    let updates = `method = ?, updated_at = ?`;
    let updateParams = [method, nowIso];

    let oldReceivingAccountId = null;
    let timeRemainingSeconds = 0;
    let newExpiresAt = null;

    if (isCounter || isCod) {
      // Switching from UPI to COD or Counter:
      // Invariant: Concurrency slot and queue window are strictly for UPI payments.
      // Immediately invalidate and cancel the UPI queue reservation and its active timer.
      if (session.receivingAccountId) {
        oldReceivingAccountId = session.receivingAccountId;
      }

      if (ctx.timingEngine) {
        ctx.timingEngine.cancelActiveTimer(session.id);
      }

      if (isCod) {
        // In Online Selling Mode, if Cash on Delivery is selected:
        // Run a parallel standalone timer of 5 minutes (300 seconds) which is NOT part of the queue.
        newExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
        updates += `, receiving_account_id = NULL, status = 'ACTIVE', queue_position = 0, expires_at = ?`;
        updateParams.push(newExpiresAt.toISOString());
        session.receivingAccountId = null;
        session.status = PaymentStatus.ACTIVE;
        session.queuePosition = 0;
        session.expiresAt = newExpiresAt;

        // Start parallel 5-minute timer in timingEngine
        if (ctx.timingEngine) {
          ctx.timingEngine.startActiveTimer(session.id, newExpiresAt);
        }
        timeRemainingSeconds = 300;
      } else {
        // Offline counter payment (CASH_COUNTER or CARD_COUNTER)
        updates += `, receiving_account_id = NULL, status = 'ACTIVE', queue_position = 0, expires_at = NULL`;
        session.receivingAccountId = null;
        session.status = PaymentStatus.ACTIVE;
        session.queuePosition = 0;
        session.expiresAt = null;
        timeRemainingSeconds = 0;
      }
    } else if (!isCounter && !isCod && (wasCounter || wasCod)) {
      // Switching back to UPI:
      // Cancel any running parallel COD timer
      if (ctx.timingEngine) {
        ctx.timingEngine.cancelActiveTimer(session.id);
      }

      // Re-resolve active receiving account and enqueue/activate into UPI queue
      const receivingAccount = ctx.accountRepo.findActiveForMerchant(session.merchantId);
      if (receivingAccount) {
        const queueResult = ctx.queueEngine.enqueueOrActivate(session.id, receivingAccount.id);
        updates += `, receiving_account_id = ?, status = ?, queue_position = ?, expires_at = ?`;
        updateParams.push(
          receivingAccount.id,
          queueResult.status,
          queueResult.queuePosition,
          queueResult.expiresAt ? queueResult.expiresAt.toISOString() : null
        );
        session.receivingAccountId = receivingAccount.id;
        session.status = queueResult.status;
        session.queuePosition = queueResult.queuePosition;
        session.expiresAt = queueResult.expiresAt;

        if (queueResult.expiresAt && ctx.timingEngine && queueResult.status === PaymentStatus.ACTIVE) {
          ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
        }
        if (queueResult.expiresAt) {
          timeRemainingSeconds = Math.max(0, Math.ceil((queueResult.expiresAt.getTime() - Date.now()) / 1000));
        }
      }
    } else if (!isCounter && !isCod && session.expiresAt) {
      timeRemainingSeconds = Math.max(0, Math.ceil((session.expiresAt.getTime() - Date.now()) / 1000));
    }

    updateParams.push(session.id);
    ctx.db.execute(`UPDATE payment_sessions SET ${updates} WHERE id = ?`, updateParams);
    session.method = method;

    // If slot was released on the receiving account, update receiving account and promote waiting queued sessions!
    if (oldReceivingAccountId) {
      ctx.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
        WHERE id = ? AND (current_active_session_id = ? OR current_active_session_id IS NULL)
      `, [nowIso, oldReceivingAccountId, session.id]);

      const promoted = ctx.queueEngine.promoteNext(oldReceivingAccountId);
      if (promoted) {
        if (promoted.expiresAt && ctx.timingEngine) {
          ctx.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
        }
        server.broadcastSse(promoted.id, 'status_change', {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: promoted.expiresAt
        });
        server.broadcastSse(`queue_${oldReceivingAccountId}`, 'queue_update', {
          promotedId: promoted.id
        });
      } else {
        ctx.sessionRepo.reindexQueue(oldReceivingAccountId);
      }
    }

    // Broadcast SSE update to customer session channel
    server.broadcastSse(session.id, 'status_change', {
      status: session.status,
      method: session.method,
      queuePosition: session.queuePosition || 0,
      timeRemainingSeconds,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null
    });

    // Broadcast live event to merchant dashboard counter desk if counter method
    if (isCounter) {
      server.broadcastSse('admin_counter_events', 'counter_payment_requested', {
        paymentId: session.id,
        orderId: session.orderId,
        amountPaise: session.amountPaise.toString(),
        method: session.method,
        status: session.status,
        createdAt: session.createdAt
      });
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: 'PAYMENT_METHOD_SWITCHED',
        actorType: 'CUSTOMER',
        details: { from: previousMethod, to: method }
      });
    }

    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit('PAYMENT.METHOD_SWITCHED', {
        paymentId: session.id,
        orderId: session.orderId,
        merchantId: session.merchantId,
        fromMethod: previousMethod,
        toMethod: method
      });
    }

    const counterInstr = method === PaymentMethod.CARD_COUNTER
      ? (merchantBranding.cardCounterInstructions || merchantBranding.counterInstructions || 'Please visit the billing counter and pay via Card POS.')
      : (merchantBranding.counterInstructions || 'Please visit the billing counter and present this screen to the cashier.');

    HttpServer.json(res, 200, {
      success: true,
      paymentId: session.id,
      method: session.method,
      status: session.status,
      timeRemainingSeconds,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
      counterInstructions: counterInstr
    });
  });

  // POST /api/v1/checkout/:id/confirm-cod (Confirm Cash on Delivery Order)
  server.post('/api/v1/checkout/:id/confirm-cod', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    // PROCESSING: a UPI payment was already detected and is being verified; switching it to COD would drop that payment.
    if (session.status === PaymentStatus.PROCESSING) {
      HttpServer.json(res, 400, { error: 'Cannot place COD order while payment is in PROCESSING status' });
      return;
    }

    if (CLOSED_CHECKOUT_STATES.includes(session.status)) {
      HttpServer.json(res, 400, { error: `Cannot place COD order for terminal session in status '${session.status}'` });
      return;
    }

    // COD terminates the session as SUCCESS; make sure the state machine permits that edge
    // (INITIATED/QUEUED/ACTIVE are all legal; anything else is caught above).
    if (!isValidTransition(session.status, PaymentStatus.SUCCESS)) {
      HttpServer.json(res, 409, { error: `Cannot place COD order for session in status '${session.status}'.` });
      return;
    }

    const merchant = ctx.merchantRepo.findById(session.merchantId);
    const branding = merchant?.branding || {};
    const sellingMode = branding.sellingMode || (branding.enabledPaymentMethods?.some(m => m === 'CASH_COUNTER' || m === 'CARD_COUNTER') ? 'OFFLINE' : 'ONLINE');
    if (sellingMode !== 'ONLINE') {
      HttpServer.json(res, 400, { error: 'Cash on Delivery is only available in Online Selling Mode.' });
      return;
    }

    const rawEnabled = branding.enabledPaymentMethods || ['UPI'];
    if (!rawEnabled.includes('COD')) {
      HttpServer.json(res, 400, { error: 'Cash on Delivery is currently disabled by merchant.' });
      return;
    }

    // Cancel Active Timer
    if (ctx.timingEngine) {
      if (typeof ctx.timingEngine.cancelActiveTimer === 'function') {
        ctx.timingEngine.cancelActiveTimer(session.id);
      }
    }

    // Update payment session to SUCCESS with COD method and release slot inside transaction
    const nowIso = new Date().toISOString();
    const oldReceivingAccountId = session.receivingAccountId || session.receiving_account_id;

    ctx.sessionRepo.db.transaction(() => {
      ctx.sessionRepo.db.execute(`
        UPDATE payment_sessions
        SET method = 'COD',
            status = 'SUCCESS',
            verification_tag = 'COD_ORDER_PLACED',
            verification_level = 1,
            completed_at = ?,
            receiving_account_id = NULL,
            updated_at = ?
        WHERE id = ? AND status IN ('INITIATED', 'QUEUED', 'ACTIVE')
      `, [nowIso, nowIso, session.id]);

      // Release receiving account slot
      if (oldReceivingAccountId) {
        ctx.sessionRepo.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND (current_active_session_id = ? OR current_active_session_id IS NULL)
        `, [nowIso, oldReceivingAccountId, session.id]);
      }
    });

    if (oldReceivingAccountId && ctx.queueEngine) {
      const promoted = ctx.queueEngine.promoteNext(oldReceivingAccountId);
      if (promoted) {
        if (promoted.expiresAt && ctx.timingEngine) {
          ctx.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
        }
        server.broadcastSse(promoted.id, 'status_change', {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: promoted.expiresAt
        });
        server.broadcastSse(`queue_${oldReceivingAccountId}`, 'queue_update', {
          promotedId: promoted.id
        });
      }
    }

    const updated = ctx.sessionRepo.findById(session.id);

    let customer = null;
    if (updated.customerId && ctx.customerRepo) {
      const c = ctx.customerRepo.findById(updated.customerId);
      if (c) {
        customer = {
          id: c.id,
          name: c.name,
          email: c.email,
          mobileNumber: c.mobileNumber
        };
      }
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: updated.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: updated.id,
        action: 'COD_ORDER_PLACED',
        actorType: 'CUSTOMER',
        details: { orderId: updated.orderId, amountPaise: updated.amountPaise.toString() }
      });
    }

    // Broadcast SSE
    server.broadcastSse(params.id, 'status_change', {
      status: 'SUCCESS',
      method: 'COD',
      verificationTag: 'COD_ORDER_PLACED'
    });

    // Webhook dispatch
    if (ctx.webhookEngine && merchant && merchant.webhookUrl) {
      ctx.webhookEngine.dispatch('SUCCESS', updated).catch(err => console.error('COD Webhook dispatch failed:', err.message));
    }

    HttpServer.json(res, 200, {
      success: true,
      paymentId: updated.id,
      orderId: updated.orderId,
      amount: toRupeesString(updated.amountPaise),
      amountPaise: updated.amountPaise.toString(),
      currency: updated.currency,
      method: 'COD',
      status: 'SUCCESS',
      verificationTag: 'COD_ORDER_PLACED',
      customer,
      returnUrl: session.returnUrl
    });
  });

  // GET /api/v1/checkout/:id/cod (Query COD order info)
  server.get('/api/v1/checkout/:id/cod', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }
    let customer = null;
    if (isPaymentOwner(req, session, ctx) && session.customerId && ctx.customerRepo) {
      const c = ctx.customerRepo.findById(session.customerId);
      if (c) {
        customer = {
          id: c.id,
          name: c.name,
          email: c.email,
          mobileNumber: c.mobileNumber
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
      customer,
      placedAt: session.completedAt || session.createdAt
    });
  });

  // POST /api/v1/checkout/:id/expire (Explicit Client Expiry Trigger)
  server.post('/api/v1/checkout/:id/expire', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    if (session.status === PaymentStatus.ACTIVE) {
      ctx.timingEngine.handleActiveTimerExpiration(session.id);
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.EXPIRED });
    }

    HttpServer.json(res, 200, {
      success: true,
      paymentId: session.id,
      status: PaymentStatus.EXPIRED
    });
  });

  // POST /api/v1/checkout/:id/trigger-hook (Merchant Action & Telemetry Trigger)
  server.post('/api/v1/checkout/:id/trigger-hook', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const { action, details } = body;

    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const deviceAccess = checkSessionDeviceAccess(session, req, body, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }

    const token = body.token ||
      body.sessionToken ||
      req.headers['x-customer-token'] ||
      ((req.headers['authorization'] || '').startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);
    const authContext = (token && typeof token === 'string' && ctx.customerSessionRepo)
      ? ctx.customerSessionRepo.findByToken(token.trim())
      : null;

    const hasValidCustomerToken = Boolean(
      authContext?.customer && (!session.customerId || authContext.customer.id === session.customerId)
    );
    const hasVerifiedDevice = Boolean(deviceAccess.boundDeviceId);
    const hasOwnerAuth = isPaymentOwner(req, session, ctx);

    if (!hasValidCustomerToken && !hasVerifiedDevice && !hasOwnerAuth) {
      HttpServer.json(res, 401, {
        error: 'A valid customer session token or bound device credential is required to trigger checkout hooks.',
        code: 'CUSTOMER_SESSION_REQUIRED'
      });
      return;
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: `HOOK_${action || 'USER_ACTION'}`,
        actorType: 'CUSTOMER',
        details: details || {}
      });
    }

    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit('PAYMENT.ACTION_TRIGGERED', {
        paymentId: session.id,
        orderId: session.orderId,
        merchantId: session.merchantId,
        action: action || 'ACTION',
        details: details || {}
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      action: action || 'ACTION',
      timestamp: new Date().toISOString()
    });
  });

  // POST /api/v1/checkout/:id/simulate-observation (Inject simulated SMS / Email observation)
  server.post('/api/v1/checkout/:id/simulate-observation', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: 'Session not found' });
      return;
    }

    const body = await HttpServer.parseBody(req);
    const source = (body.source || 'SMS').toUpperCase();
    const rawText = (body.rawText || body.message || body.text || '').toString();
    const sender = (body.sender || '').toString();

    if (!rawText) {
      HttpServer.json(res, 400, { error: 'Missing message body' });
      return;
    }

    const pipeline = ctx.pipeline;
    if (!pipeline) {
      HttpServer.json(res, 500, { error: 'Verification pipeline not available' });
      return;
    }

    const result = pipeline.process({
      source,
      rawText,
      sender,
      paymentSessionId: session.id,
      receivingAccountId: session.receivingAccountId,
      isTest: Boolean(body.isTest),
      testModeActive: Boolean(body.testModeActive)
    });

    if (result.status === 'REJECTED' && result.failingCondition === 'FRAUDULENT_PAYMENT_INJECTION') {
      HttpServer.json(res, 403, {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        reason: 'FRAUDULENT_PAYMENT_INJECTION',
        error: 'FRAUDULENT_PAYMENT_INJECTION: Fake payment observation detected. User banned and session terminated.'
      });
      return;
    }

    HttpServer.json(res, 200, {
      success: result.success,
      status: result.status,
      result
    });
  });

  // POST /api/v1/checkout/:id/end-and-restart-payment (or end-session-and-create-new)
  // Cancels previous session created on another device and creates a fresh payment session bound to current device
  async function handleEndAndRestartPayment(req, res, params) {
    const session = ctx.sessionRepo.findById(params.id);
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const conflictingSessionId = body?.conflictingSessionId || body?.conflicting_session_id || null;

    if (!session && !conflictingSessionId) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const targetSession = session || ctx.sessionRepo.findById(conflictingSessionId);
    if (!targetSession) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const newDeviceId = req.headers['x-device-id'] || body?.deviceId || null;
    if (!newDeviceId) {
      HttpServer.json(res, 400, { error: 'Current device identity is required to bind the new payment session.' });
      return;
    }

    const sourceSession = (conflictingSessionId ? ctx.sessionRepo.findById(conflictingSessionId) : null) || targetSession;

    // A settled order must not be restarted. The restarted session deliberately reuses the
    // merchant's order reference, and the unique (merchant_id, order_id) index rejects a
    // second row for an order that already succeeded — which surfaced as a 500. Refuse with a
    // clear conflict instead of attempting the duplicate.
    const paidSession = [sourceSession, targetSession, session].find(s => s && (
      s.status === PaymentStatus.SUCCESS
      || s.status === PaymentStatus.OBSERVED_SUCCESS
      || s.status === PaymentStatus.RECONCILED
      || s.status === PaymentStatus.MANUAL_REVIEW
    ));
    if (paidSession) {
      HttpServer.json(res, 409, {
        error: 'ORDER_ALREADY_PAID',
        message: 'This order is already closed and cannot be restarted.',
        orderId: paidSession.orderId,
        status: paidSession.status
      });
      return;
    }

    const processingSession = [sourceSession, targetSession, session].find(s => s && s.status === PaymentStatus.PROCESSING);
    if (processingSession) {
      HttpServer.json(res, 409, {
        error: 'SESSION_PROCESSING',
        message: 'Cannot terminate or restart a payment session while bank verification is in progress (PROCESSING).',
        sessionId: processingSession.id,
        status: PaymentStatus.PROCESSING
      });
      return;
    }

    const newDeviceToken = req.headers['x-device-token'] || body?.deviceToken || null;
    const newDeviceSignature = req.headers['x-device-signature'] || body?.deviceSignature || null;
    const newSignaturePayload = req.headers['x-device-payload'] || body?.signaturePayload || null;

    const credCheck = verifyRegisteredDeviceCredentials({
      deviceId: newDeviceId,
      deviceToken: newDeviceToken,
      deviceSignature: newDeviceSignature,
      signaturePayload: newSignaturePayload,
      deviceRepo: ctx.deviceRepo
    });
    if (!credCheck.valid) {
      HttpServer.json(res, 401, {
        error: credCheck.error || 'DEVICE_CREDENTIALS_INVALID',
        message: credCheck.message || 'A registered device and valid device credential are required.'
      });
      return;
    }

    // Never accept an unverified customerId from the request body!
    const rawCustToken = body?.token ||
      body?.sessionToken ||
      req.headers['x-customer-token'] ||
      ((req.headers['authorization'] || '').startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);
    const authCtx = (rawCustToken && ctx.customerSessionRepo)
      ? ctx.customerSessionRepo.findByToken(String(rawCustToken).trim())
      : null;
    const authenticatedCustomerId = authCtx?.customer?.id || null;

    if (body?.customerId && (!authenticatedCustomerId || body.customerId !== authenticatedCustomerId)) {
      HttpServer.json(res, 401, {
        error: 'CUSTOMER_AUTH_REQUIRED',
        message: 'Customer identity cannot be supplied in the request body without a matching valid customer session token.'
      });
      return;
    }

    if (authenticatedCustomerId && sourceSession?.customerId && sourceSession.customerId !== authenticatedCustomerId) {
      HttpServer.json(res, 403, {
        error: 'CUSTOMER_MISMATCH',
        message: 'Authenticated customer does not match the payment session owner.'
      });
      return;
    }

    const customerId = authenticatedCustomerId || sourceSession?.customerId || targetSession.customerId || null;

    // 1. Identify ALL sessions on old/other devices that must be cancelled (excluding PROCESSING and terminal states)
    const NON_CANCELLABLE_STATES = [
      PaymentStatus.PROCESSING,
      ...CLOSED_CHECKOUT_STATES
    ];
    const sessionsToTerminate = new Map();

    if (!NON_CANCELLABLE_STATES.includes(targetSession.status)) {
      sessionsToTerminate.set(targetSession.id, targetSession);
    }

    if (conflictingSessionId) {
      const confSess = ctx.sessionRepo.findById(conflictingSessionId);
      if (confSess?.status === PaymentStatus.PROCESSING) {
        HttpServer.json(res, 409, {
          error: 'SESSION_PROCESSING',
          message: 'Conflicting payment session is currently in bank verification (PROCESSING) and cannot be terminated.'
        });
        return;
      }
      if (confSess && !NON_CANCELLABLE_STATES.includes(confSess.status)) {
        sessionsToTerminate.set(confSess.id, confSess);
      }
    }

    if (customerId && ctx.sessionRepo.findAllActiveOrPendingForCustomer) {
      const custSessions = ctx.sessionRepo.findAllActiveOrPendingForCustomer(customerId);
      for (const cs of custSessions) {
        if (cs.status === PaymentStatus.PROCESSING) {
          HttpServer.json(res, 409, {
            error: 'SESSION_PROCESSING',
            message: 'Another payment session for this customer is currently in bank verification (PROCESSING) and cannot be terminated.'
          });
          return;
        }
        if (!NON_CANCELLABLE_STATES.includes(cs.status)) {
          if (!cs.deviceId || cs.deviceId !== newDeviceId || cs.id === targetSession.id) {
            sessionsToTerminate.set(cs.id, cs);
          }
        }
      }
    }

    if (session && session.id !== targetSession.id && !NON_CANCELLABLE_STATES.includes(session.status)) {
      sessionsToTerminate.set(session.id, session);
    }

    // Also check if an active session on the receiving account belongs to the same order / customer
    const receivingAccountIdForLookup = targetSession.receivingAccountId || session?.receivingAccountId;
    if (receivingAccountIdForLookup && ctx.sessionRepo.findCurrentActiveOrProcessing) {
      const activeOnAcc = ctx.sessionRepo.findCurrentActiveOrProcessing(receivingAccountIdForLookup);
      if (activeOnAcc && activeOnAcc.deviceId !== newDeviceId) {
        const cleanTargetOrder = targetSession.orderId ? targetSession.orderId.replace(/-R\d+$/, '') : '';
        const cleanActiveOrder = activeOnAcc.orderId ? activeOnAcc.orderId.replace(/-R\d+$/, '') : '';
        if ((cleanTargetOrder && cleanTargetOrder === cleanActiveOrder) || (customerId && activeOnAcc.customerId === customerId)) {
          if (activeOnAcc.status === PaymentStatus.PROCESSING) {
            HttpServer.json(res, 409, {
              error: 'SESSION_PROCESSING',
              message: 'Active payment session for this order is currently in bank verification (PROCESSING) and cannot be terminated.'
            });
            return;
          }
          sessionsToTerminate.set(activeOnAcc.id, activeOnAcc);
        }
      }
    }

    // Resolve receiving account ID for new session (guarantee active account for merchant)
    const activeMerchantAcc = ctx.accountRepo ? ctx.accountRepo.findActiveForMerchant(sourceSession.merchantId) : null;
    const targetReceivingAccountId = activeMerchantAcc?.id || sourceSession.receivingAccountId;

    const affectedAccountIds = new Set();
    for (const [sId, sObj] of sessionsToTerminate.entries()) {
      if (sObj?.receivingAccountId) {
        affectedAccountIds.add(sObj.receivingAccountId);
      }
    }
    if (receivingAccountIdForLookup) {
      affectedAccountIds.add(receivingAccountIdForLookup);
    }
    if (targetReceivingAccountId) {
      affectedAccountIds.add(targetReceivingAccountId);
    }

    // 2. Terminate all old sessions, cancel timers, and broadcast SSE
    for (const [sId, sObj] of sessionsToTerminate.entries()) {
      ctx.sessionRepo.transitionToTerminal(sId, PaymentStatus.CANCELLED, {
        reason: 'REPLACED_ON_ANOTHER_DEVICE',
        replacedByDeviceId: newDeviceId
      });

      if (ctx.timingEngine) {
        ctx.timingEngine.cancelActiveTimer(sId);
        if (typeof ctx.timingEngine.clearTimers === 'function') {
          ctx.timingEngine.clearTimers(sId);
        }
      }

      server.broadcastSse(sId, 'status_change', {
        status: PaymentStatus.CANCELLED,
        reason: 'REPLACED_ON_ANOTHER_DEVICE',
        message: 'Payment session closed because you continued on another device.'
      });
    }

    // 3. Immediately release receiving-account slot, re-index queue, and promote next queued session if applicable
    const termIds = Array.from(sessionsToTerminate.keys());
    for (const accId of affectedAccountIds) {
      const nowIso = new Date().toISOString();
      if (termIds.length > 0) {
        ctx.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND (current_active_session_id IN (${termIds.map(() => '?').join(',')}) OR current_active_session_id IS NULL)
        `, [nowIso, accId, ...termIds]);
      }

      if (ctx.sessionRepo.reindexQueue) {
        ctx.sessionRepo.reindexQueue(accId);
      }

      if (ctx.queueEngine && typeof ctx.queueEngine.promoteNext === 'function') {
        const promoted = ctx.queueEngine.promoteNext(accId);
        if (promoted) {
          if (ctx.timingEngine && promoted.expiresAt) {
            ctx.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
          }
          server.broadcastSse(promoted.id, 'status_change', {
            status: PaymentStatus.ACTIVE,
            queuePosition: 0,
            expiresAt: promoted.expiresAt
          });
          server.broadcastSse('admin_counter_events', 'status_change', {
            status: PaymentStatus.ACTIVE,
            sessionId: promoted.id,
            orderId: promoted.orderId,
            amountPaise: promoted.amountPaise ? promoted.amountPaise.toString() : '0'
          });
        }
      }
    }

    // 4. Preserve merchant's exact order reference from sourceSession
    const newOrderId = sourceSession.orderId ? sourceSession.orderId.replace(/-R\d+$/, '') : `ORD-${Date.now()}`;

    // 5. Touch verified device
    if (newDeviceId && ctx.deviceRepo) {
      ctx.deviceRepo.touch(newDeviceId);
    }

    // 6. Create fresh payment session bound to newDeviceId
    const newSession = ctx.sessionRepo.create({
      merchantId: sourceSession.merchantId,
      customerId: customerId || sourceSession.customerId,
      receivingAccountId: targetReceivingAccountId,
      orderId: newOrderId,
      amountPaise: sourceSession.amountPaise,
      currency: sourceSession.currency,
      method: sourceSession.method || PaymentMethod.UPI,
      status: PaymentStatus.INITIATED,
      returnUrl: sourceSession.returnUrl,
      deviceId: newDeviceId,
      metadata: {
        ...(sourceSession.metadata || {}),
        reboundFromSessionId: sourceSession.id,
        reboundAt: new Date().toISOString()
      }
    });

    if (customerId && ctx.deviceRepo) {
      try { ctx.deviceRepo.associateCustomer(newDeviceId, customerId); } catch {}
    }

    // 7. Enqueue or activate new session if UPI
    let queueResult = { status: newSession.status, queuePosition: 0, expiresAt: null };
    if (newSession.receivingAccountId && (String(newSession.method).toUpperCase() === 'UPI' || !newSession.method)) {
      queueResult = ctx.queueEngine.enqueueOrActivate(newSession.id, newSession.receivingAccountId, ctx.timingEngine?.activeDurationMs || 300000);
      if (queueResult.expiresAt && ctx.timingEngine) {
        ctx.timingEngine.startActiveTimer(newSession.id, queueResult.expiresAt);
      }
      server.broadcastSse(newSession.id, 'status_change', {
        status: queueResult.status,
        queuePosition: queueResult.queuePosition,
        expiresAt: queueResult.expiresAt
      });
      server.broadcastSse('admin_counter_events', 'status_change', {
        status: queueResult.status,
        sessionId: newSession.id,
        orderId: newSession.orderId,
        amountPaise: newSession.amountPaise ? newSession.amountPaise.toString() : '0'
      });
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: sourceSession.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: newSession.id,
        action: 'PAYMENT_SESSION_RECREATED_ON_NEW_DEVICE',
        actorType: 'CUSTOMER',
        actorId: customerId || 'ANONYMOUS',
        details: {
          terminatedSessionIds: Array.from(sessionsToTerminate.keys()),
          newSessionId: newSession.id,
          newDeviceId
        }
      });
    }

    HttpServer.json(res, 201, {
      success: true,
      oldSessionId: targetSession.id,
      terminatedSessionIds: Array.from(sessionsToTerminate.keys()),
      newSessionId: newSession.id,
      paymentId: newSession.id,
      orderId: newSession.orderId,
      checkoutUrl: `/checkout/${newSession.id}`,
      status: queueResult.status,
      queuePosition: queueResult.queuePosition,
      expiresAt: queueResult.expiresAt,
      message: 'Previous sessions terminated. New payment session activated and bound to this device.'
    });
  }

  server.post('/api/v1/checkout/:id/end-and-restart-payment', handleEndAndRestartPayment);
  server.post('/api/v1/checkout/:id/end-session-and-create-new', handleEndAndRestartPayment);

  // GET /api/v1/checkout/:id/stream and /events (SSE)
  server.get('/api/v1/checkout/:id/stream', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: 'Session not found' });
      return;
    }
    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }
    server.initSse(params.id, res);
  });

  server.get('/api/v1/checkout/:id/events', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: 'Session not found' });
      return;
    }
    const deviceAccess = checkSessionDeviceAccess(session, req, null, ctx);
    if (!deviceAccess.allowed) {
      HttpServer.json(res, deviceAccess.statusCode || 409, deviceAccess.body);
      return;
    }
    server.initSse(params.id, res);
  });
}
