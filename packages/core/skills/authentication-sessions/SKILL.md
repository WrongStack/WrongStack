---
name: authentication-sessions
description: "Sign-in and sessions: OAuth 2.x/OIDC with PKCE, passkeys, passwords and MFA, session cookies, JWTs, refresh rotation, Better Auth. Use when building or fixing login, OAuth callbacks, logout, session renewal, account linking, MFA or tenant-scoped authorization, or upgrading an auth library. Not for a requested defensive security review (use security-scanner) or HTTP status contracts (use api-design)."
trigger: "Use when a change touches login or logout, OAuth callbacks, session cookies, JWT verification, refresh tokens, passkeys, MFA or account linking."
version: 1.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "product"
---

# Authentication Sessions

## Selection card
- Task: Build or repair sign-in, session lifecycle and identity linking with server-side authorization.
- Start: Read the auth library config, the login and callback routes, session storage (cookie, table or token), and one protected route with its data access.
- Finish: login, logout, refresh and revocation behave as specified in tests and a real browser run, and a second user or tenant cannot reach the first one's data.

## Overview

Authentication fails at the seams: a callback that skips `state`, accounts linked by unverified email, a JWT decoded but not verified, a refresh that revives a logged-out session. A valid login is never permission by itself.
Checked 2026-11-02: Better Auth 1.7.15 and jose 6.2.15. Use current provider/library contracts and OAuth security guidance; an OAuth draft is not automatically a stable replacement for the deployed protocol.
RFC 9700 (OAuth 2.0 Security BCP) is the baseline: PKCE for every client, exact redirect URI matching, no implicit or password grants, and rotated or sender-constrained refresh tokens for public clients.

## Rules

1. Identity is `(iss, sub)`, never email. Link a new provider identity to an existing account only when the user proves control of both (already signed in, or a verified email from a provider authoritative for that domain); auto-linking on an `email` claim enables account takeover.
2. Verify, never just decode: signature with an algorithm allowlist, `iss`, `aud`, `exp`/`nbf` with small clock tolerance, and the ID token `nonce`. With jose, `jwtVerify(token, createRemoteJWKSet(url), { issuer, audience, algorithms })`.
3. OAuth callbacks check `state` bound to the browser session, the PKCE `code_verifier` and an exact-match redirect URI. Post-login `returnTo` targets are relative paths or allowlisted, never arbitrary URLs.
4. Browser sessions ride an opaque ID or signed token in a cookie with `HttpOnly`, `Secure`, `SameSite=Lax` or `Strict`, `Path=/` and the `__Host-` prefix where possible. Rotate the session ID on login and privilege change to stop fixation.
5. SameSite is not complete CSRF protection (sibling subdomains are same-site; Lax cookies ride top-level GETs): state changes are never GET and check `Origin`/`Sec-Fetch-Site` or a CSRF token.
6. Revocation is real: logout, password reset, MFA change and admin disable invalidate server-side sessions and refresh-token families. Stateless tokens stay valid until expiry, so keep them short and state that limit.
7. Rotate refresh tokens with reuse detection: a replayed token revokes its family. Tolerate concurrent refreshes from several tabs (short grace window or client single-flight) without letting a revoked family refresh.
8. A session proves who, not what: authorize tenant and object ownership server-side at the data layer on every request, and ignore client-supplied roles or tenant IDs.
9. Hash passwords with Argon2id (or scrypt or bcrypt within their limits); keep failure responses and timing uniform; rate-limit per account and per IP; keep secrets, tokens and one-time codes out of URLs and logs.

## First moves by situation

| Situation | First moves |
|---|---|
| New OAuth or OIDC login | Read the provider's discovery document; authorization code plus PKCE; store `state` and `nonce` server-side or in a short-lived signed cookie; register exact redirect URIs per environment |
| "Logged out but still logged in" | Cached session data (Better Auth `session.cookieCache` keeps a signed copy until its `maxAge`), long JWT TTL, refresh family not revoked, CDN caching authenticated pages |
| Account linking or takeover worry | Find lookups by email in the callback; require `email_verified`; on multi-tenant IdPs such as Entra ID key on issuer plus subject, because `email` can be unverified or mutable |
| Passkeys | Single-use server challenge with expiry; verify origin, RP ID hash and the user-verification flag when required; synced passkeys often report a signature counter of 0, which is not cloning; keep a recovery path |
| JWT verification errors | `kid` missing after key rotation (remote JWKS with refetch), access token versus ID token `aud`, clock skew, algorithm outside the allowlist |
| Next.js middleware or proxy auth | Treat it as an optimistic redirect only and re-check the session in the route handler, server action or data layer; CVE-2025-29927 bypassed middleware-only checks with a spoofed internal header |
| Better Auth setup or upgrade | Set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `trustedOrigins`; generate schema with `npx @better-auth/cli generate` and review it; read sessions server-side with `auth.api.getSession({ headers })` |
| Password reset or magic link | Single-use, hashed at rest, short expiry, bound to one user; revoke other sessions on reset; identical response whether or not the account exists |

## Patterns and pitfalls

- **Algorithm confusion** — trusting the token's `alg` header allows `none` or HS256 verified with an RSA public key as the HMAC secret; pin algorithms and key types per issuer.
- **ID token as API credential** — ID tokens are for the client; APIs accept access tokens issued for their own `aud`.
- **bcrypt's 72-byte limit** — bytes past 72 are ignored, so long passphrases collide; pre-hashing must be encoded to avoid NUL bytes. OWASP's Argon2id floor is 19 MiB memory, 2 iterations, parallelism 1.
- **TOTP replay** — accept each time step once per user by storing the last used counter; recovery codes are hashed and single-use.
- **Enumeration** — login, signup and reset return the same body, status and timing; hash a dummy password when the user does not exist.
- **Tokens in browser storage** — `localStorage` tokens are readable by any XSS; browser apps keep sessions in HttpOnly cookies, SPAs via a backend-for-frontend.
- **Credentialed CORS** — reflecting any `Origin` with `Access-Control-Allow-Credentials: true` hands authenticated APIs to every site; allowlist exact origins.
- **Native apps** — use the system browser (ASWebAuthenticationSession, Custom Tabs) with PKCE per RFC 8252; embedded webviews can read credentials and many IdPs block them.
- **Cookie scope** — a cookie set on the parent domain reaches every subdomain, including untrusted ones; `__Host-` forbids the `Domain` attribute.
- **Logout depth** — clearing the app cookie leaves the IdP session alive; use RP-initiated logout when the product promises a full sign-out, and back-channel logout for server sessions.
- **Lockout as DoS** — hard lockouts let attackers lock victims out; prefer progressive delays, per-IP limits and breached-password checks.

## Workflow

1. Inventory the auth library and version, providers, session storage, token lifetimes, cookie settings and tenant model.
2. Write the state transitions: anonymous → authenticated → refreshed → revoked, including linking, MFA step-up and reset.
3. Write failing tests first: tampered and expired tokens, missing `state`, foreign `returnTo`, reused refresh token, second-user and second-tenant access.
4. Implement with the project's library and existing session store; keep custom crypto out.
5. Run the full journey in a real browser or HTTP client against the local server, with seeded test users only.
6. Report provider, device or IdP behavior that could not be exercised locally.

## Proof

- Cookie attributes: `curl -si` the login endpoint with a seeded test user and confirm `Set-Cookie` carries HttpOnly, Secure, SameSite, Path and the expected prefix
- Negative token tests: expired, wrong `aud`, wrong `iss`, `alg` set to none, and a flipped signature byte are all rejected
- OAuth: callback with missing or mismatched `state` fails; `returnTo=https://attacker.example` is refused
- Revocation: sign in on two clients, log out or reset on one, and the other's next request returns 401 (after any cookie-cache window)
- Refresh reuse: presenting the same refresh token twice fails the second time and revokes the family
- Isolation: user A requesting user B's object, and tenant A requesting tenant B's, return 403 or 404
- Project checks: typecheck, lint and tests through the project's scripts

## Stop and ask

- Rotating signing keys, session secrets or cookie domains in shared environments (signs everyone out or breaks verification).
- Migrating password hashes, merging accounts, or re-keying user identities.
- Real user credentials, production IdP tenants or provider console changes are needed.
- The request would weaken MFA, lengthen token lifetimes significantly, or disable CSRF protection.

## Before returning

- [ ] Identity keyed on issuer and subject; linking requires proven control of both identities
- [ ] Tokens verified (signature, algorithm allowlist, `iss`, `aud`, `exp`, `nonce`); negative tests pass
- [ ] OAuth `state`, PKCE and exact redirect URIs enforced; `returnTo` restricted
- [ ] Session cookie attributes observed; session ID rotated on login and privilege change
- [ ] Logout, reset and refresh-reuse revocation observed across two clients
- [ ] Object and tenant authorization enforced server-side; two-user test passes
- [ ] No secrets, tokens or codes in source, URLs or logs

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[OAuth current practice](https://www.rfc-editor.org/rfc/rfc9700.html), [Better Auth](https://www.better-auth.com/docs), [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/).

## Skills in scope

- api-design — `401` versus `403` semantics, auth headers and cookies, rate-limited auth endpoints.
- security-scanner — a requested defensive review of existing authentication code.
- database-development — session, account and refresh-family tables with atomic revocation.
- react-native-expo — native OAuth redirects and secure token storage in Expo apps.
- testing — multi-user and multi-tenant isolation, expiry, revocation and refresh-race tests.
