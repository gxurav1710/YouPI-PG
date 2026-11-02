# Configuration & Secret Management Guide

## 1. Environment Parameters Reference

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Runtime environment (`development` or `production`) |
| `CONTROL_CENTER_PORT` | `8090` | Host port for the Local Process Supervisor |
| `PAYMENT_API_PORT` | `6100` | Host port for the central Payment Core REST API |
| `CHECKOUT_PORTAL_PORT` | `7000` | Host port for the customer-facing Checkout page |
| `MERCHANT_ADMIN_PORT` | `6001` | Host port for the Merchant Admin Dashboard |
| `HELP_PORTAL_PORT` | `3000` | Host port for the Customer Payment Help Portal |
| `GMAIL_OBSERVER_PORT` | `6003` | Host port for the Gmail Polling Service & OAuth Callback |
| `SMS_OBSERVER_PORT` | `6002` | Host port for the Google Messages / SMS Web Automator |
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection URL |
| `USE_SQLITE_FALLBACK` | `true` | When true, uses embedded SQLite if PostgreSQL is unreachable |
| `SQLITE_DB_PATH` | `./data/youpi_pg.sqlite`| Path to local SQLite database file |
| `ENCRYPTION_MASTER_KEY` | `64-hex chars` | 256-bit key for encrypting OAuth credentials and device keys |
| `JWT_SECRET` | `32+ chars` | Secret key for customer and admin session tokens |
| `PAYMENT_ACTIVE_WINDOW_MS` | `300000` | Duration of active payment slot (5 minutes = 300,000ms) |
| `PAYMENT_PROCESSING_WINDOW_MS` | `30000` | Duration of verification slot (30 seconds = 30,000ms) |
| `LATE_OBSERVATION_WINDOW_MS` | `1800000` | Safety window for matching late observations (30 minutes) |
| `ANDROID_ENROLLMENT_SECRET` | auto-generated | Secret used to authorize device QR pairing. If unset, a random value is created in `data/.secrets/android_enrollment_secret` |
| `ADMIN_API_TOKEN` | auto-generated | Bearer token required by `/api/v1/admin/*` (the Merchant Admin page asks for it once per tab). If unset, a random value is created in `data/.secrets/admin_api_token` |
| `OBSERVER_API_TOKEN` | auto-generated | Bearer token the local Gmail/SMS observers use to submit observations (`data/.secrets/observer_api_token`) |
| `COIN_STORE_WEBHOOK_SECRET` | auto-generated | Webhook secret seeded for the default merchant and used by the demo coin store (`data/.secrets/coin_store_webhook_secret`) |
| `YOUPI_EXPOSE_DEV_OTP` | unset | Set to `true` for local development to get the OTP in the `send-otp` response. Ignored when `NODE_ENV=production` |
| `YOUPI_ALLOW_DEV_TOOLS` | unset | Developer test-mode / simulator endpoints (`/admin/dev/*`, `simulate-observation`) are refused when `NODE_ENV=production` unless this is `true` |
| `GMAIL_REDIRECT_URI` | derived | Gmail OAuth redirect URI. Defaults to `<gmail host from your configured domain>/oauth/callback` |
| `ANDROID_HEARTBEAT_TIMEOUT_MS` | `180000` | Inactivity window before Android device is marked DISCONNECTED |
| `CHECKOUT_FRAME_ANCESTORS` | unset (any origin in development, `'self'` in production) | Merchant origins (comma or space separated, e.g. `https://shop.example.com`) allowed to embed `/checkout/:id`. The `youpi.js` modal is an iframe, so a store on a different origin than the checkout portal must be listed here or the browser blocks the modal. When unset, any site may frame the checkout page in development, while a production deployment (either `NODE_ENV=production` or `YOUPI_MODE=production`) fences the page to its own origin. Only bare `http(s)` origins are accepted — a path, query, embedded credential or wildcard is ignored, so the value cannot widen the CSP or inject another directive |
| `YOUPI_ALLOW_PRIVATE_WEBHOOKS` | unset | Set to `true` to permit merchant webhook URLs on loopback/private networks. Required for self-hosted LAN targets; blocked by default as an SSRF guard |
| `WEBHOOK_OUTBOX_BATCH_SIZE` | `20` | Maximum number of outbox webhooks to dispatch per recovery sweep |
| `WEBHOOK_MISSING_BATCH_SIZE` | `100` | Maximum number of missing webhook delivery rows to backfill per recovery sweep |
| `WEBHOOK_RECOVERY_SCAN_BUDGET` | `500` | Candidate traversal scan budget per recovery sweep to prevent starvation behind invalid endpoints |
| `WEBHOOK_RECOVERY_CHUNK_SIZE` | `50` | Candidate chunk size per database query during recovery traversal |
| `DEFAULT_APP_NAME` | `YOUPI PG` | Gateway application name displayed in checkout, merchant admin, and transaction notifications |
| `DEFAULT_PRIMARY_COLOR` | `#2563eb` | Default primary brand color (hex) across customer checkout pages |
| `DEFAULT_SUPPORT_EMAIL` | `support@youpi.local` | Default support email rendered on customer help modal and receipts |
| `DEFAULT_SUPPORT_PHONE` | `9876543210` | Default customer helpline phone number |
| `DEFAULT_LOGO_URL` | unset (monogram) | Default brand logo image URL for customer checkout portal |
| `DEFAULT_TRUST_BADGE_TEXT` | unset | Custom trust badge label (e.g. `${DEFAULT_APP_NAME} Verified Business`) |
| `DEFAULT_FOOTER_GUARANTEE` | unset | Custom customer protection guarantee text in checkout footer |
| `DEFAULT_HIDE_POWERED_BY` | `false` | When `true`, completely hides gateway branding from checkout page |
| `WHATSAPP_SENDER_NAME` | unset | Custom sender label prepended to WhatsApp login OTP messages |
| `DEFAULT_MERCHANT_NAME` | `YOUPI Demo Store` | Initial merchant business name seeded on first database boot |
| `DEFAULT_MERCHANT_SLUG` | `demo-store` | Initial merchant slug seeded on first database boot |

---

## 1a. `returnUrl` requirements

`POST /api/v1/payments` accepts a `returnUrl` that is echoed back to the customer's
browser as a redirect target after the payment completes, so the gateway stores only
**absolute** `http:` / `https:` URLs. A relative value, a `javascript:` URL or any other
scheme is rejected with `400`.

The official SDK resolves a relative `data-success-url` (for example `/success`) against
the storefront's own origin before sending it, so relative storefront paths keep working
without any change to merchant code. If you call the API directly, send an absolute URL.

---

## 1b. Merchant API Authentication (`X-Merchant-Key`)

Endpoints that expose merchant-private or customer-contact data require the caller to
prove which merchant it is. There are three accepted credentials:

| Credential | Header | Grants |
| :--- | :--- | :--- |
| Merchant webhook secret | `X-Merchant-Key: <merchant webhook secret>` | Full merchant-private view of that merchant's own sessions: `metadata`, `internalStatus`, `verificationLevel` / `verificationSources` / `verificationTag`, `returnUrl`, and customer contact details |
| Admin bearer token | `Authorization: Bearer <ADMIN_API_TOKEN>` | Full access to every merchant's data (operator tooling) |
| Observer bearer token | `Authorization: Bearer <OBSERVER_API_TOKEN>` | Full access to every merchant's data (local observer processes) |

Affected routes: `GET /api/v1/payments/:id`, `GET /api/v1/payments/:id/cod`,
`GET /api/v1/orders/:orderId/cod` and `GET /api/v1/checkout/:id/state`.

### On `POST /api/v1/payments`

`X-Merchant-Key` is **optional** here, and the request is refused with
`401 MISSING_MERCHANT_KEY` only when it names a merchant other than the gateway's
default one. The public one-script integration (the browser SDK) cannot carry a
merchant secret — a secret in browser JavaScript is public — so the default-merchant
path has to stay open. Use `X-Merchant-Key` (or `X-Order-Token`) whenever a request
targets a specific tenant, and reuse an `orderId` only with the same amount: a
mismatch is rejected with `409 ORDER_AMOUNT_MISMATCH`.

`autoActivate: true` is restricted to admin-authenticated requests or to
`NODE_ENV=test`; elsewhere it is refused with `403 AUTOACTIVATE_FORBIDDEN`.

**Without a credential these routes return a redacted public view** — status, amount,
currency, method and order id only. Customer name, email and phone number are never
disclosed to an anonymous caller that merely holds a payment id.

The official SDK sends `X-Merchant-Key` automatically when the merchant secret is
configured, so existing integrations receive the full view with no code change:

```javascript
const client = new YoupiPaymentClient({
  apiUrl: 'https://pay-api.example.com',
  merchantId: '00000000-0000-0000-0000-000000000001',
  webhookSecret: 'your-merchant-webhook-secret'   // enables the merchant-scoped view
});
```

A customer browsing the checkout page sees their own profile because the checkout client
sends the customer session token (`x-customer-token`), not because the payment id is
enough to unlock it.

---

## 2. Cryptographic Secret Generation

Generate strong 256-bit encryption and HMAC keys using Node.js native crypto:

```bash
# Generate 256-bit Master Key (64 hex characters)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Never commit production `.env` files to source code repositories.
