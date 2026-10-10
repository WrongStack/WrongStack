---
name: reverse-proxy-tls
description: "Configure and troubleshoot reverse proxies, HTTPS, domains and upstream routing for an authorized application. Use when working with Caddy, Nginx or Traefik; validate the actual edge-to-application path and preserve renewal and access boundaries."
trigger: "Configure and troubleshoot reverse proxies, HTTPS, domains and upstream routing for an authorized application. Use when working with Caddy, Nginx or Traefik; validate the actual edge-to-application path and preserve renewal and access boundaries."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "deployment"
---

# Reverse Proxy Tls

## Selection card
- Task: Configure proxy routing, certificates and TLS renewal.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Configure and troubleshoot reverse proxies, HTTPS, domains and upstream routing for an authorized application.

Checked 2026-10-09: Caddy 2.11.7, Nginx stable 1.30.5/mainline 1.31.6 and Traefik 3.7.14. Distinguish release channels and distro packages; verify current Traefik release before choosing it.

## Rules

1. Identify DNS ownership, TLS termination point, upstream protocol/port and existing proxy.
2. Validate configuration before reload and preserve a known recovery path.
3. Forward client identity only from trusted proxies; raw incoming forwarding headers are not an authorization source.
4. Choose timeouts/body limits, buffering and WebSocket/stream behavior from application needs.
5. Keep certificate/private-key/DNS API secrets out of source and reports; test issuance/renewal configuration without uncontrolled retries.
6. Diagnose DNS, certificate, proxy and application failures independently; a 200 from localhost does not prove public HTTPS works.

## Workflow

1. Trace the configured domain and edge/upstream chain for the authorized service.
2. Inspect expiry, SAN/hostname and effective routes; identify the failing layer.
3. Apply the minimal config/ownership fix and validate syntax.
4. Perform the authorized reload and test HTTPS, routing, redirects and streaming where applicable.
5. Record live evidence, renewal state and rollback configuration.

## Before returning

Correct domain/upstream checked; syntax validation passed; TLS and user route verified; secrets and unrelated virtual hosts preserved.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Caddy docs](https://caddyserver.com/docs/), [Nginx releases](https://nginx.org/en/download.html), [Traefik docs](https://doc.traefik.io/traefik/).

## Skills in scope

- vps-deploy — deploy an owned application to an explicitly authorized VPS with versioned artifacts, service identity and live health evidence.
- ssh-operations — connect to and administer explicitly authorized hosts through OpenSSH with verified identity and bounded operations.
- api-design — api design contracts and verification.
- realtime-systems — implement WebSocket, SSE or established realtime transports with explicit authentication, ordering and reconnect behavior.
