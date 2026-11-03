---
name: reverse-proxy-tls
description: "Reverse proxies and HTTPS with Caddy, Nginx and Traefik: ACME certificates, proxy_pass, X-Forwarded headers, WebSockets, SSE. Use when routing a domain to an app, fixing 502/504, redirect loops, certificate or renewal errors, upload limits, streaming or real client IPs behind a CDN. Not for app-level CORS and API contracts (use api-design) or deploying the app itself (use vps-deploy)."
trigger: "Use when a request touches a Caddyfile, nginx.conf, Traefik config, a certificate, a 502/504, a redirect loop, or WebSocket/SSE through a proxy."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "deployment"
paths: ["Caddyfile", "nginx.conf", "**/nginx/**/*.conf", "traefik.{yml,yaml,toml}"]
---

# Reverse Proxy Tls

## Selection card
- Task: Route domains to applications through a proxy with working, renewing TLS.
- Start: Map DNS → CDN → TLS termination → proxy listener → upstream for the domain, and test each hop separately (`dig`, `openssl s_client`, `curl --resolve`, a loopback curl to the upstream).
- Finish: config validates, a graceful reload succeeded, HTTPS answers on the real hostname with the right certificate, and redirects, streaming and limits behave on representative URLs.

## Overview

Debug the proxy one hop at a time: most "proxy" failures are DNS, CDN mode, certificate storage, a wrong upstream address, or forwarded headers trusted from the wrong place.
Checked 2026-11-02: Caddy 2.11.7, Nginx stable 1.30.6/mainline 1.31.8 and Traefik 3.7.17. Distinguish release channels and distro packages; verify current Traefik release before choosing it.
Certificate lifetimes are shrinking under CA/Browser Forum rules and Let's Encrypt no longer sends expiry emails, so renewal must be automatic and monitored by you.

## Rules

1. Map the chain before editing: A/AAAA/CNAME and CAA records, CDN proxy mode and SSL mode, where TLS terminates, the proxy listener and the upstream address.
2. Validate before reload and keep the previous config: `nginx -t` (`nginx -T` prints the full effective config), `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`; then a graceful reload (`systemctl reload nginx`, `caddy reload --config ...`).
3. Trust forwarded headers only from known proxy CIDRs: Nginx `set_real_ip_from` with `real_ip_header` and `real_ip_recursive on`; Caddy `trusted_proxies` in the global `servers` options; Traefik `forwardedHeaders.trustedIPs`. The edge overwrites `X-Forwarded-*` rather than appending client values.
4. Persist ACME state (Caddy `/data`, Traefik `acme.json` at mode 600, certbot `/etc/letsencrypt`), iterate against the staging CA, and alert on expiry from your own monitoring.
5. Size limits per route: Nginx `client_max_body_size` defaults to 1m and `proxy_read_timeout` to 60s; Caddy uses `request_body` `max_size`. SSE needs buffering off; WebSockets through Nginx need HTTP/1.1 plus `Upgrade` and `Connection` headers.
6. Redirect HTTP to HTTPS at exactly one layer; enable HSTS (`includeSubDomains`, preload) only after every covered host serves HTTPS.
7. Keep upstreams on loopback or a private network; the app port must not also be published publicly.
8. Change one site at a time and protect neighbours: a default server that rejects unknown hosts (`ssl_reject_handshake on;`, `return 444;`) prevents the wrong site or certificate from answering.

## First moves by situation

| Situation | First moves |
|---|---|
| 502 Bad Gateway | Upstream down, wrong port, HTTP vs HTTPS mismatch, or stale upstream IP; `curl -fsS http://127.0.0.1:<port>/healthz` on the proxy host; proxy error log |
| 504 Gateway Timeout | Slow upstream vs `proxy_read_timeout`; long requests or streaming need route-specific timeouts |
| 413 or uploads fail | `client_max_body_size` (Nginx) or `request_body` (Caddy), plus CDN upload limits |
| Redirect loop | CDN SSL mode "Flexible" sends HTTP to origin; app ignores `X-Forwarded-Proto`; two layers both redirecting; `curl -sIL http://host` shows the chain |
| Certificate wrong or expired | `openssl s_client -connect host:443 -servername host </dev/null 2>/dev/null \| openssl x509 -noout -subject -issuer -dates -ext subjectAltName` |
| ACME issuance fails | DNS points elsewhere, ports 80/443 blocked, CAA forbids the CA, TLS-ALPN-01 behind a TLS-terminating CDN; read proxy logs for the ACME error |
| Origin test bypassing CDN | `curl -sv --resolve app.example.com:443:<origin-ip> https://app.example.com/healthz -o /dev/null` |
| WebSocket or SSE breaks | `curl -N https://host/events` for SSE; a WebSocket handshake curl expecting `101`; buffering, timeouts and HTTP/1.1 upgrade headers |
| Client IP is the proxy's | Trusted proxy CIDRs; CDN header (`CF-Connecting-IP`) only from the CDN's published ranges |

## Patterns and pitfalls

- **Nginx resolves upstream names once** — hostnames in `proxy_pass` are resolved at start or reload, so a recreated container gets 502s. Use a `resolver` with a variable in `proxy_pass`, or `server app:3000 resolve;` in an upstream with a `zone` (open source since 1.27.3).
- **`proxy_pass` trailing slash** — `location /api/ { proxy_pass http://127.0.0.1:3000/; }` strips `/api/`; without the slash the prefix is kept. Test real paths.
- **`add_header` inheritance** — any `add_header` in a location drops every `add_header` inherited from the server block, silently removing HSTS or CSP there.
- **Host header** — Nginx sends `$proxy_host` by default; set `proxy_set_header Host $host;` when the app builds absolute URLs or routes by host.
- **Caddy HTTPS upstreams** — proxying to an HTTPS upstream usually needs `header_up Host {upstream_hostport}`; SSE needs `flush_interval -1`. WebSockets work without extra config.
- **Caddy admin API** — `caddy reload` talks to the admin endpoint (localhost:2019); disabling admin breaks reloads. On-demand TLS requires an `ask` endpoint or anyone can make you issue certificates.
- **Traefik exposure** — set `exposedByDefault=false`, never run the dashboard with `api.insecure` in production, and v3 changed rule syntax (`HostRegexp` takes Go regex); read the v2→v3 migration notes before copying labels.
- **OCSP stapling** — Let's Encrypt ended OCSP in 2025; `ssl_stapling on` with its certificates only logs warnings. Remove it rather than chasing the warning.
- **HTTP/2 in Nginx** — `listen 443 ssl http2` is deprecated in favour of the `http2 on;` directive; HTTP/3 needs a `quic` listener plus an `Alt-Svc` header.
- **ACME rate limits** — containers recreated without persistent ACME storage reissue certificates until production rate limits block the domain for days.

## Workflow

1. Trace the chain for the domain and record the current config (copy or VCS revision) as the rollback.
2. Test each hop separately to locate the failing layer.
3. Make the minimal change in the site's own file; keep TLS keys and ACME storage untouched.
4. Validate syntax and review the effective config for overlaps (`nginx -T | grep server_name`).
5. Perform the authorized graceful reload and watch the error log.
6. Test HTTPS, redirects, body limits, streaming and client IP on representative URLs; record certificate dates and renewal method.

## Proof

- Syntax: `nginx -t`, `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, `caddy fmt --diff /etc/caddy/Caddyfile`
- DNS: `dig +short A app.example.com`, `dig +short AAAA app.example.com`, `dig +short CAA example.com`
- TLS: `openssl s_client` piped to `openssl x509 -noout -dates -ext subjectAltName` shows the expected names and validity
- Routing: `curl -fsS https://app.example.com/healthz`; `curl -sIL http://app.example.com` ends in one 301/308 then 200
- Origin: `curl --resolve` against the origin IP gives the same result as through the CDN
- Streaming: `curl -N` receives SSE events incrementally; the WebSocket handshake returns `101 Switching Protocols`
- Renewal: `certbot renew --dry-run`, or the Caddy/Traefik log showing successful renewal
- Listeners: `ss -ltnp '( sport = :80 or sport = :443 )'` shows only the proxy

## Stop and ask

- Reloading or restarting a proxy that serves other sites in production.
- Changing DNS records, CDN SSL mode, HSTS preload or CAA records.
- Deleting or moving certificates, private keys or ACME account data, or switching CA.
- Exposing an admin API, dashboard or upstream port publicly.

## Before returning

- [ ] DNS, CDN mode, TLS termination, listener and upstream verified hop by hop
- [ ] Config validated before reload; previous config kept for rollback
- [ ] Forwarded headers trusted only from known proxy CIDRs; client IP verified
- [ ] Certificate names, issuer and expiry checked; ACME storage persistent; renewal tested or observed
- [ ] Body limits, timeouts and WebSocket/SSE behaviour verified for the routes that need them
- [ ] Sibling virtual hosts, private keys and renewal paths untouched

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Caddy docs](https://caddyserver.com/docs/), [Nginx releases](https://nginx.org/en/download.html), [Traefik docs](https://doc.traefik.io/traefik/).

## Skills in scope

- vps-deploy — deploy an owned application to an explicitly authorized VPS with versioned artifacts, service identity and live health evidence.
- ssh-operations — connect to and administer explicitly authorized hosts through OpenSSH with verified identity and bounded operations.
- api-design — upstream path prefixes, CORS headers, rate limiting, and healthcheck endpoints.
- realtime-systems — implement WebSocket, SSE or established realtime transports with explicit authentication, ordering and reconnect behavior.
- linux-service-ops — the proxy's systemd unit, reload behaviour and journal.
