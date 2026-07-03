# Web UI

The Web UI (`@wrongstack/webui`) is a React + Radix + Tailwind frontend backed by
a Node `ws` server that drives the same agent kernel as the CLI and TUI.

> **HQ command center (separate app):** the read-only multi-client dashboard
> served by `wstack --hq` is a distinct React app under
> [`packages/webui-hq/`](../packages/webui-hq/) (Phase 5 of the
> [HQ Command Center 2026-07 plan](plans/hq-command-center-2026-07.md)).
> It is **not** the same code as the per-session WebUI described below —
> the WebUI lives next to one session, the HQ aggregates telemetry from
> every WrongStack client in the project.

There are **two ways** to run it, and they differ in one important way — whether a
terminal REPL shares the browser's agent:

| Launch | Terminal REPL | Browser UI | Agent |
|---|---|---|---|
| `wstackui` (standalone binary) | — | ✅ | boots its **own** agent for the cwd |
| `wrongstack --webui` | ✅ | ✅ | **same** live agent/session as the terminal |

Use the standalone binary for a pure browser experience; use `wrongstack --webui`
when you want to drive one session from both the terminal and the browser at once
(handy for pair-programming or watching tool output in a richer view).

## Ports

The Web UI listens on **two** ports:

| Port | Env var | Default | Purpose |
|---|---|---|---|
| HTTP | `WEBUI_PORT` / `PORT` | `3456` | serves the built React app (`index.html` + assets) |
| WebSocket | `WS_PORT` | `3457` | the agent backend (messages, tool stream, provider/key mgmt) |

Bind host is `WEBUI_HOST` / `WS_HOST` (default `127.0.0.1`). On loopback the server also listens on
the IPv6 loopback `::1` for the same WS port, so browsers that resolve `localhost`
to IPv6 first don't flap. Set `--host 0.0.0.0` or `WEBUI_HOST=0.0.0.0` to expose
on LAN/Tailscale (this requires the auth token for HTTP, API, and WS access — see
Security).

The frontend learns the **real** WS port from a `<meta name="wrongstack-ws-port">`
tag the HTTP server injects into the served HTML — it is *not* hardcoded. This is
what makes multiple instances work.

Behind a tunnel or reverse proxy, the browser-facing URL can differ from the local
bind address. Set `WEBUI_PUBLIC_URL` / `--public-url` for the HTTP URL printed to
the user, and `WEBUI_PUBLIC_WS_URL` / `--public-ws-url` when the WebSocket endpoint
is exposed on a separate public URL.

### Running multiple instances

Both ports **auto-advance** to the next free port if the requested one is taken, so
you can start several instances without picking ports by hand:

```bash
cd /path/A && wstackui         # → http 3456 / ws 3457
cd /path/B && wstackui         # → http 3458 / ws 3459 (auto)
cd /path/C && wstackui         # → http 3460 / ws 3461 (auto)
```

Each instance:

- serves HTML stamped with **its own** WS port, so the browser dials the right backend;
- boots against its own `cwd` (project-scoped sessions/goal/config);
- registers itself in the instance registry (below).

To pin ports instead (e.g. behind a reverse proxy), set them explicitly and disable
auto-advance:

```bash
wstackui --host 0.0.0.0 --port 8080 --ws-port 8081 --token "$WEBUI_TOKEN"
WEBUI_STRICT_PORT=1 wstackui --port 8080 --ws-port 8081   # fail loudly if taken
```

## Running-instance registry

Every live instance records itself in **`~/.wrongstack/webui-instances.json`** so you
can see which ports are open for which project:

```jsonc
{
  "version": 1,
  "instances": [
    { "pid": 12345, "httpPort": 3456, "wsPort": 3457, "host": "127.0.0.1",
      "projectRoot": "/path/A", "projectName": "A",
      "startedAt": "2026-06-05T09:12:00.000Z", "url": "http://127.0.0.1:3456" }
  ]
}
```

List them without booting a server:

```bash
wstackui --list      # or: wstackui ls / wstackui -l
```

```
Running WebUI instances (2):

  • http://127.0.0.1:3456  ·  ws:3457  ·  pid 12345
      project: A  (/path/A)
      since:   2026-06-05T09:12:00.000Z
  • http://127.0.0.1:3458  ·  ws:3459  ·  pid 23456
      project: B  (/path/B)
      since:   2026-06-05T09:14:30.000Z
```

The registry is **self-healing**: every register/unregister/list prunes entries whose
PID is no longer alive, so a crashed instance that never unregistered is cleaned up on
the next call. Writes are atomic. Instances launched via `wrongstack --webui` appear in
the same registry as standalone ones.

## CLI flags & env vars

| Flag (CLI `--webui`) | Standalone equiv. | Effect |
|---|---|---|
| `--webui` | `wstackui` | start the server |
| `--host <h>` / `--webui-host <h>` | `wstackui --host <h>` | bind host/interface (`0.0.0.0` for LAN/Tailscale) |
| `--webui-port <n>` / `--http-port <n>` | `wstackui --port <n>` | HTTP frontend port |
| `--ws-port <n>` / `--port <n>` | `wstackui --ws-port <n>` | WebSocket backend port (`--port` kept for CLI compatibility) |
| `--webui-token <t>` | `wstackui --token <t>` | fixed access token/password instead of a random process token |
| `--webui-public-url <url>` / `--public-url <url>` | `wstackui --public-url <url>` | browser-facing HTTP URL for tunnels/proxies |
| `--webui-public-ws-url <url>` / `--public-ws-url <url>` | `wstackui --public-ws-url <url>` | browser-facing `ws://` or `wss://` URL for tunnels/proxies |
| `--webui-require-token` / `--require-token` | `wstackui --require-token` | require the token even on loopback binds |
| `--open` | `wstackui --open` / `WEBUI_OPEN=1` | open the browser after the server is ready |
| — | `wstackui --list` | print running instances and exit |

| Env var | Default | Effect |
|---|---|---|
| `WEBUI_PORT` / `PORT` | `3456` | HTTP port |
| `WS_PORT` | `3457` | WebSocket port |
| `WEBUI_HOST` / `WS_HOST` | `127.0.0.1` | bind host (`0.0.0.0` for LAN) |
| `WEBUI_TOKEN` | random | fixed access token/password |
| `WEBUI_PUBLIC_URL` | unset | browser-facing HTTP URL for tunnels/proxies |
| `WEBUI_PUBLIC_WS_URL` | unset | browser-facing `ws://` or `wss://` URL for tunnels/proxies |
| `WEBUI_REQUIRE_TOKEN` | unset | `1` requires token auth even on loopback binds |
| `WEBUI_STRICT_PORT` | unset | `1` disables port auto-advance (fail on conflict) |
| `WEBUI_OPEN` | unset | `1` opens the browser on start (standalone) |

## Security

- The server binds loopback by default. **Loopback bind** keeps the existing local
  dev ergonomics and does not require a token.
- For public tunnels that connect to a local loopback port, set
  `WEBUI_REQUIRE_TOKEN=1` or `--require-token`; otherwise the server sees the tunnel
  daemon as a local client.
- On a non-loopback bind, the HTTP UI, `/api/*` routes, and WebSocket upgrade all
  require the access token. A random per-process token is generated unless you set
  `WEBUI_TOKEN` / `--token` / `--webui-token`.
- The printed URL includes `?token=...` for first load. The frontend exchanges it
  for an HttpOnly `ws_token` cookie via `/ws-auth`, then removes the token from the
  browser address bar. Browser WebSocket auth uses the cookie, not URL-token auth.
- DNS-rebinding defense: the WS upgrade rejects non-loopback `Host` headers; the HTTP
  responses set a strict CSP whose `connect-src` allows the loopback WS port and the
  current request host's WS/WSS port.
- Inbound WS frames are size-capped and per-connection rate-limited.

### Remote access examples

```bash
# Tailscale/LAN: expose both HTTP and WS ports on the machine's Tailscale IP.
WEBUI_TOKEN="$(openssl rand -hex 16)" wstackui --host 0.0.0.0 --port 8080 --ws-port 8081

# CLI-embedded WebUI, same live agent as the terminal.
wstack --webui --host 0.0.0.0 --webui-port 8080 --ws-port 8081 --webui-token "$WEBUI_TOKEN"
```

Cloudflare Tunnel or another reverse proxy can keep WrongStack bound to loopback and
publish only the tunnel endpoints:

```bash
export WEBUI_TOKEN="$(openssl rand -hex 16)"
WEBUI_REQUIRE_TOKEN=1 \
WEBUI_PUBLIC_URL=https://wrongstack.example.com \
WEBUI_PUBLIC_WS_URL=wss://wrongstack-ws.example.com \
wstackui --host 127.0.0.1 --port 8080 --ws-port 8081 --token "$WEBUI_TOKEN"
```

Example `cloudflared` ingress:

```yaml
ingress:
  - hostname: wrongstack.example.com
    service: http://127.0.0.1:8080
  - hostname: wrongstack-ws.example.com
    service: http://127.0.0.1:8081
  - service: http_status:404
```

Then open `https://wrongstack.example.com?token=<WEBUI_TOKEN>`. The frontend exchanges
the token for the HttpOnly cookie and then connects to `wss://wrongstack-ws.example.com`.
When HTTP and WS use different public hostnames, the WS token also remains on the
in-memory WS URL because the browser cookie cannot cross hostnames. Prefer a same-host
WS route such as `wss://wrongstack.example.com/ws` if your proxy supports path-based
routing.
For CLI-embedded WebUI, use the matching flags:

```bash
wstack --webui \
  --host 127.0.0.1 --webui-port 8080 --ws-port 8081 \
  --webui-token "$WEBUI_TOKEN" --webui-require-token \
  --webui-public-url https://wrongstack.example.com \
  --webui-public-ws-url wss://wrongstack-ws.example.com
```

## UI surfaces

- **Theme** — a segmented Light / Dark / System toggle lives in the chat header
  (`ThemeToggle`). The design system ("Engineering Instrument Deck": IBM Plex
  type, warm-graphite/​warm-paper surfaces, signal-amber accent, status LEDs) is
  defined entirely with HSL CSS variables in `src/index.css`, so both modes stay
  in lockstep. The sidebar brand plate carries a live connection LED.
- **Settings / Model Routing** — Settings exposes the same durable model controls
  as the CLI: fallback chain, named fallback profiles, favorite models,
  smart-fallback auto toggle, and `modelMatrix` routing for role/phase/`*`
  subagents. The route selector lists `*`, every catalog phase, and every agent
  role; the target field stays free-form because it can be a bare model,
  `provider/model`, fallback profile name, or blank when the route only
  overrides runtime controls.
  Per-route reasoning mode, effort, and preserve fields are persisted under
  `modelMatrix[route].modelRuntime.reasoning`, so a role can inherit the leader
  model while using its own reasoning budget. Both the standalone server and
  CLI-embedded WebUI persist these prefs to config and apply them to the live
  agent config.
- **Plan / todos** — the sidebar renders the backend's live `todos.updated`
  snapshot as a progress rail (amber while a task is in flight, green at 100%)
  with the in-progress task highlighted.
- **Live fleet roster** (`FleetPanel`) — during a multi-agent run the leader's
  spawned subagents appear as a collapsible strip of cards above the chat, each
  showing the nickname, model, live `L{iter} · {tools} tools · ${cost}` counters,
  current tool, a context-fill bar, self-extension count, and terminal
  status/error. It's driven by a `subagent.event` WS stream that **both** servers
  (standalone `startWebUI` and CLI-embedded `runWebUI`) flatten from the kernel's
  `subagent.*` catalog (spawn → task → per-tool → periodic summary → completion)
  and reduced in `useFleetStore`. The panel self-hides when no fleet is running,
  so solo sessions are unaffected.
- **Context-aware code completion** — Monaco completion providers in
  `src/components/CodeEditor.tsx` send `completion.request` frames for supported
  code languages. The shared handler (`src/server/completion-handlers.ts`) merges
  three sources in order: LSP (`lsp_completion`, when the plugin/tool is active),
  a short JSON-only provider call, and the WrongStack codebase index. Client and
  server both gate LLM usage so low-value typing stays local; member access (`.`)
  and semantic prefixes such as `findBy`, `create`, `getUser`, and `setStatus`
  can use the provider. Unsaved editor content is included for LSP completion when
  the buffer is reasonably sized, so the language server sees the live Monaco
  document instead of only the file on disk.

## Internals (for contributors)

- Standalone server: `packages/webui/src/server/index.ts` (`startWebUI`) + `entry.ts` (bin).
- CLI-embedded server: `packages/cli/src/webui-server.ts` (`runWebUI`) — reuses the
  webui package's `createHttpServer`, `findFreePort`, `openBrowser`, and the instance
  registry via the `@wrongstack/webui/server` export so the static-serve / port / meta
  injection logic lives in one place.
- Static serve + WS-port `<meta>` injection + CSP: `packages/webui/src/server/http-server.ts`.
- Free-port discovery: `port-utils.ts`. Instance registry: `instance-registry.ts`.
  Browser opener: `open-browser.ts`. Frontend WS-URL resolution: `src/lib/ws-client.ts`.
- Completion trigger/cache heuristics: `src/lib/completion.ts`. Completion WS
  types: `src/types.ts`. Both standalone and CLI-embedded servers route
  `completion.request` through the same handler.
