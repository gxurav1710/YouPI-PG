import { getAdminToken, getObserverToken, safeEqual, hasBearer } from '@youpi/common';
import { HttpServer } from './server.js';

/** Admin-prefixed routes that are intentionally public (static APK download for pairing). */
const PUBLIC_ADMIN_PATHS = new Set(['/api/v1/admin/sms-gateway/download-apk']);

/** Admin-prefixed routes the local observer processes call with the observer token. */
const OBSERVER_ADMIN_PATHS = new Set(['/api/v1/admin/gmail/credentials']);

function bearerToken(req) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

function isDevTool(pathname) {
  return pathname.startsWith('/api/v1/admin/dev/') || /^\/api\/v1\/checkout\/[^/]+\/simulate-observation$/.test(pathname);
}

/**
 * Decides which credential a request needs.
 * @returns {null | 'admin' | 'observer'} null = public, 'observer' = admin OR observer token
 */
function requiredLevel(method, pathname) {
  if (pathname.startsWith('/api/v1/admin/')) {
    if (PUBLIC_ADMIN_PATHS.has(pathname)) return null;
    if (OBSERVER_ADMIN_PATHS.has(pathname)) return 'observer';
    return 'admin';
  }
  if (method === 'POST' && pathname === '/api/v1/pollers/events') return 'observer';
  if (method === 'GET' && pathname === '/api/v1/pollers/active-window') return 'observer';
  // Injects a synthetic bank message into the real verification pipeline.
  if (method === 'POST' && /^\/api\/v1\/checkout\/[^/]+\/simulate-observation$/.test(pathname)) return 'admin';
  return null;
}

/**
 * Guard for HttpServer.use(). Admin credential = ADMIN_API_TOKEN (or data/.secrets/admin_api_token).
 * Observer credential = OBSERVER_API_TOKEN (or data/.secrets/observer_api_token); admin token also satisfies it.
 */
export function authGuard(req, res, pathname, url) {
  const method = req.method.toUpperCase();

  // Developer simulators push synthetic bank messages into the real pipeline and can settle live sessions.
  if (method !== 'GET' && isDevTool(pathname) && process.env.NODE_ENV === 'production' && process.env.YOUPI_ALLOW_DEV_TOOLS !== 'true') {
    HttpServer.json(res, 403, { error: 'Developer tools are disabled in production.', code: 'DEV_TOOLS_DISABLED' });
    return true;
  }

  const level = requiredLevel(method, pathname);
  if (!level) return false;

  // The token is only ever accepted from the Authorization header. Accepting it from a
  // query parameter put an admin credential into access logs, browser history and Referer
  // headers; the admin dashboard now opens its streams with fetch() so the credential
  // travels in the header only.
  const presented = bearerToken(req);

  const isBearerOk = presented && (
    safeEqual(presented, getAdminToken()) ||
    (level === 'observer' && safeEqual(presented, getObserverToken()))
  );

  // If level is observer and an X-Device-Id is presented, pass to route handler for device verification
  const deviceId = req.headers['x-device-id'];
  const isDeviceRequest = level === 'observer' && Boolean(deviceId);

  if (isBearerOk || isDeviceRequest) return false;

  HttpServer.json(res, 401, { error: 'Unauthorized', code: 'AUTH_REQUIRED' });
  return true;
}

/** True only when the request carries the admin token (observer token is not enough). */
export function isAdminRequest(req) {
  const presented = bearerToken(req);
  return Boolean(presented) && safeEqual(presented, getAdminToken());
}

/**
 * True when the caller may read the merchant-private fields of a payment session.
 *
 * Requires proof of ownership: either the gateway's own admin/observer credential, or the
 * owning merchant's webhook secret presented via `X-Merchant-Key` (which every merchant
 * integration already holds). Without it, only the public view is returned, so a leaked or
 * guessed payment id cannot be used to read internal status, verification internals,
 * merchant metadata or the return URL.
 */
export function isPaymentOwner(req, session, ctx) {
  if (isAdminRequest(req)) return true;
  if (hasBearer(req, getObserverToken())) return true;

  const presented = req.headers['x-merchant-key'];
  if (!presented || typeof presented !== 'string' || !presented.trim()) return false;

  const merchant = ctx.merchantRepo?.findById ? ctx.merchantRepo.findById(session.merchantId) : null;
  if (!merchant) return false;
  if (typeof ctx.merchantRepo?.verifyApiKey === 'function') {
    return ctx.merchantRepo.verifyApiKey(merchant, presented.trim());
  }
  return false;
}
