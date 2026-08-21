# Finding: Local LLM provider defaults use plaintext HTTP loopback

**Severity:** Low / Informational
**Category:** Security hardening

## Description

Several built-in provider presets default their base URL to plain `http://localhost:…`. For local inference servers this is conventional, but requests may carry `Authorization: Bearer …` headers (API keys) in cleartext on the wire. On multi-user machines, loopback traffic can be observed by other local processes (or by proxies configured via environment variables). There is no warning surfaced when a user attaches an API key to an `http://` endpoint.

## Evidence

Verified via ripgrep pattern `http://(localhost|127\.0\.0\.1|[0-9])` over `packages/**/src/**/*.{ts,js}` (43 hits; representative production defaults):

- `packages/providers/src/provider-definitions.ts:155` — `baseUrl: 'http://localhost:20128/v1'`
- `packages/providers/src/provider-definitions.ts:170` — `baseUrl: 'http://localhost:11434/v1'` (Ollama)
- `packages/providers/src/provider-definitions.ts:181` — `baseUrl: 'http://localhost:8000/v1'`
- `packages/providers/src/presets/local-llm.ts:341` — `defaultBaseUrl: 'http://localhost:11434/v1'`

OAuth redirect URIs also use `http://localhost` (`packages/providers/src/oauth/claude.ts:25`, `cli/src/auth-menu/anthropic-oauth.ts:38`) — these are standard loopback OAuth flows and are **not** considered findings.

## Proposed remediation

1. When a user configures an API key/token against a non-TLS base URL, emit a one-time warning at provider-validation time ("credentials will be sent unencrypted over http://…").
2. Document in the provider setup UI/docs that local endpoints should ideally sit behind TLS if credentials are used (e.g. via a reverse proxy).
3. Optionally honor an `HTTPS_PROXY`-style opt-in to upgrade loopback defaults where the local server supports TLS.

## Notes

This is a defense-in-depth observation, not an exploitable vulnerability in WrongStack itself; the risk depends on the host environment.
