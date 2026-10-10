---
name: payments-webhooks
description: "Implement payment-provider integration and reliable authenticated webhook processing for an owned application. Use when building checkout, subscriptions or billing reconciliation; separate payment events, entitlement state and provider verification."
trigger: "Implement payment-provider integration and reliable authenticated webhook processing for an owned application. Use when building checkout, subscriptions or billing reconciliation; separate payment events, entitlement state and provider verification."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "product"
---

# Payments Webhooks

## Selection card
- Task: Implement signed, idempotent payment callbacks.
- Start: Locate the endpoint, schema, authentication boundary and caller.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Implement payment-provider integration and reliable authenticated webhook processing for an owned application.

Checked Stripe Node SDK target: 23.0.0 on 2026-10-09. Provider API version is a separate contract; inspect account/API compatibility and official migration notes before upgrades.

## Rules

1. Model money/currency, order/payment identity and entitlement transitions explicitly.
2. Verify webhook authenticity against the raw payload and supported SDK; parsed/re-serialized bodies can invalidate verification.
3. Deduplicate events atomically and handle out-of-order/retried delivery; event id and business operation id solve different duplication problems.
4. Use idempotency for outbound payment mutations and reconcile ambiguous timeout-after-commit outcomes.
5. Treat browser redirect success as UX feedback, not authoritative payment or entitlement proof.
6. Use provider sandbox fixtures and authorized test accounts; skill activation does not authorize a real charge/refund.

## Workflow

1. Inspect current billing models, provider SDK/API version and event handling.
2. Specify state transitions and reconciliation rules.
3. Implement verified inbound events and atomic application mutations.
4. Test invalid signatures, replay, ordering, partial failure and ambiguous retries using local/sandbox inputs.
5. Verify checkout/entitlement experience and report sandbox versus live evidence separately.

## Before returning

Provider authenticity and account/API scope explicit; replay/order/idempotency covered; entitlements reconcile; real financial actions remain authorized.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Stripe webhooks](https://docs.stripe.com/webhooks), [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests).

## Skills in scope

- api-design — api design contracts and verification.
- database-migrations — design and verify schema migrations, bounded backfills and deployment compatibility for databases.
- queues-jobs — implement reliable asynchronous jobs and message consumers with explicit delivery, retry and shutdown semantics.
- authentication-sessions — implement application sign-in, sessions and identity integration with explicit account/tenant authorization.
