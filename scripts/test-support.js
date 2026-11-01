/**
 * Shared test credentials. Importing this module sets the env vars the services read lazily,
 * so in-process servers started by tests accept the tokens below.
 */
export const TEST_ADMIN_TOKEN = 'test-admin-token-0123456789abcdef0123456789abcdef';
export const TEST_OBSERVER_TOKEN = 'test-observer-token-0123456789abcdef0123456789abcd';

process.env.ADMIN_API_TOKEN = TEST_ADMIN_TOKEN;
process.env.OBSERVER_API_TOKEN = TEST_OBSERVER_TOKEN;
// Lets the OTP suites read the code from the response instead of WhatsApp.
process.env.YOUPI_EXPOSE_DEV_OTP = 'true';
// Webhook suites deliver to a local mock receiver on loopback, which the SSRF guard blocks by default.
process.env.YOUPI_ALLOW_PRIVATE_WEBHOOKS = 'true';

/** Admin bearer header, optionally merged with extra headers. */
export function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, ...extra };
}

/** fetch() that carries the admin bearer token on guarded routes (caller headers win). */
export function authFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { ...authHeadersFor(url), ...(init.headers || {}) } });
}

const GUARDED = /\/api\/v1\/admin\/|\/api\/v1\/pollers\/events|\/api\/v1\/pollers\/active-window|\/simulate-observation|\/api\/v1\/payments(\?|$)/;

/** Admin bearer header only for routes the gateway guards; other routes (customer auth etc.) get none. */
export function authHeadersFor(path, extra = {}) {
  if (!GUARDED.test(String(path))) return { ...extra };
  const merchantForPaymentCreation = /\/api\/v1\/payments(?:\?|$)/.test(String(path))
    ? { 'X-Merchant-Id': '00000000-0000-0000-0000-000000000001' }
    : {};
  return authHeaders({ ...merchantForPaymentCreation, ...extra });
}

/**
 * Merchant-scoped header proving ownership of a payment session. `GET /api/v1/payments/:id`
 * only returns merchant-private fields (metadata, verification internals, internalStatus)
 * to a caller presenting the owning merchant's webhook secret.
 */
export function merchantHeaders(webhookSecret, extra = {}) {
  return { 'X-Merchant-Key': webhookSecret, ...extra };
}
