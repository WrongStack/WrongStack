---
name: payments-webhooks
description: "Stripe and payment-provider integrations: Checkout, subscriptions, raw-body webhook signatures, idempotency keys and entitlements. Use when building checkout or billing, handling payment or subscription webhooks, granting access from payment state, reconciling with the provider, or upgrading a payment SDK or API version. Not for generic queue semantics (use queues-jobs) or sign-in flows (use authentication-sessions)."
trigger: "Use when code creates charges, Checkout sessions or subscriptions, receives provider webhooks, or grants access based on payment state."
version: 1.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "product"
---

# Payments Webhooks

## Selection card
- Task: Build or repair payment flows and webhook handlers whose entitlements follow verified provider state.
- Start: Read the provider SDK version and pinned API version, the webhook route (including body parsing), the event ledger table, and where entitlements are granted.
- Finish: signed sandbox events (valid, tampered, duplicate, out of order) produce the correct final state exactly once, and the redirect page grants nothing on its own.

## Overview

Payment bugs are state-machine bugs: webhooks arrive late, twice and out of order, the redirect page lies, so entitlements must follow verified provider state, never the browser. A timeout after the provider committed is not a failure.
Checked Stripe Node SDK target: 23.1.0 on 2026-10-23. Provider API version is a separate contract; inspect account/API compatibility and official migration notes before upgrades.
Webhook payloads are rendered in the webhook endpoint's API version (or the account default), not the SDK's pinned version, so upgrading the SDK does not change what your handler receives.

## Rules

1. Verify the signature on the exact raw bytes before parsing: `stripe.webhooks.constructEvent(rawBody, signatureHeader, endpointSecret)`, or `constructEventAsync` with Web Crypto on edge runtimes. Any body parser that re-serializes the payload breaks verification.
2. Deduplicate on `event.id` in the same database transaction as the effect, and answer 2xx quickly; slow work goes to a queue. Errors and timeouts make the provider retry (Stripe retries for up to three days in live mode).
3. Never trust arrival order. Re-fetch the object (`stripe.subscriptions.retrieve(id)`) or compare the object's state and timestamps before writing, so an older event cannot overwrite newer state.
4. Money is integer minor units plus an ISO 4217 currency, computed on the server from your own price catalog. Zero-decimal currencies (JPY, KRW) have no minor unit; three-decimal currencies need provider-specific rounding.
5. Every mutating outbound call carries a deterministic idempotency key derived from the business operation; after a timeout, retry with the same key (Stripe keeps keys for about 24 hours) instead of minting a new one.
6. Grant entitlements from verified server-side state only. `checkout.session.completed` with `payment_status` `unpaid` (delayed methods such as bank debits) is not paid until `checkout.session.async_payment_succeeded`.
7. Link provider objects to your accounts by stored IDs (`client_reference_id`, metadata, a `stripe_customer_id` column), never by email.
8. Verify with sandbox keys, the Stripe CLI and test clocks. Live charges, refunds and price changes need explicit authorization.

## First moves by situation

| Situation | First moves |
|---|---|
| New Checkout flow | Server creates the session from server-side price IDs with `client_reference_id` and an idempotency key; the webhook grants access; the success page only displays status |
| Signature verification fails | Body parsed first: in Express mount `express.raw({ type: 'application/json' })` on the webhook route before any JSON parser; in Next.js App Router read `await req.text()`; check the secret matches the source (CLI `whsec_` versus dashboard endpoint) |
| Duplicate grants, emails or credits | No `event.id` ledger, or side effects performed outside the transaction that records the event |
| Subscription state wrong | Handle `customer.subscription.created/updated/deleted`, `invoice.paid` and `invoice.payment_failed`; re-fetch the subscription; map every status explicitly (`trialing`, `active`, `past_due`, `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused`) |
| SDK or API version upgrade | Read the provider changelog between versions; upgrade the webhook endpoint's version as a separate step (a parallel endpoint on the new version, handled before cutover); TypeScript types follow the SDK's pinned version |
| Refunds and disputes | `charge.refunded` and `charge.dispute.created` revoke or flag entitlements; refunds carry their own idempotency keys |
| Reconciliation | Scheduled job lists provider objects by `created` range with auto-pagination and diffs them against the local ledger; alert on drift instead of auto-correcting silently |
| Other providers (Paddle, Adyen, PayPal, Lemon Squeezy) | Same contract: signature or HMAC over raw bytes with constant-time comparison, timestamp tolerance, event-id dedupe; read that provider's retry and ordering rules |

## Patterns and pitfalls

- **Raw body survival** — global JSON middleware, framework body parsing, or a proxy that re-encodes or decompresses changes the bytes; log the content length at the route and test with a real signed event, not a hand-built fixture.
- **Timestamp tolerance** — `constructEvent` rejects events older than its tolerance (300 seconds by default); keep it, and keep server clocks synced, or replays and skew-related failures follow.
- **Per-endpoint secrets** — every endpoint and every `stripe listen` session has its own signing secret; test and live secrets differ. Rolling a secret keeps the old one valid only for the expiry window you choose.
- **Ambiguous timeouts** — a client timeout may hide a committed charge. Retry with the same idempotency key to get the original result; reusing a key with different parameters returns an error rather than a second charge.
- **Delayed payment methods** — bank debits and vouchers settle days later and can still fail (`checkout.session.async_payment_failed`); provisioning must wait or be revocable.
- **Thin events** — newer event destinations can deliver payloads that reference objects without embedding them; fetch the object before acting.
- **Ledger plus state** — store `(provider, event_id, type, received_at, processed_at)` with a unique key; keep the raw payload for replay and debugging, with retention matched to your data policy.
- **Card data scope** — keep card numbers off your servers (hosted Checkout or the Payment Element) so the integration stays in the lightest PCI scope; never log payment method details.
- **Customer portal edits** — plan changes and cancellations made in the provider portal arrive only as webhooks; code that assumes all changes go through your UI drifts.
- **Test time travel** — subscription renewals, trials and dunning cannot be tested by waiting; use test clocks to advance time on sandbox subscriptions.

## Workflow

1. Record SDK version, pinned API version, webhook endpoint versions and enabled event types.
2. Draw the state machine: provider events → local subscription or order states → entitlements, including failure, refund and dispute transitions.
3. Write tests with signed fixtures (`stripe.webhooks.generateTestHeaderString({ payload, secret })`): valid, tampered, duplicate, out-of-order, unknown event type.
4. Implement verification, the event ledger, atomic transitions and idempotent outbound calls.
5. Run end to end against the sandbox with the Stripe CLI forwarding events to the local server.
6. Report sandbox evidence separately from anything that would only be proven in live mode.

## Proof

- Local forwarding: `stripe listen --forward-to localhost:3000/api/webhooks/stripe` (prints the session's signing secret)
- Events: `stripe trigger checkout.session.completed`, `stripe trigger invoice.payment_failed`, `stripe trigger customer.subscription.deleted`
- Duplicate delivery: `stripe events resend <event_id>`; assert one effect
- Tampering: `curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/api/webhooks/stripe -H 'Stripe-Signature: t=1,v1=bad' --data '{}'` returns 400 with no side effect
- Ordering: replay fixtures newest-first and assert the final state equals newest-last
- Idempotency: call the charge or refund function twice for one operation; the provider shows one object
- Project checks: typecheck, lint and tests through the project's scripts

## Stop and ask

- Anything using live keys: charges, refunds, payouts, price or product changes.
- Changing a webhook endpoint's API version, deleting endpoints or rolling secrets in production.
- Switching provider, adding tax, invoicing or currency handling with legal or accounting impact.
- Backfilling entitlements from provider data for existing customers.

## Before returning

- [ ] SDK version, pinned API version and webhook endpoint version recorded and compatible
- [ ] Signature verified on raw bytes with timestamp tolerance; tampered request rejected (observed)
- [ ] `event.id` deduplicated atomically with the effect; duplicate resend produced one effect
- [ ] Out-of-order events cannot regress state; subscription statuses mapped explicitly
- [ ] Amounts server-computed in minor units with currency; outbound mutations idempotent
- [ ] Entitlements granted only from verified state; delayed-payment and refund paths handled
- [ ] Sandbox evidence reported separately from unverified live behavior

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Stripe webhooks](https://docs.stripe.com/webhooks), [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests), [Stripe API versioning](https://docs.stripe.com/api/versioning), [Stripe CLI](https://docs.stripe.com/stripe-cli).

## Skills in scope

- api-design — raw-body webhook routes, 2xx acknowledgement versus retryable 5xx, idempotency headers.
- database-migrations — ledger and entitlement schema changes that deploy safely.
- queues-jobs — moving slow webhook work off the request with at-least-once semantics.
- authentication-sessions — tying billing customers to verified accounts and tenants.
- testing — signed fixtures, duplicate and out-of-order delivery tests.
