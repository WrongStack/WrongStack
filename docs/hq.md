# HQ architecture and navigation

HQ is the cross-machine command center served by `wstack --hq` (or `wstack hq`).
The browser application is `packages/hq-next`, a Next.js static export the CLI
serves offline (strict `script-src 'self'` CSP; build-time externalized inline
scripts). It is distinct from the project WebUI. The CLI server composes Core
HQ state, authentication, publishers, browser snapshots and commands. The older
Vite dashboard (`webui-hq`) was retired and folded into `hq-next`: its store,
transport and shared components now live under `packages/hq-next/src/hq/`
(imported as `@hq/*`).

| Owner | Source |
|---|---|
| Server entry | [`hq-server.ts`](../packages/cli/src/hq-server.ts) |
| Static serving (routes, segment prefetch, 404) | [`hq-static-serve.ts`](../packages/cli/src/hq-static-serve.ts) |
| Wire contracts and publishers | [`packages/hq/src/`](../packages/hq/src/) |
| Sections and routes | [`sections.ts`](../packages/hq-next/src/lib/sections.ts) |
| Screens | [`packages/hq-next/src/features/`](../packages/hq-next/src/features/) |
| Browser transport | [`hq-socket.ts`](../packages/hq-next/src/hq/data/transport/hq-socket.ts) |
| Browser store | [`data/store/`](../packages/hq-next/src/hq/data/store/) |
| Alerts and persisted rule settings | [`alerts.ts`](../packages/hq/src/alerts.ts), [`alerts-config.ts`](../packages/hq/src/alerts-config.ts) |

HQ exists to watch and steer many WrongStack clients — on many machines, for
many projects — from one place. The dashboard is organised in six sections —
Overview, Fleet, Work, Inbox, Telemetry, System — each with its tabs and URL
(`sections.ts`). A header scope picker narrows every desktop surface to one
machine or one project without hiding what needs a person elsewhere. A
machine is its hostname-first machine key (`host:<hostname>`, else
`mid:<id>`), the same key the server groups by, so processes on one computer
that report different machine ids still read as one machine. Fleet →
Machines summarizes each box, with its memory, project disk and CPU load —
including ones that went offline, which HQ
remembers for 30 days instead of dropping — Fleet → Projects does the
same per project across every machine it runs on, System → Notifications pushes
alerts, daily budget overruns, machines going offline and unanswered
approvals to ntfy, Slack, Discord or a webhook, and Control can send one reviewed command to
several sessions at once. The screens are described in the
[HQ command reference](subcommands/hq.md#browser-ui). The phone
surface lives at `/mobile/` (Now, Chat, Board, Mail and Fleet — every machine
with its health, read-only). During development, `bun run dev` in
`packages/hq-next` serves the dashboard on port 5174; the HQ server itself
listens on 3499.

Use `sections.ts` for the current navigation and keyboard routes. Browser
views project live fleet, transcripts, Kanban, mailbox, approvals, Brain and
operational data; they do not independently own project databases. Published
snapshots and command outcomes carry host/session identity. Dropped live events
or disconnected hosts require refresh and must not be treated as complete
transcript evidence.

For startup, authentication, token management and operator commands, use the
[HQ command reference](subcommands/hq.md). For Linux service installation, use
[the service guide](hq-service.md); for agent telemetry, use
[agent monitoring](agent-monitoring.md).

Completed June–August plans live in the archive. The
[September RFC](plans/hq-improvements-2026-09.md) retains deferred proposals.
The [inspector design](designs/inspector-slots.md) describes proposed scaffolding;
its missing files are not current runtime modules.
