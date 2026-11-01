# Fins & Wings manual UPI integration

This integration uses the YOUPI checkout to display a UPI QR. The customer submits a UTR as a claim. The Fins & Wings admin must compare it with the receiving bank account and make the final decision. A UTR, QR scan, browser callback, observer alert, or signed gateway webhook is not proof of settlement.

## Request and authority flow

1. The Fins & Wings server creates the order in Supabase. It gets the amount from the database order result, then creates a YOUPI session using `method: MANUAL_UPI`, a stable idempotency key, merchant ID, and the server-only merchant API key.
2. YOUPI returns a checkout URL. The browser opens that URL; the merchant key is never sent to the browser.
3. The customer pays in their UPI app and submits their transaction reference in the gateway checkout.
4. YOUPI records `MANUAL_REVIEW` and sends a signed webhook containing the UTR. The Supabase webhook RPC links the event to the exact payment attempt and amount, records the UTR, and leaves the order `pending_verification`.
5. An authenticated Fins & Wings administrator checks the actual receiving account and enters evidence in the admin app. `fw_set_payment_status` atomically records `verified`, `rejected`, or `under_investigation`; a rejection requires a reason.
6. Order fulfilment remains blocked until the admin RPC records `verified` and stock is confirmed.

The `customer_order_hash` capability must remain private to the customer device. The webhook secret and YOUPI merchant API key are different secrets and are server-side only. Rotate the API key through the gateway admin after initial setup and configure the rotated value as `YOUPI_MERCHANT_API_KEY`.

## Server environment

Set these in the customer server environment (Vercel functions or the local server), not in `VITE_*` variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `YOUPI_API_URL`
- `YOUPI_MERCHANT_ID`
- `YOUPI_MERCHANT_API_KEY`
- `YOUPI_WEBHOOK_SECRET`
- `CUSTOMER_RETURN_URL`

On YOUPI, set `YOUPI_ALLOWED_RETURN_ORIGINS` and `YOUPI_ALLOWED_ORIGINS` to the exact HTTPS storefront origin(s), comma separated. The return origin must exactly match `CUSTOMER_RETURN_URL`'s origin. No wildcard is supported. The checkout iframe must also be allowed by the checkout portal frame-ancestor configuration.

Apply Supabase migrations in order, including `008_youpi_pg.sql` and `009_youpi_manual_review.sql`, only after reviewing them against the actual project schema. This repository change does not apply migrations to a live Supabase project.

## Status contract

| Gateway | Supabase order | Meaning |
| --- | --- | --- |
| `INITIATED`, `ACTIVE` | `pending_verification` | Checkout opened / awaiting customer payment |
| `MANUAL_REVIEW` | `pending_verification` | Customer submitted a UTR; admin must inspect bank records |
| `FAILED`, `EXPIRED`, `CANCELLED` | unchanged pending status | Attempt ended; this is not a final bank decision |
| Any gateway `SUCCESS`, `OBSERVED_SUCCESS`, or `RECONCILED` | unchanged pending status | Gateway event cannot approve this manual flow |
| Admin `under_investigation` | `under_investigation` | Admin is collecting evidence |
| Admin `verified` / `rejected` | final order decision | Admin decision after bank review |

Retrying a final rejected, verified, or refunded order is blocked. A pending attempt may be retried after it expires or fails.

## Local checks

Use synthetic orders and a test bank/UPI account only. Never treat checkout redirect parameters or client-side events as payment status. Confirm the admin sees the customer UTR and gateway payment ID and that the order remains pending until the RPC succeeds.
