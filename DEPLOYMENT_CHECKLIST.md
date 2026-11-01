# Deployment checklist — Fins & Wings manual UPI

Deployment is intentionally not performed as part of this change.

## Before any real payment

- [ ] Keep this gateway out of production until the unresolved items in `SECURITY_REMEDIATION_REPORT.md` are reviewed and signed off.
- [ ] Use a persistent, backed-up database. `render.yaml` currently selects a free service with SQLite and declares no persistent disk; local SQLite data is not a production persistence strategy.
- [ ] Configure a stable `ENCRYPTION_MASTER_KEY`, `JWT_SECRET`, admin credentials/token, merchant API key, webhook secret, Supabase service-role key, and all other secrets in the hosting secret manager. Rotate any key ever committed, shared, or stored in an untracked backup.
- [ ] Set exact HTTPS `YOUPI_ALLOWED_ORIGINS`, `YOUPI_ALLOWED_RETURN_ORIGINS`, checkout frame ancestors, and customer return URL origins.
- [ ] Use a separately rotated merchant API key and webhook HMAC secret. Keep both server-side. Do not put either in Vite/browser configuration.
- [ ] Configure the Fins & Wings webhook URL and matching `YOUPI_WEBHOOK_SECRET`. Confirm raw-body signature verification, delivery-ID matching, and duplicate handling.
- [ ] Review migrations `008_youpi_pg.sql` and `009_youpi_manual_review.sql` against the live schema, take a restorable backup, then apply them through the normal controlled database migration process.
- [ ] Verify RLS and grants in Supabase: gateway attempts/events and the event RPC remain inaccessible to `anon` and ordinary `authenticated` users; only `service_role` invokes the webhook RPC; only authorized admins invoke the review RPC.
- [ ] Apply edge rate limits, request-size limits, WAF rules, egress restrictions, alerting, log retention controls, and an incident/secret-rotation procedure. The gateway's in-process rate limiter is per-process and is not a multi-instance control.
- [ ] Disable unused SMS/Gmail observers and remove their OAuth credentials/permissions if they are not part of the deployment. `MANUAL_UPI` itself bypasses observer-health gating and cannot be auto-attributed.
- [ ] Test UTR reuse, duplicate webhooks, retries, network interruption, timeout, amount mismatch, wrong merchant, admin rejection, admin approval, and rejected order retry using synthetic data.
- [ ] Confirm fulfilment is impossible before authenticated admin verification and stock confirmation. Reconcile the credited bank account manually before approving a UTR.
- [ ] Run gateway `npm test`, customer `npm test`, admin `npm run build`, gateway typecheck/build where supported, and dependency audit. Retain test output with the release review.
- [ ] Establish database backups and perform a restore drill; monitor webhook delivery backlog and failed attempts.

## Release controls

- [ ] Review all diffs and ensure `.env`, `.env.save`, `.env.before-*`, and `data/.secrets/*` remain untracked.
- [ ] Apply migrations only after approval by the database owner. This code change does not connect to or mutate live Supabase.
- [ ] Push the reviewed feature branch only after explicit release approval.
- [ ] Deploy only after the production approval and checklist sign-off.
