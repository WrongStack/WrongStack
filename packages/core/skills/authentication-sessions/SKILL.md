---
name: authentication-sessions
description: "Implement application sign-in, sessions and identity integration with explicit account/tenant authorization. Use when building OAuth/OIDC, passkeys, password login or session renewal; use security-scanner for a requested defensive review."
trigger: "Implement application sign-in, sessions and identity integration with explicit account/tenant authorization. Use when building OAuth/OIDC, passkeys, password login or session renewal; use security-scanner for a requested defensive review."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "product"
---

# Authentication Sessions

## Selection card
- Task: Build login, session rotation and revocation.
- Start: Locate the endpoint, schema, authentication boundary and caller.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Implement application sign-in, sessions and identity integration with explicit account/tenant authorization.

Checked 2026-10-09: Better Auth 1.7.7 and jose 6.2.12. Use current provider/library contracts and OAuth security guidance; an OAuth draft is not automatically a stable replacement for the deployed protocol.

## Rules

1. Define trusted identity issuer, account linkage, tenant scope and session ownership.
2. Validate callback state/redirect and token issuer/audience/expiry using the supported library; access and identity tokens serve different roles.
3. Keep server authorization on each operation/object; sign-in success or a client role claim alone cannot grant access.
4. Choose cookie/token storage and CSRF protection for the actual browser/mobile architecture.
5. Model refresh, concurrent requests, revocation, logout and account switch; stale renewal must not resurrect a logged-out session.
6. Keep credentials/keys outside source/logs and use sandbox/local fixtures for auth integration checks.

## Workflow

1. Inspect existing auth/provider/session storage and route consumers.
2. Resolve current stable library/provider compatibility and define the state transitions.
3. Implement callback/session flows and server authorization with explicit errors.
4. Test expiry, rejection, retry, stale refresh, logout and two-user/tenant isolation.
5. Exercise the actual login/logout journey and report provider/device gaps.

## Before returning

Issuer/session/account contracts explicit; server authorization and logout/refresh races checked; real flow and test boundaries recorded.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[OAuth current practice](https://www.rfc-editor.org/rfc/rfc9700.html), [Better Auth](https://www.better-auth.com/docs).

## Skills in scope

- api-design — api design contracts and verification.
- react-native-expo — build and upgrade React Native or Expo applications with navigation, native modules and verified platform integration.
- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
- testing — testing contracts and verification.
