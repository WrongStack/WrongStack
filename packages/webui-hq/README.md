# @wrongstack/webui-hq

HQ Command Center dashboard — the offline React app for the cross-machine
coordination surface served at `wstack --hq` (port 3499). The same deployment
also serves a phone-first operator console at `/mobile`.

## Overview

This is a **self-contained Vite + React app** with zero CDN dependencies —
everything bundles into `dist/` so it works on offline/LAN/restricted-network
machines. It connects to the HQ server's `/ws/browser` WebSocket channel and
renders 12 views:

| View | Source | Purpose |
|------|--------|---------|
| Cockpit | `hq.snapshot` + `/api/alerts` | fleet, alert, and cost overview with quick actions |
| Fleet | `hq.snapshot` | searchable graph/compact-list topology by full fleet, machine, or project, including mailbox-serve clients |
| Console | transcript + `hq.command_status` | live chat plus leader/subagent messaging, interrupt controls, and inline command lifecycle |
| Mailbox | `hq.snapshot.mailboxes` | unread/incomplete/high-priority counts |
| Kanban | `/api/projects/:projectId/kanban` + `kanban.snapshot` | project boards shared across clones and machines, with guarded mobile transition/assignment control |
| Cost | `hq.snapshot.projects` | per-project cost breakdown |
| Brain | `brain.event` envelopes | decision/intervention timeline |
| Worktrees | `worktree.event` envelopes | phase lifecycle swim-lanes |
| Trends | `/api/trends/cost` | time-bucketed cost/activity |
| Alerts | `hq.alert` + `/api/alerts` | live + history alert feed |
| Control | `POST /api/command` | steer/abort/spawn/broadcast to clients |
| Security | `/api/auth/status` + `/api/auth/password` | browser password and credential management |

## Mobile console

`https://<hq-host>/mobile` is an independently loaded, phone-first surface. It
shares HQ's WebSocket, snapshot, transcript and command protocols without
loading the desktop workbench bundle. It provides:

- machine/project/session and agent selection;
- virtualized live transcript and full server-backed history;
- `steer`, `btw` and `queue` messaging through live control, with durable
  mailbox fallback;
- a cross-project Inbox with mark-read, acknowledge and reopen actions;
- mobile Kanban board/task visibility plus previewed, audit-commented lifecycle
  transitions and assignment to visible project agents, routed through a live
  project client and the canonical Kanban IPC owner; queued/running ownership
  is protected against reassignment;
- one-card, operator-confirmed dispatch through clients advertising
  `kanban.dispatch`; this reuses
  the canonical Director `kanban_queue` reserve/spawn/start path, including
  dependency readiness, lifecycle, budget and lease fencing;
- an Attention queue for waiting/error agents, alerts, governance warnings,
  failed commands, disconnected clients and unread mail;
- an explicitly confirmed interrupt action;
- reconnect-safe selection and iOS/Android safe-area layout;
- installable PWA metadata, an offline-safe static shell, and opt-in background
  attention notifications. Auth, API, transcript and control responses are
  never cached. Server-push notifications while the app is fully closed are
  not part of this phase.

Mobile access is password-only. For a persistent VPS deployment, bind HQ to
loopback, register the TLS reverse-proxy origin, and inject the password via a
secret environment variable rather than exposing it in the process arguments:

```bash
WRONGSTACK_HQ_PASSWORD='a-long-unique-password' \
  wstack --hq --hq-public-url https://hq.example.com --hq-trusted-proxy-hops 1
```

The flag enables Secure cookies, requires browser authentication, trusts only
that exact HTTPS Host/Origin, and refuses a non-loopback bind. Configure the
reverse proxy to forward HTTP and WebSocket traffic to `127.0.0.1:3499`.
Set the proxy-hop count to the exact number of trusted proxies in front of HQ;
leave it at the default `0` if the proxy does not supply a trusted
`X-Forwarded-For` chain.
Do not expose cleartext HQ directly to the Internet. The desktop workbench
remains available at `/`.

Mobile password sessions are server-scoped to conversational operations. They
can read HQ data, send mailbox/control messages, interrupt a selected run and
request lifecycle-gated Kanban transitions and guarded task assignments, but cannot administer
authentication or invoke `run-command`, even through a hand-written API
request. Kanban completion and dependency gates remain authoritative on the
project owner; HQ never mutates its replica cache directly.

Dispatch is shown only when a connected client for the selected project
advertises `kanban.dispatch`. A queued dispatch command is not presented as a
started worker; the client acknowledgement remains the authoritative outcome.

## Build

```bash
pnpm --filter @wrongstack/webui-hq build
```

Produces `dist/` (index.html + assets + vendor chunk). The HQ server
(`packages/cli/src/hq-server.ts`) resolves this `dist/` via
`resolveHqDistDir()` and serves it at `/`. If unbuilt, HQ falls back to the
inline `HQ_HTML` dashboard so HQ is always functional.

## Dev

```bash
pnpm --filter @wrongstack/webui-hq dev
```

Starts Vite dev server on port 5174. Point it at a running HQ server by
setting the WS URL — in dev, the app derives the WS URL from
`window.location`, so visit the HQ server directly (port 3499) for the
served build, or proxy in dev.

## Architecture

- `src/lib/hq-ws-client.ts` — `/ws/browser` client (reconnect, token from
  `?token=` query, dispatches snapshot/event/alert/command-status frames).
- `src/store.ts` — Zustand store for snapshots, events, alerts, command
  lifecycle, selections, and connection state.
- `src/components/hq/app-shell.tsx` — desktop operator shell and lazy view router.
- `src/mobile/mobile-app.tsx` — separate password-only mobile console at `/mobile`.
- `src/views/` — the 10 views.

All types come from `@wrongstack/core` (`HqSnapshot`, `HqEventEnvelope`, etc.).
