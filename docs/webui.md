# Web UI

The Web UI (`@wrongstack/webui`) is a React + Radix + Tailwind frontend backed by
a Node `ws` server that drives the same agent kernel as the CLI and TUI.

> **HQ command center (separate app):** the multi-client dashboard and control
> plane served by `wstack --hq` is a distinct React app under
> [`packages/webui-hq/`](../packages/webui-hq/) (Phase 5 of the
> [HQ Command Center 2026-07 plan](plans/hq-command-center-2026-07.md)).
> It is **not** the same code as the per-session WebUI described below —
> the WebUI lives next to one session, the HQ aggregates telemetry from
> every WrongStack client in the project.

Launch it with the canonical `wstack --webui` command. The browser UI and terminal
REPL share the **same** live agent/session, which is useful for pair-programming or
watching tool output in a richer view.

## Ports

The Web UI uses a **single shared HTTP/WebSocket port**. The HTTP server serves the
built React app and accepts WebSocket upgrades on the same listener.

| Port | Env var | Default | Purpose |
|---|---|---|---|
| HTTP + WebSocket | `WEBUI_PORT` / `PORT` | `3456` | serves the React app, `/api/*`, and WS upgrades |

This is one listener, not paired HTTP and WebSocket listeners. The standalone
runtime resolves only `httpPort` and attaches its `WebSocketServer` to the HTTP
server (`packages/webui-server/src/server/server-runtime.ts`). The CLI-embedded
runtime likewise sets `wsPort = httpPort` and constructs the WebSocket server
with `{ server: httpServer.server }` when the frontend is available
(`packages/cli/src/webui-server.ts`). `--ws-port` and `WS_PORT` remain compatibility
aliases for this same shared port; they do not configure a second listener.

Bind host is `WEBUI_HOST` / `WS_HOST` (default `127.0.0.1`). Set
`--webui-host 0.0.0.0` or `WEBUI_HOST=0.0.0.0` to expose on LAN/Tailscale (this
requires the auth token for HTTP, API, and WS access — see Security).

The frontend derives the WebSocket URL from the page origin in the normal same-port
case. Behind a tunnel or reverse proxy, the browser-facing URL can differ from the
local bind address. Set `WEBUI_PUBLIC_URL` / `--webui-public-url` for the HTTP URL
printed to the user, and `WEBUI_PUBLIC_WS_URL` / `--webui-public-ws-url` when the
browser must connect to a different WebSocket URL.

### Running multiple instances

The shared port **auto-advances** to the next free port if the requested one is taken,
so you can start several instances without picking ports by hand:

```bash
cd /path/A && wstack --webui         # → http/ws 3456
cd /path/B && wstack --webui         # → http/ws 3457 (auto)
cd /path/C && wstack --webui         # → http/ws 3458 (auto)
```

Each instance:

- serves HTML whose browser WebSocket connection targets that same instance;
- boots against its own `cwd` (project-scoped sessions/goal/config);
- registers itself in the instance registry (below).

To pin ports instead (e.g. behind a reverse proxy), set the shared port explicitly and
disable auto-advance:

```bash
wstack --webui --webui-host 0.0.0.0 --webui-port 8080 --webui-token "$WEBUI_TOKEN"
WEBUI_STRICT_PORT=1 wstack --webui --webui-port 8080   # fail loudly if taken
```

## Running-instance registry

Every live instance records itself in **`~/.wrongstack/webui-instances.json`** so you
can see which port is open for which project:

```jsonc
{
  "version": 1,
  "instances": [
    { "pid": 12345, "httpPort": 3456, "host": "127.0.0.1",
      "projectRoot": "/path/A", "projectName": "A",
      "startedAt": "2026-06-05T09:12:00.000Z", "url": "http://127.0.0.1:3456" }
  ]
}
```

The registry records running WebUI instances for tooling and diagnostics. A listing
is formatted like this:

```text
Running WebUI instances (2):

  • http://127.0.0.1:3456  ·  pid 12345
      project: A  (/path/A)
      since:   2026-06-05T09:12:00.000Z
  • http://127.0.0.1:3457  ·  pid 23456
      project: B  (/path/B)
      since:   2026-06-05T09:14:30.000Z
```

The registry is **self-healing**: every register/unregister/list operation prunes
entries whose PID is no longer alive, so a crashed instance that never unregistered is
cleaned up on the next call. Writes are atomic. Instances launched via
`wstack --webui` share this registry.

### Internal multi-session groundwork

WrongStack also has internal metadata for future process-per-session WebUI tabs. A
future parent shell can launch one child WebUI runtime per live session and discover
attachable children by joining the session registry with `webui-instances.json`.
Child records use optional fields such as `role: "session-child"`, `sessionId`,
`parentPid`, `parentShellId`, `runtimeId`, and `attachable`. This is internal
groundwork only: the parent shell and browser tab UI are not implemented yet.

## CLI flags & env vars

| Canonical invocation / flag | Effect |
|---|---|
| `wstack --webui` | start the server |
| `--webui-host <h>` | bind host/interface (`0.0.0.0` for LAN/Tailscale) |
| `--webui-port <n>` | shared HTTP + WebSocket port |
| `--ws-port <n>` | legacy alias for the shared port |
| `--webui-token <t>` | fixed access token/password instead of a random process token |
| `--webui-public-url <url>` | browser-facing HTTP URL for tunnels/proxies |
| `--webui-public-ws-url <url>` | browser-facing `ws://` or `wss://` URL for tunnels/proxies |
| `--webui-require-token` | require the token even on loopback binds |
| `--open` / `WEBUI_OPEN=1` | open the browser after the server is ready |

| Env var | Default | Effect |
|---|---|---|
| `WEBUI_PORT` / `PORT` | `3456` | shared HTTP + WebSocket port |
| `WS_PORT` | unset | legacy alias for the shared port |
| `WEBUI_HOST` / `WS_HOST` | `127.0.0.1` | bind host (`0.0.0.0` for LAN) |
| `WEBUI_TOKEN` | random | fixed access token/password |
| `WEBUI_PUBLIC_URL` | unset | browser-facing HTTP URL for tunnels/proxies |
| `WEBUI_PUBLIC_WS_URL` | unset | browser-facing `ws://` or `wss://` URL for tunnels/proxies |
| `WEBUI_REQUIRE_TOKEN` | unset | `1` requires token auth even on loopback binds |
| `WEBUI_STRICT_PORT` | unset | `1` disables port auto-advance (fail on conflict) |
| `WEBUI_OPEN` | unset | `1` opens the browser on start |

## Security

- The server binds loopback by default. **Loopback bind** keeps the existing local
  dev ergonomics and does not require a token.
- For public tunnels that connect to a local loopback port, set
  `WEBUI_REQUIRE_TOKEN=1` or `--webui-require-token`; otherwise the server sees the
  tunnel daemon as a local client.
- On a non-loopback bind, the HTTP UI, `/api/*` routes, and WebSocket upgrade all
  require the access token. A random per-process token is generated unless you set
  `WEBUI_TOKEN` / `--webui-token`.
- The printed URL includes `?token=...` for first load. The frontend exchanges it
  for an HttpOnly `ws_token` cookie via `/ws-auth`, then removes the token from the
  browser address bar. Browser WebSocket auth uses the cookie, not URL-token auth.
- DNS-rebinding defense: the WS upgrade rejects non-loopback `Host` headers; the HTTP
  responses set a strict CSP whose `connect-src` allows the loopback WS port and the
  current request host's WS/WSS port.
- Inbound WS frames are size-capped and per-connection rate-limited.

### Remote access examples

```bash
# Tailscale/LAN: expose the shared HTTP/WebSocket port on the machine's Tailscale IP.
WEBUI_TOKEN="$(openssl rand -hex 16)" wstack --webui --webui-host 0.0.0.0 --webui-port 8080 --webui-token "$WEBUI_TOKEN"
```

Cloudflare Tunnel or another reverse proxy can keep WrongStack bound to loopback and
publish only the tunnel endpoints:

```bash
export WEBUI_TOKEN="$(openssl rand -hex 16)"
WEBUI_REQUIRE_TOKEN=1 \
WEBUI_PUBLIC_URL=https://wrongstack.example.com \
WEBUI_PUBLIC_WS_URL=wss://wrongstack.example.com/ws \
wstack --webui --webui-host 127.0.0.1 --webui-port 8080 --webui-token "$WEBUI_TOKEN"
```

Example `cloudflared` ingress:

```yaml
ingress:
  - hostname: wrongstack.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Then open `https://wrongstack.example.com?token=<WEBUI_TOKEN>`. The frontend exchanges
the token for the HttpOnly cookie and then connects back to the same origin using a
WebSocket upgrade on the shared listener. If your proxy requires an explicit WS route,
route it to the same local service, for example `wss://wrongstack.example.com/ws` →
`http://127.0.0.1:8080`.
The equivalent all-flags form is:

```bash
wstack --webui \
  --webui-host 127.0.0.1 --webui-port 8080 \
  --webui-token "$WEBUI_TOKEN" --webui-require-token \
  --webui-public-url https://wrongstack.example.com \
  --webui-public-ws-url wss://wrongstack.example.com/ws
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
  model while using its own reasoning budget. The WebUI server persists these
  prefs to config and applies them to the live agent config.
- **Plan / todos** — the sidebar renders the backend's live `todos.updated`
  snapshot as a progress rail (amber while a task is in flight, green at 100%)
  with the in-progress task highlighted.
- **Live fleet roster** (`FleetPanel`) — during a multi-agent run the leader's
  spawned subagents appear as a collapsible strip of cards above the chat, each
  showing the nickname, model, live `L{iter} · {tools} tools · ${cost}` counters,
  current tool, a context-fill bar, self-extension count, and terminal
  status/error. It's driven by a `subagent.event` WS stream that the server
  flattens from the kernel's `subagent.*` catalog (spawn → task → per-tool → periodic summary → completion)
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

- Shared backend: `packages/webui-server/src/server/index.ts` (`startWebUI`), the `@wrongstack/webui-server` package (extracted in PR #018b; `@wrongstack/webui/server` is now a back-compat re-export shim).
- Canonical launcher: `packages/cli/src/webui-server.ts` (`runWebUI`) — reuses the
  webui package's `createHttpServer`, `findFreePort`, `openBrowser`, and the instance
  registry via the `@wrongstack/webui/server` export so the static-serve / port / meta
  injection logic lives in one place.
- Static serve + optional WS URL `<meta>` injection + CSP: `packages/webui-server/src/server/http-server.ts`.
- Free-port discovery: `port-utils.ts`. Instance registry: `instance-registry.ts`.
  Browser opener: `open-browser.ts`. Frontend WS-URL resolution: `src/lib/ws-client.ts`.
- Completion trigger/cache heuristics: `src/lib/completion.ts`. Completion WS
  types: `src/types.ts`. The WebUI server routes `completion.request` through
  the shared handler.
