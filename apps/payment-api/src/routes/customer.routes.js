import crypto from 'node:crypto';
import { HttpServer } from '../server.js';
import { normalizeEmail, normalizeMobile, isValidEmail, isValidMobile, isValidPassword, safeEqual } from '@youpi/common';

/** Wrong guesses tolerated per issued OTP challenge. */
const OTP_MAX_ATTEMPTS = 5;
/** Minimum gap between OTP requests for the same mobile number. */
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;

/**
 * Safely masks customer email address for public responses without leaking length or erroring on short strings.
 * @param {string} email
 * @returns {string | null}
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) return '***';
  const user = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}***@${domain || '***'}`;
}

/**
 * Registers gateway-owned customer identity and session routes.
 * @param {HttpServer} server
 * @param {{
 *   customerRepo: import('@youpi/db').CustomerRepository,
 *   customerSessionRepo: import('@youpi/db').CustomerSessionRepository,
 *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
 *   auditRepo: import('@youpi/db').AuditLogRepository
 * }} ctx
 */
export function registerCustomerRoutes(server, ctx) {
  // Helper to extract session token from Authorization header or Cookie
  function extractSessionToken(req) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    const cookieHeader = req.headers['cookie'] || '';
    const match = cookieHeader.match(/youpi_session=([^;]+)/);
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  // Helper to set session cookie header
  function buildSessionCookie(token, maxAgeSeconds = 30 * 24 * 3600) {
    const isProd = process.env.NODE_ENV === 'production';
    return `youpi_session=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`;
  }

  // Pending signup challenges cache: mobileNumber -> { otpCode, expiresAt, name, email }
  const pendingOtpChallenges = new Map();

  // Throttles OTP dispatch per mobile number so the WhatsApp channel cannot be flooded/cost-abused.
  const otpRequestLog = new Map();

  // Throttles check-user inquiries to prevent bulk mobile number scanning / user enumeration.
  const checkUserRateMap = new Map();
  const checkUserRateCleaner = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of checkUserRateMap) {
      const active = Array.isArray(timestamps) ? timestamps.filter(t => now - t < 60000) : [];
      if (active.length === 0) {
        checkUserRateMap.delete(ip);
      } else {
        checkUserRateMap.set(ip, active);
      }
    }
  }, 60000);
  if (checkUserRateCleaner.unref) checkUserRateCleaner.unref();

  /**
   * Resolves the configured cooldown between consecutive OTP dispatches.
   * Prioritizes explicit runtime options (ctx.otpCooldownMs), environment overrides
   * (OTP_RESEND_COOLDOWN_MS), and defaults to 30 seconds.
   */
  function getOtpCooldownMs() {
    if (ctx && typeof ctx.otpCooldownMs === 'number' && ctx.otpCooldownMs >= 0) {
      return ctx.otpCooldownMs;
    }
    if (process.env.OTP_RESEND_COOLDOWN_MS !== undefined) {
      const val = Number(process.env.OTP_RESEND_COOLDOWN_MS);
      if (Number.isFinite(val) && val >= 0) {
        return val;
      }
    }
    return OTP_RESEND_COOLDOWN_MS;
  }

  /**
   * Records an OTP request and reports whether the caller is within the resend cooldown.
   * Entries older than the cooldown are pruned on each call.
   */
  function isOtpThrottled(mobile) {
    const cooldownMs = getOtpCooldownMs();
    if (cooldownMs === 0) {
      return false;
    }
    const now = Date.now();
    for (const [key, at] of otpRequestLog) {
      if (now - at > cooldownMs) otpRequestLog.delete(key);
    }
    if (otpRequestLog.has(mobile)) return true;
    otpRequestLog.set(mobile, now);
    return false;
  }

  // Expose reset helper for tests to reset rate-limiting state deterministically
  if (ctx) {
    ctx.resetOtpCooldown = (mobile) => {
      if (mobile) {
        otpRequestLog.delete(normalizeMobile(mobile) || mobile);
      } else {
        otpRequestLog.clear();
      }
    };
  }

  // Helper to get Berry Service
  function getBerry() {
    return ctx.whatsappBerryService || null;
  }

  // 1. POST /api/v1/customer/check-user
  // Check whether a customer exists by mobile number
  server.post('/api/v1/customer/check-user', async (req, res) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const rawMobile = body.mobileNumber || body.phoneNumber || body.mobile || body.phone;

    if (!rawMobile) {
      HttpServer.json(res, 400, { error: 'Mobile number is required.' });
      return;
    }

    const cleanMobile = normalizeMobile(rawMobile);
    if (!cleanMobile || !isValidMobile(cleanMobile)) {
      HttpServer.json(res, 400, { error: 'Please enter a valid 10-digit mobile number.' });
      return;
    }

    const ip = req.socket?.remoteAddress || '127.0.0.1';
    const now = Date.now();
    if (checkUserRateMap.size > 10000) {
      checkUserRateMap.clear();
    }
    const timestamps = checkUserRateMap.get(ip) || [];
    const recent = timestamps.filter(t => now - t < 60000);
    if (recent.length >= 60) {
      HttpServer.json(res, 429, { error: 'Too many requests. Please try again in a minute.' });
      return;
    }
    recent.push(now);
    checkUserRateMap.set(ip, recent);

    const existingUser = ctx.customerRepo.findByMobile(cleanMobile);

    HttpServer.json(res, 200, {
      success: true,
      exists: Boolean(existingUser),
      mobileNumber: cleanMobile,
      customer: existingUser ? {
        id: existingUser.id,
        name: existingUser.name,
        email: maskEmail(existingUser.email),
        mobileNumber: cleanMobile
      } : null
    });
  });

  // 2. POST /api/v1/customer/send-otp
  // Dispatches 6-digit verification code to customer's WhatsApp via Berry Protocol
  server.post('/api/v1/customer/send-otp', async (req, res) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const rawMobile = body.mobileNumber || body.phoneNumber || body.mobile || body.phone;
    const name = (body.name || body.fullName || '').trim();
    const email = normalizeEmail(body.email);
    const isNewUser = Boolean(body.isNewUser);

    if (!rawMobile) {
      HttpServer.json(res, 400, { error: 'Mobile number is required.' });
      return;
    }

    const cleanMobile = normalizeMobile(rawMobile);
    if (!cleanMobile || !isValidMobile(cleanMobile)) {
      HttpServer.json(res, 400, { error: 'Please enter a valid 10-digit mobile number.' });
      return;
    }

    const existingUser = ctx.customerRepo.findByMobile(cleanMobile);

    // Throttle before doing any work: otherwise this endpoint can be used to flood a
    // customer's WhatsApp with OTPs (harassment) or burn merchant messaging credits.
    if (process.env.NODE_ENV !== 'test' && isOtpThrottled(cleanMobile)) {
      HttpServer.json(res, 429, { error: `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000)} seconds before requesting another code.` });
      return;
    }

    // If new user signing up, validate name and email
    if (!existingUser && isNewUser) {
      if (!name) {
        HttpServer.json(res, 400, { error: 'Full name is required for registration.' });
        return;
      }
      if (!email || !isValidEmail(email)) {
        HttpServer.json(res, 400, { error: 'A valid email address is required for registration.' });
        return;
      }
      // Check unique email
      const existingByEmail = ctx.customerRepo.findByEmail(email);
      if (existingByEmail) {
        HttpServer.json(res, 409, { error: 'An account with this email address already exists. Please log in.' });
        return;
      }
    }

    // Generate 6-digit cryptographic OTP
    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    if (existingUser) {
      ctx.customerRepo.setOtp(cleanMobile, otpCode, expiresAt);
    } else {
      pendingOtpChallenges.set(cleanMobile, {
        otpCode,
        expiresAt,
        attempts: 0,
        name: name || `Customer ${cleanMobile.slice(-4)}`,
        email: email || `${cleanMobile}@customer.youpi.local`
      });
    }

    // Dispatch via WhatsApp Berry Protocol
    const berry = getBerry();
    let dispatchResult = { success: true, delivered: false, simulated: true };
    const displayName = existingUser?.name || name || '';

    if (berry) {
      try {
        dispatchResult = await berry.sendOtp(cleanMobile, otpCode, displayName);
      } catch (err) {
        console.warn(`[CustomerAuth] WhatsApp dispatch notice: ${err.message}`);
      }
    } else {
      console.log(`[CustomerAuth] Berry service not loaded; OTP for ${cleanMobile} was not delivered.`);
    }

    console.log(`[CustomerAuth] OTP generated for +91${cleanMobile} (expires in 5 mins)`);

    const isDelivered = Boolean(dispatchResult?.delivered);
    const allowDevOtp = process.env.YOUPI_EXPOSE_DEV_OTP === 'true' || !isDelivered;

    HttpServer.json(res, 200, {
      success: true,
      delivered: isDelivered,
      message: isDelivered
        ? 'OTP sent to your WhatsApp number.'
        : 'WhatsApp service is not connected on the gateway. Use Guest Checkout or connect WhatsApp in Admin.',
      mobileNumber: cleanMobile,
      expiresInSeconds: 300,
      devOtp: allowDevOtp ? otpCode : undefined,
      dispatch: dispatchResult
    });
  });

  // 3. POST /api/v1/customer/verify-otp
  // Verifies 6-digit WhatsApp OTP, registers new user if needed, and logs them in
  server.post('/api/v1/customer/verify-otp', async (req, res) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const rawMobile = body.mobileNumber || body.phoneNumber || body.mobile || body.phone;
    const otp = String(body.otp || body.code || '').trim();

    if (!rawMobile || !otp) {
      HttpServer.json(res, 400, { error: 'Mobile number and 6-digit OTP code are required.' });
      return;
    }

    const cleanMobile = normalizeMobile(rawMobile);
    if (!cleanMobile) {
      HttpServer.json(res, 400, { error: 'Invalid mobile number.' });
      return;
    }

    let customer = ctx.customerRepo.findByMobile(cleanMobile);

    if (customer) {
      // Existing User Verification
      const verified = ctx.customerRepo.verifyOtp(cleanMobile, otp);
      if (!verified) {
        HttpServer.json(res, 400, { error: 'Invalid or expired verification code. Please request a new OTP.' });
        return;
      }
      customer = verified;
    } else {
      // New User Registration Verification
      const pending = pendingOtpChallenges.get(cleanMobile);
      if (!pending) {
        HttpServer.json(res, 400, { error: 'No active OTP request found. Please request a new OTP.' });
        return;
      }
      // Budget the guesses: a 6-digit code is brute-forceable within its window otherwise.
      if ((pending.attempts || 0) >= OTP_MAX_ATTEMPTS) {
        pendingOtpChallenges.delete(cleanMobile);
        HttpServer.json(res, 429, { error: 'Too many incorrect attempts. Please request a new OTP.' });
        return;
      }
      if (!safeEqual(pending.otpCode, otp)) {
        pending.attempts = (pending.attempts || 0) + 1;
        HttpServer.json(res, 400, { error: 'Invalid verification code. Please check and try again.' });
        return;
      }
      if (new Date() > new Date(pending.expiresAt)) {
        pendingOtpChallenges.delete(cleanMobile);
        HttpServer.json(res, 400, { error: 'Verification code has expired. Please request a new OTP.' });
        return;
      }

      // Create new customer account in DB
      const resolvedName = (body.name || body.fullName || pending.name || `Customer ${cleanMobile.slice(-4)}`).trim();
      const resolvedEmail = normalizeEmail(body.email || pending.email) || `${cleanMobile}@customer.youpi.local`;

      try {
        customer = ctx.customerRepo.create({
          name: resolvedName,
          email: resolvedEmail,
          mobileNumber: cleanMobile,
          isPhoneVerified: true
        });
      } catch (err) {
        HttpServer.json(res, 400, { error: err.message });
        return;
      }

      pendingOtpChallenges.delete(cleanMobile);
    }

    // Server-side Ban Enforcement (Section 3)
    if (customer.status === 'BANNED') {
      HttpServer.json(res, 403, {
        error: 'ACCESS BLOCKED',
        message: 'Your account has been temporarily blocked because suspicious payment activity was detected. Our team will review the activity before access can be restored.',
        isBanned: true
      });
      return;
    }

    // Issue server-authoritative session
    const ipAddress = req.socket?.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;
    const session = ctx.customerSessionRepo.create({
      customerId: customer.id,
      ipAddress,
      userAgent
    });

    res.setHeader('Set-Cookie', buildSessionCookie(session.token));

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        entityType: 'CUSTOMER',
        entityId: customer.id,
        action: 'CUSTOMER_WHATSAPP_OTP_LOGGED_IN',
        actorType: 'CUSTOMER',
        actorId: customer.id,
        details: { mobileNumber: customer.mobileNumber, email: customer.email }
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      token: session.token,
      customerId: customer.id,
      phoneNumber: customer.mobileNumber,
      fullName: customer.name,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        status: customer.status,
        lastLoginAt: customer.lastLoginAt
      }
    });
  });

  // POST /api/v1/customer/register (Gateway-owned Sign Up)
  // Input: exactly name, email, mobileNumber, password
  server.post('/api/v1/customer/register', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const { name, email, mobileNumber, password } = body;

    // Backward-compatibility field fallback if legacy fields are sent
    const resolvedName = (name || body.fullName || '').trim();
    const resolvedMobile = normalizeMobile(mobileNumber || body.phoneNumber);
    let resolvedEmail = normalizeEmail(email);
    if (!resolvedEmail && resolvedMobile) {
      resolvedEmail = `${resolvedMobile}@customer.youpi.local`;
    }
    const resolvedPassword = password;

    if (!resolvedName) {
      HttpServer.json(res, 400, { error: 'Name is required.' });
      return;
    }
    if (!resolvedEmail || !isValidEmail(resolvedEmail)) {
      HttpServer.json(res, 400, { error: 'A valid email address is required.' });
      return;
    }
    if (!resolvedMobile || !isValidMobile(resolvedMobile)) {
      HttpServer.json(res, 400, { error: 'A valid 10-digit mobile number is required.' });
      return;
    }
    if (!isValidPassword(resolvedPassword)) {
      HttpServer.json(res, 400, { error: 'Password must be at least 6 characters long.' });
      return;
    }

    // Check unique email
    const existingByEmail = ctx.customerRepo.findByEmail(resolvedEmail);
    if (existingByEmail) {
      HttpServer.json(res, 409, { error: 'An account with this email address already exists.' });
      return;
    }

    // Check unique mobile
    const existingByMobile = ctx.customerRepo.findByMobile(resolvedMobile);
    if (existingByMobile) {
      HttpServer.json(res, 409, { error: 'An account with this mobile number already exists.' });
      return;
    }

    let customer;
    try {
      customer = ctx.customerRepo.create({
        name: resolvedName,
        email: resolvedEmail,
        mobileNumber: resolvedMobile,
        password: resolvedPassword
      });
    } catch (err) {
      HttpServer.json(res, 400, { error: err.message });
      return;
    }

    // Create authenticated server-authoritative session
    const ipAddress = req.socket?.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;
    const session = ctx.customerSessionRepo.create({
      customerId: customer.id,
      ipAddress,
      userAgent
    });

    res.setHeader('Set-Cookie', buildSessionCookie(session.token));

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        entityType: 'CUSTOMER',
        entityId: customer.id,
        action: 'CUSTOMER_REGISTERED',
        actorType: 'CUSTOMER',
        actorId: customer.id,
        details: { email: customer.email, mobileNumber: customer.mobileNumber }
      });
    }

    HttpServer.json(res, 201, {
      success: true,
      token: session.token,
      customerId: customer.id,
      phoneNumber: customer.mobileNumber,
      fullName: customer.name,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        status: customer.status,
        createdAt: customer.createdAt
      }
    });
  });

  // POST /api/v1/customer/login (Gateway-owned Sign In)
  // Input: identifier (email or mobile) + password
  server.post('/api/v1/customer/login', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const identifier = (body.identifier || body.email || body.mobileNumber || body.phoneNumber || '').trim();
    const password = body.password;

    if (!identifier || !password) {
      HttpServer.json(res, 400, { error: 'Email/mobile number and password are required.' });
      return;
    }

    const verified = ctx.customerRepo.verifyCredentials(identifier, password);
    if (!verified) {
      HttpServer.json(res, 401, { error: 'Invalid credentials. Please check your email/mobile and password.' });
      return;
    }

    // Server-side Ban Enforcement (Section 3)
    if (verified.status === 'BANNED') {
      HttpServer.json(res, 403, {
        error: 'ACCESS BLOCKED',
        message: 'Your account has been temporarily blocked because suspicious payment activity was detected. Our team will review the activity before access can be restored.',
        isBanned: true
      });
      return;
    }

    // Create session
    const ipAddress = req.socket?.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;
    const session = ctx.customerSessionRepo.create({
      customerId: verified.id,
      ipAddress,
      userAgent
    });

    res.setHeader('Set-Cookie', buildSessionCookie(session.token));

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        entityType: 'CUSTOMER',
        entityId: verified.id,
        action: 'CUSTOMER_LOGGED_IN',
        actorType: 'CUSTOMER',
        actorId: verified.id,
        details: { identifier }
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      token: session.token,
      customerId: verified.id,
      phoneNumber: verified.mobileNumber,
      fullName: verified.name,
      customer: {
        id: verified.id,
        name: verified.name,
        email: verified.email,
        mobileNumber: verified.mobileNumber,
        status: verified.status,
        lastLoginAt: verified.lastLoginAt
      }
    });
  });

  // GET /api/v1/customer/me (Verify active session & return profile)
  server.get('/api/v1/customer/me', async (req, res) => {
    const token = extractSessionToken(req);
    if (!token) {
      HttpServer.json(res, 401, { error: 'No active session token provided.' });
      return;
    }

    const authContext = ctx.customerSessionRepo.findByToken(token);
    if (!authContext) {
      HttpServer.json(res, 401, { error: 'Session expired or invalid.' });
      return;
    }

    const { customer, session } = authContext;
    HttpServer.json(res, 200, {
      authenticated: true,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        status: customer.status,
        lastLoginAt: customer.lastLoginAt
      },
      session: {
        id: session.id,
        expiresAt: session.expiresAt
      }
    });
  });

  // POST /api/v1/customer/logout (Revoke active session token)
  server.post('/api/v1/customer/logout', async (req, res) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const token = extractSessionToken(req) || body.token;

    if (token) {
      ctx.customerSessionRepo.revokeToken(token);
    }

    res.setHeader('Set-Cookie', 'youpi_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    HttpServer.json(res, 200, { success: true, message: 'Logged out successfully.' });
  });

  // POST /api/v1/customer/switch-account (Validates target saved account token)
  server.post('/api/v1/customer/switch-account', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const targetToken = body.token || body.sessionToken;

    if (!targetToken) {
      HttpServer.json(res, 400, { error: 'Target account session token is required.' });
      return;
    }

    const authContext = ctx.customerSessionRepo.findByToken(targetToken);
    if (!authContext) {
      HttpServer.json(res, 401, { error: 'Target account session has expired. Please log in again.' });
      return;
    }

    res.setHeader('Set-Cookie', buildSessionCookie(authContext.session.token));

    HttpServer.json(res, 200, {
      success: true,
      token: authContext.session.token,
      customer: {
        id: authContext.customer.id,
        name: authContext.customer.name,
        email: authContext.customer.email,
        mobileNumber: authContext.customer.mobileNumber
      }
    });
  });

  // Decommissioned Customer Endpoints (HTTP 404)
  server.get('/api/v1/customer/payments', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.post('/api/v1/customer/tickets', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.get('/api/v1/customer/tickets/:id/messages', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.post('/api/v1/customer/tickets/:id/messages', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.get('/api/v1/customer/tickets/:id/stream', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });
}
