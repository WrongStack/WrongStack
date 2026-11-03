---
name: realtime-systems
description: "Realtime with WebSocket (ws), Socket.IO and Server-Sent Events for live updates and presence: auth, ordering, reconnect, scaling. Use when building live feeds, notifications, chat, presence or collaborative updates, fixing dropped or duplicated events, reconnect storms or proxy timeouts, or scaling connections across nodes. Not for durable background work (use queues-jobs) or proxy and TLS setup (use reverse-proxy-tls)."
trigger: "Use when code opens WebSocket or EventSource connections, configures Socket.IO, streams SSE, or fans out live events across server nodes."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: data
  domain: "data"
---

# Realtime Systems

## Selection card
- Task: Build or repair live server-to-client updates with authenticated subscriptions, gap-free resume and bounded connection resources.
- Start: Read the transport setup (server, client library, adapter), the event schema, the snapshot endpoint, and the proxy or load balancer config in front of it.
- Finish: a client that disconnects, reconnects and changes node ends with the same state as the server, unauthorized joins are refused, and connections survive the real proxy path.

## Overview

A realtime connection is a cache that can silently go stale: every client must be able to prove it has not missed an event, and fall back to a snapshot when it has.
Checked Socket.IO target: 4.8.4 on 2026-10-23. Inspect current transport/server/client/proxy support; SSE and WebSocket have different delivery and lifecycle behavior.
Socket.IO is its own protocol over WebSocket or HTTP long-polling: a plain WebSocket client cannot talk to it, and multi-node deployments need sticky sessions plus an adapter.

## Rules

1. Authenticate the handshake and authorize every subscription, room join and inbound message against current permissions; disconnect or re-check when the token expires or the session is revoked.
2. Browsers send cookies on cross-site WebSocket upgrades and cannot set custom headers there: validate `Origin` on upgrade to stop cross-site WebSocket hijacking, and if auth rides the URL, use a short-lived single-use ticket, because URLs land in logs.
3. Every event carries a per-stream monotonic sequence. Clients resume from the last applied sequence (SSE `Last-Event-ID`, Socket.IO connection state recovery, or a `since` cursor) and fall back to a full snapshot outside the replay window.
4. Bound each connection: message size (`ws` `maxPayload` defaults to 100 MiB; Socket.IO `maxHttpBufferSize` to 1 MB), inbound message rate, outbound buffer (`bufferedAmount`; disconnect slow consumers) and subscriptions per socket.
5. Heartbeat faster than every idle timeout on the path (nginx `proxy_read_timeout` defaults to 60 s; many load balancers idle out at 60 s) and use ping/pong to detect half-open TCP.
6. Reconnect with exponential backoff and full jitter, and fence each connection with a generation ID so late callbacks from an old socket cannot change the new one's state.
7. Presence, typing and cursors live in TTL keys refreshed by heartbeat; "remove on disconnect" alone leaves ghosts, because crashes skip disconnect handlers.
8. Cross-node fan-out goes through a broker. Redis pub/sub and PostgreSQL `LISTEN/NOTIFY` are fire-and-forget, so replay comes from a durable log (Redis Streams, Kafka, a table) or a snapshot.

## First moves by situation

| Situation | First moves |
|---|---|
| New live feature | Choose SSE for server-to-client over plain HTTP (built-in reconnect and `Last-Event-ID`), WebSocket for bidirectional traffic; define the event schema with `seq`, the snapshot endpoint and the replay window |
| Events missed after reconnect | Check that the client tracks the last applied `seq`, the server's replay buffer size, and the subscribe-then-snapshot ordering |
| Connections drop about every 60 s | Proxy or load balancer idle timeout versus heartbeat interval; SSE needs a comment heartbeat such as `: ping` |
| SSE arrives in bursts or never | Proxy buffering or compression: send `Cache-Control: no-cache` and `X-Accel-Buffering: no`, set `proxy_buffering off`, flush after each event, exclude the route from compression middleware |
| Scaling to several nodes | Socket.IO: sticky sessions while long-polling is enabled (or WebSocket-only transport) plus an adapter; plain `ws`: broker fan-out with per-node subscription maps |
| Reconnect storm after deploy | Drain nodes gradually, close with 1012 (service restart) or 1001 (going away), randomize client backoff, cap the accept rate |
| SSE breaks with several tabs open | HTTP/1.1 allows about six connections per origin per browser; serve over HTTP/2 or share one connection across tabs via BroadcastChannel or a SharedWorker |
| Security review | `Origin` check, auth on every join, schema validation on inbound messages, size and rate limits, payloads filtered to the subscriber's rights |

## Patterns and pitfalls

- **Snapshot and delta race** — subscribe first and buffer deltas, fetch the snapshot at revision R, apply it, then apply buffered deltas with `seq > R`; fetching the snapshot before subscribing loses whatever happened in between.
- **Socket.IO connection state recovery** — restores rooms and missed packets only for short disconnects and only with adapters that support it (the in-memory or Redis Streams adapter, not the classic Redis pub/sub adapter); check `socket.recovered` and resync when false.
- **Acknowledgements** — plain Socket.IO emits are fire-and-forget and volatile emits may be dropped; `socket.timeout(ms).emitWithAck(...)` confirms delivery when the business flow needs it.
- **Compression** — `perMessageDeflate` costs memory per connection and invites compression bombs; `ws` leaves it off server-side by default, so enable it only with thresholds and limits.
- **Close codes** — 1000 normal, 1001 going away, 1008 policy violation, 1009 message too big, 1011 server error, 1012 service restart; clients must not reconnect-loop on 1008 auth failures.
- **Backpressure** — `send()` queues in memory; check `bufferedAmount` before sending, coalesce or drop superseded updates, and disconnect consumers that stay behind.
- **LISTEN/NOTIFY limits** — payloads cap at 8000 bytes, notifications are lost while the listener is disconnected, and it needs a session connection, not a transaction-pooling pooler.
- **Ordering across nodes** — order is guaranteed only per producer or partition; assign the sequence at one writer per stream (a database sequence or stream ID).
- **EventSource limits** — GET only and no custom headers (use cookies or a ticket); reconnect delay comes from the `retry:` field; the server must read the `Last-Event-ID` header itself.
- **Serverless and mobile** — functions with execution limits cannot hold long connections (use a managed pub/sub or Durable Objects); mobile OSes kill background sockets, so resync on foreground.

## Workflow

1. Map server, client library, adapter or broker, proxy chain and timeouts; note where events originate and who assigns sequence numbers.
2. Define the contract: event schema and version, sequence scope, replay window, snapshot endpoint, auth checks per join and per message.
3. Write failing tests first: reconnect with a gap, duplicate event, unauthorized join, token expiry mid-connection, stale socket callback after replacement.
4. Implement auth, bounded delivery, heartbeats and the resume path; keep presence in TTL storage.
5. Run against the real proxy configuration and at least two server nodes when scaling is in scope.
6. Report measured behavior: resume correctness, idle survival time, memory under a slow consumer.

## Proof

- Origin check: `curl -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://attacker.example' localhost:3000/ws` returns 403, not 101
- Interactive WebSocket: `websocat ws://localhost:3000/ws` sends and receives the expected frames
- SSE: `curl -N -H 'Accept: text/event-stream' localhost:3000/events` shows events one at a time; adding `-H 'Last-Event-ID: 42'` resumes after 42
- Resume: kill the server mid-stream, restart, and assert the client's applied sequence is contiguous with no duplicates
- Idle survival: through the real proxy, stay idle for twice the idle timeout and confirm the connection persists via heartbeats
- Slow consumer: a client that never reads is disconnected at the buffer limit while server memory stays flat
- Multi-node: an event published on node A reaches a client connected to node B

## Stop and ask

- Changing proxy or load balancer timeouts, sticky-session settings or connection limits in shared infrastructure.
- Switching transport or library (SSE, WebSocket, Socket.IO, a managed service) for an existing feature.
- Running load or reconnect-storm tests against shared or production environments.
- Event payloads would carry data whose visibility rules are not defined.

## Before returning

- [ ] Handshake authenticated, `Origin` validated, joins and inbound messages authorized; expiry and revocation handled
- [ ] Events sequenced; resume and snapshot fallback proven after a real disconnect
- [ ] Message size, rate, buffer and subscription limits enforced; slow consumers disconnected
- [ ] Heartbeats beat every idle timeout on the real proxy path
- [ ] Reconnect uses jittered backoff and generation fencing
- [ ] Presence uses TTL storage; cross-node delivery verified when multiple nodes exist

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Socket.IO docs](https://socket.io/docs/v4/), [SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events), [ws](https://github.com/websockets/ws), [WebSocket close codes](https://www.iana.org/assignments/websocket/websocket.xhtml).

## Skills in scope

- api-design — snapshot endpoints, event schema versioning and rate-limit contracts.
- authentication-sessions — session and token validation for handshakes and expiry.
- reverse-proxy-tls — proxy upgrade headers, buffering and idle timeouts in front of the service.
- cloudflare-workers — Durable Objects with WebSocket hibernation for edge realtime.
- testing — deterministic disconnect, sequence-gap and stale-socket fencing tests.
