# WrongTrace integration

WrongStack integrates with **WrongTrace**, an *external, optional* local daemon, in two independent ways that share one default origin (`http://localhost:3444`):

1. **WrongProxy provider routing** — automatic provider base-URL rewriting through the daemon's `/proxy/` surface (`tools.wrongProxy` config).
2. **WrongTrace observability guardrails** — file health, symbol lineage, friction metrics, repository atlas, edit locks, and telemetry, consumed through the `@wrongstack/wrongtrace` adapter package.

The daemon is **not shipped, owned, or bootstrapped by WrongStack**. Every code path treats it as optional: when it is not running, provider routing is unchanged and the guardrails degrade to no-ops. Nothing in a default WrongStack session ever *requires* the daemon.

| Surface | Package / config | Default URL | Activated by |
|---|---|---|---|
| Provider base-URL rewriting ("WrongProxy") | `tools.wrongProxy` (`packages/core/src/types/config/tools.ts`) | `http://localhost:3444` | Opt-in toggle (`enabled: true`) |
| Observability guardrails ("WrongTrace") | `@wrongstack/wrongtrace` (`packages/wrongtrace/`) | `WRONGTRACE_URL` env → `http://localhost:3444` | Presence of the daemon (discovery) |

Both integrations probe the same canonical health endpoint — `GET <base>/api/health` — and both treat a non-2xx or unreachable daemon as a soft signal, never a hard failure.

> **Port note.** The default is `3444` in *both* integrations (`packages/wrongtrace/src/discovery.ts:50` and `WrongProxyToolConfig.url`). Port `8000` is **not** a WrongStack default — if your daemon listens elsewhere, set `WRONGTRACE_URL` (guardrails) and `tools.wrongProxy.url` (provider routing) explicitly. A mismatch between a settings URL and the daemon's real port keeps the integration silently inactive (see [Troubleshooting](#troubleshooting)).

---

## 1. Architecture

```
                    ┌──────────────────────────────────────────┐
                    │   WrongTrace daemon (external, optional)  │
                    │   http://localhost:3444 (default)        │
                    │                                          │
                    │  /api/health      /proxy/<host><path>    │
                    │  /api/atlas       /api/file/health       │
                    │  /api/guardrail/* /api/symbol/history    │
                    │  /api/metrics/friction  /api/telemetry   │
                    │  /api/events/recent                     │
                    │  + JSON-RPC 2.0 over named pipe / UDS    │
                    └────────────┬──────────────┬──────────────┘
                                 │ HTTP         │ IPC / MCP
                 ┌───────────────┴──────────────┴─────────────┐
                 │        @wrongstack/wrongtrace adapter      │
                 │  discovery → IPC-first client, no-op when  │
                 │  the daemon is absent                      │
                 └───────────────┬─────────────────────────────┘
                                 │
        ┌────────────────────────┼───────────────────────────┐
        │ CLI wiring             │ WebUI / TUI settings      │
        │ wrongtrace-gate.ts     │ "WrongProxy / WrongTrace" │
        │ wrongtrace-hooks.ts    │ Integrations section      │
        └────────────────────────┴───────────────────────────┘
```

Design rules, enforced everywhere in this integration:

- **Fail-open.** The daemon is a *coordination optimization*, never a hard dependency. Daemon offline → edits proceed, provider calls go direct, every API returns `null` / `[]` instead of throwing.
- **Lazy, once.** Discovery runs a single time per process, lazily (`wrongtrace-gate.ts` `getWrongTrace()`), and the boot-time warm-up is fire-and-forget (`packages/cli/src/boot/system-prompt.ts` → `void getWrongTrace()`), so it never adds a serialization point to startup.
- **Bounded latency.** Every network call carries an AbortController timeout (discovery 1 s, HTTP calls 4 s, IPC connect 2 s / read 5 s, WrongProxy probe 2 s).

### 1.1 The adapter package (`packages/wrongtrace/`)

`@wrongstack/wrongtrace` (public — `publishConfig.access: "public"`, no `private` flag; zero runtime dependencies beyond `undici-types`) is deliberately decoupled from every runtime package inside WrongStack — it is the "sibling" integration protocol. Import surface:

```ts
import { getWrongTraceClient } from "@wrongstack/wrongtrace";

const wt = await getWrongTraceClient();
if (wt.isAvailable) {
  // safe to use lock/lineage/telemetry APIs — but even these
  // return null/[] on failure, so the guard is a fast path, not a requirement
}
```

Public surface (see `packages/wrongtrace/src/index.ts`):

| Export | Kind | Purpose |
|---|---|---|
| `discover`, `defaultSocketPath` | function | One-shot daemon discovery over `/api/health` |
| `createWrongTraceClient`, `getWrongTraceClient` | function | The integrated client (HTTP + IPC + MCP) |
| `WrongTraceClient` + 15 payload types | type | Contracts for every endpoint |
| `getCrossAgentRisk` | helper | One decision-ready 0–100 edit-risk score per file |
| `summarizeFriction` | helper | Prompt-ready friction prose ("Top pair: A ↔ B …") |
| `getRecentActivity` | helper | Recent actor/action events for a file |
| `digestAtlas` | helper | Boot-prompt atlas digest (fragile files, thrash) |
| `createIpcTransport` / `createMcpTransport` | function | Raw transports for advanced consumers |
| `getWrongTrace`, `preflightFileEdit`, `withFileLock` | function | The shared guardrail gate — one singleton per process |
| `createWrongTracePreToolUseHook` / `createWrongTracePostToolUseHook`, `WrongTraceGateDecisionEvent` | function / type | Shared fail-open lock-gate hook factories + typed decision events |
| `createWrongTraceHookPair` | function | Paired pre/post gate hooks sharing one reference-counted lock set (per-runner scoping; a sibling can never release your claim) |
| `createWrongTraceGateCounter`, `recordGateDecision`, `snapshotGateDecisions`, `persistWrongTraceGateCounters`, `loadWrongTraceGateCounters`, `formatGateCounterReport` | function | Gate-decision tally — one process-shared counter, persisted to `<projectRoot>/.wrongstack/wrongtrace-gate-counters.json` so `wstack proxy-status` can report firing rates cross-process |

The gate and hooks live **in the adapter itself** (not in `@wrongstack/cli`) so every host — CLI leader, fleet subagents, standalone WebUI server, runtime-package light subagents — consumes the exact same lock-gate implementation without importing `@wrongstack/cli` (dep direction cli → webui-server forbids the reverse edge). The CLI's `wiring/wrongtrace-gate.ts` / `wiring/wrongtrace-hooks.ts` are re-export shims.

---

## 2. Discovery

`packages/wrongtrace/src/discovery.ts`

1. HTTP `GET ${baseUrl}/api/health` with a **1 s** timeout. `baseUrl` = `opts.baseUrl` → `process.env.WRONGTRACE_URL` → `http://localhost:3444`.
2. A 2xx response whose body says `ok: true` **or** `status: "ok"` (both daemon schema generations are accepted) marks the daemon available.
3. The IPC path comes from the body's `socket_path` when present; otherwise platform defaults apply:
   - Windows: `\\.\pipe\wrongtrace.sock`
   - POSIX with home: `~/.wrongtrace/ipc.sock`
   - POSIX fallback: `/tmp/wrongtrace.sock`
4. Discovery **never throws** — every failure mode (offline, non-2xx, malformed JSON, no global `fetch`) collapses to `{ available: false }`, which makes it safe to call from the boot hot path.

The version string from `/api/health` is surfaced on `DiscoveryResult.version` and on the client's `_discovery` field, which is how transport routing (below) knows which JSON-RPC methods the daemon's pipe answers.

---

## 3. Transports and routing

The client (`packages/wrongtrace/src/client.ts`) speaks three transports and routes per-method:

- **HTTP/REST** — the universal substrate. Every method has an HTTP path; it is always the final fallback. Per-call timeout 4 s. Structured error bodies on accepted statuses are passed through (notably lock `409` conflicts).
- **IPC** — JSON-RPC 2.0, newline-delimited frames, over a Windows named pipe or Unix domain socket (`packages/wrongtrace/src/adapters/ipc.ts`). One request per connection; connect timeout 2 s, read timeout 5 s. Error envelopes resolve `{ result: null, error }` — callers fall back to HTTP instead of mistaking an envelope for a result. Transport failures *never* throw.
- **MCP** — a lazily-wired tool bag (`adapters/mcp.ts`), typically populated from `mcp_control.list()` when the daemon is also exposed as an MCP server (e.g. `wrongtrace mcp`). Tool names: `check_guardrail`, `get_file_health_score`, `get_symbol_lineage`, `get_friction_matrix`, `get_atlas`, `lock_file`, `unlock_file`, `report_telemetry`.

### 3.1 Per-method routing matrix

| Client method | Route | Notes |
|---|---|---|
| `getFileHealth` | **IPC** → MCP → HTTP | `telemetry/file_health` verified on the pipe |
| `reportTelemetry` | **IPC** → MCP → HTTP | `telemetry/report_run`; daemon `{status:"ok"}` normalized to `{ok}` |
| `getAtlas` | **IPC** → HTTP | `get_atlas` on the pipe since daemon v0.3.3; `summary:true` keeps pipe payloads small |
| `unlockFile` | **IPC** → MCP → HTTP | Pipe shares the daemon lock store; `{file_path,status}` shape normalized to the HTTP contract |
| `lockFile` | MCP → **HTTP only** | Deliberate exception — see below |
| `getSymbolLineage` | HTTP | `/api/symbol/history` |
| `getFrictionMatrix` | HTTP | Normalizes both the bare-array and `{edges, recent_collisions}` report shapes |
| `getRecentEvents` | HTTP | `/api/events/recent` |
| `listLocks` | HTTP | `/api/guardrail/locks` |
| `getHealth` | HTTP | `/api/health` |

**Why `lockFile` stays HTTP-first:** the pipe answers `guardrail/lock` but does not enforce conflicts — a live probe (2026-08-24) showed an IPC lock with `force:false` silently *taking over* another owner's lock instead of rejecting with the `-32009` envelope. Routing locks through HTTP preserves the `409 + {ok:false, owner, expires_at}` conflict semantics the production guardrail depends on. Flip this only when the daemon enforces conflicts on the pipe (see the strategy header in `client.ts`).

Unknown pipe methods reply `-32601`, which the transport surfaces as `{result:null}` → automatic HTTP fallback — so on older daemons the IPC layer is a no-op, not a breakage.

---

## 4. REST surface

| Endpoint | Method | Client method | Notes |
|---|---|---|---|
| `/api/health` | GET | `getHealth` | `{ok\|status, version?, socket_path?}` |
| `/api/file/health?path=` | GET | `getFileHealth` | `health_score` 0–100 (lower = fragile), `is_fragile`, `recent_thrashing_count`, lock fields |
| `/api/symbol/history?path=[&signature=]` | GET | `getSymbolLineage` | All symbol events for a file; optional daemon-format signature (`function:file.go::Name`) narrows to one symbol. Loose names like `foo()` yield `[]` — pass the full signature or omit it |
| `/api/metrics/friction?limit=` | GET | `getFrictionMatrix` | Model-vs-model overwriter heatmap; accepts both array and report shapes |
| `/api/atlas?workspace=&summary=&include_symbols=&limit=&offset=` | GET | `getAtlas` | Full mode: `packages[].files[]` with health + AST symbols. Summary mode: aggregate counters per package (`file_count`, `fragile_files_count`, `avg_health_score`). `include_symbols=false` strips AST trees (~90 % size cut). Package-level pagination |
| `/api/guardrail/lock` | POST | `lockFile` | Body: `{path, reason, owner?, owner_run_id?, ttl_seconds?, force?}`. Conflict → **409** with `{ok:false, owner, locked_at, expires_at}` passed through to the caller |
| `/api/guardrail/unlock` | POST | `unlockFile` | `{path}` |
| `/api/guardrail/locks` | GET | `listLocks` | Active locks with owner/TTL |
| `/api/telemetry` | POST | `reportTelemetry` | `{run_id, agent_name, model_name, provider, prompt_tokens, completion_tokens, cost_usd, intent, …}` |
| `/api/events/recent?limit=&since=&repo=&file_path=` | GET | `getRecentEvents` | Chronological event feed; `since` accepts ISO / SQLite datetime / Unix epoch (s or ms) |

All types are declared in `packages/wrongtrace/src/types.ts`. Unknown response fields are preserved (`[extra: string]: unknown`) for forward compatibility.

---

## 5. Agent helpers

Raw JSON is fused into decision-ready values in `packages/wrongtrace/src/agent-helpers.ts`:

### `getCrossAgentRisk(wt, path)` → `{risk, band, reasons}`

Combines `getFileHealth` + `getFrictionMatrix` into one score. Bands: `safe | caution | fragile | locked | unknown`. Heuristic (pinned by tests so the numbers don't drift):

- `is_locked` → risk 100, band `locked`
- `health_score < 40` → base 80, band `fragile`
- recent thrashing → +5 per event above 3, capped at +25
- friction: author model vs top overwriter for this file → +20 when `conflict_count ≥ 3`
- multipliers cap at 100

The path→friction join is intentionally fuzzy (the friction matrix doesn't always carry a per-file field); when no row mentions the path, only file-health signals apply — robust against daemon schema drift.

### `summarizeFriction(friction)` → one prompt-ready line

`"Top friction pair: MiniMax-M3 ↔ gemini-3.7-flash (3 conflicts). Cross-agent ratio: 40% of 10 collisions. Self-thrash: 60%."` — or `""` when there is no signal, so callers can drop the block without branching.

### `getRecentActivity(wt, path)` → chronological `{at, actor, action, runId?}[]`

Merges the friction matrix's `recent_collisions` with the events endpoint. `[]` = "no history known".

### `digestAtlas(atlas)` → boot-prompt digest

Workspace count, fragile-file count (`health_score < 40` or `is_fragile`), self-thrash-heavy workspaces. `null` when no atlas is available.

**Consumed at boot** — `packages/cli/src/wiring/wrongtrace-prompt-contributor.ts` registers a
`SystemPromptContributor` on the leader's prompt builder (`bindSystemPromptBuilder`) that races
discovery + atlas/friction fetches against an 800 ms deadline and, when the daemon answers, emits
a compact `## WrongTrace observability` block combining `digestAtlas` + `summarizeFriction`.
The atlas is fetched **without symbol trees** (`include_symbols=false`, ~10% of the full payload —
summary mode would strip the per-file health arrays `digestAtlas` needs, silently reporting
"0 fragile files").
Fail-open: an absent or slow daemon contributes nothing and never stalls boot.

In addition, the gate hooks emit **typed decision events** (`WrongTraceGateDecisionEvent`) that
each host maps onto its EventBus as `wrongtrace.gate.decision` (declared in core's `EventMap`):
`deny`, `allow-fragile`, `lock-acquired`, `lock-conflict-race`, `lock-released`. This makes the
gate's decisions observable — the first step toward counting how often it fires.

---

## 6. CLI integration

### 6.1 The gate — `@wrongstack/wrongtrace` `gate.ts` (CLI re-export: `packages/cli/src/wiring/wrongtrace-gate.ts`)

Thin, never-blocking entry points shared by every host:

- **`getWrongTrace()`** — lazily created singleton client; a discovery rejection resolves `{isAvailable:false}` so the singleton can never be poisoned. Warm-up is fire-and-forget at boot (`packages/cli/src/boot/system-prompt.ts`).
- **`preflightFileEdit(path)`** → `{kind:'allow', risk} | {kind:'blocked', risk}` — locked files block; everything else — including daemon-offline — allows. Stale locks (TTL already elapsed) do not block.
- **`withFileLock(path, reason, fn, opts?)`** — runs `fn` under the daemon lock, unlocking in `finally`. If acquisition fails for *any* transport reason, `fn` still runs — the lock is coordination, not authorization. Never steals a conflicting lock.
- **`resetWrongTraceGate()`** — test seam for the singleton.

### 6.2 The guardrail hooks — `packages/cli/src/wiring/wrongtrace-hooks.ts`

In-process hooks registered on the shared Agent's `HookRunner` (wired in `packages/cli/src/wiring/lifecycle-plugins.ts` under the id `wrongtrace-gate`). Every host's mutating tool calls pass the gate before a byte is written:

- **CLI leader** (TUI, WebUI-in-CLI, REPL, single-shot) — hooks on the leader's `HookRunner`.
- **Fleet subagents** — a dedicated WrongTrace-only `HookRunner` (`packages/cli/src/fleet/subagent-hook-runner.ts`) threaded through `MultiAgentDeps.hookRunner` into each worker's `ToolExecutor` (`host-subagent-factory.ts`).
- **Standalone WebUI server** — its own gate `HookRunner` (`backend-services.ts`), owner identity = the server's own session id.
- **Runtime-package light subagents** (e.g. the SDD wizard path) — `makeLightSubagentFactory` (`@wrongstack/runtime/light-subagent-factory.ts`) accepts a `hookRunner` dep passed by the standalone WebUI host, so SDD workers honor the same locks.

Gated tools: `edit`, `write`, `replace`, `patch`, `codebase-ast-replace` (target path resolved from `path` / `file_path` / `target` / `file` input fields).

**preToolUse:**

1. Run the pre-flight (`preflightFileEdit`). A lock held by **another owner** → **deny** with owner/expiry in the reason — the model sees it and picks another file. A lock held by **this same session** (e.g. leaked by an interrupted earlier edit) is exempted (`preflightFileEdit(path, selfOwner)` compares the daemon's `lock_owner` against `wrongstack:<sessionId>`) so a session can never self-block its own retry.
2. Healthy/fragile/offline → **allow**. Fragile files additionally get a one-line `additionalContext` nudge: *"WrongTrace: <path> is fragile (…). Prefer surgical AST diffs over rewrites."*
3. On allow, the hook **claims the lock** (`owner: wrongstack:<sessionId>`, TTL 900 s) so peers see the edit in flight. A race-lost claim (`ok:false`) still proceeds — the file was free at check time, and the daemon rejects a concurrent claim from anyone else.

**postToolUse:** releases the lock acquired in preToolUse (path-keyed, **scoped per hook pair**). Each host wires a `createWrongTraceHookPair(sessionId, { emit })` — pre and post share one lock set, so one executor can never release another executor's active claim (e.g. a standalone-WebUI server running its own agent and SDD-wizard workers under one process). If the process dies between the two phases, the daemon's 15-minute TTL reaps the lock — that TTL is the leak backstop.

**Failure philosophy:** fail-open, twice over. The hook itself catches everything (a slow daemon can never add latency surprises to the edit path), and the runner's fail-open policy for non-policy hooks is the second net.

### 6.3 Boot wiring

`packages/cli/src/boot/system-prompt.ts` seeds the WrongProxy/WrongTrace runtime singleton from persisted settings, then warms the observability gate in the background: `void getWrongTrace()`. No boot path awaits the daemon.

`bindSystemPromptBuilder` additionally registers the **WrongTrace observability contributor** (`wiring/wrongtrace-prompt-contributor.ts`) — a `SystemPromptContributor` that races discovery + atlas/friction fetches against an 800 ms deadline and injects a compact atlas + friction block when the daemon answers (see §5). Fail-open: an absent daemon contributes nothing and never stalls boot.

### 6.4 Session telemetry

`reportTelemetry` is wired into the session-completion path: `finalizeExecutionCleanup` (`packages/cli/src/execution-cleanup.ts`) reports one summary per finished session — `run_id`, agent/model/provider identity, token usage (`tokenCounter.total()`), and cost (`estimateCost().total()`) — through `wiring/wrongtrace-telemetry.ts`. The report is **not awaited inline** (never delays the reviewer notification), joins the session-end producer drain, and is raced against a 5 s deadline so a hung transport cannot block teardown. `agent_name` is `wrongstack-cli`; a session whose `ctx.model` is unset (mid-resume swap) skips reporting with a structured warning rather than attributing tokens to an empty identity.

### 6.5 Gate-decision counters (firing-rate measurability)

The typed `wrongtrace.gate.decision` events (§5) are tallied by `packages/wrongtrace/src/gate-counters.ts` — a pure, transport-agnostic counter (`record()` / `snapshot()`) with a process-shared singleton. Hosts call `recordGateDecision(event)` **inside their existing emit closures** (leader + fleet runner in `lifecycle-plugins.ts` / `subagent-hook-runner.ts`, standalone WebUI server in `backend-services.ts`) — deliberately *not* as new EventBus listeners, so the counter never registers a listener it must remember to dispose.

**Shared counters-file contract:** every host persists the same snapshot shape to the same path — `<projectRoot>/.wrongstack/wrongtrace-gate-counters.json`:
- CLI persists once at session end (`finalizeExecutionCleanup`, alongside telemetry).
- Standalone WebUI server persists on each gate decision (its host session model has no single session-end hook).
- Last writer wins; each process tallies only its own sessions (module singleton per process).

**Readout:** `wstack proxy-status` (diag-doctor `proxyCmd`) loads the file and prints the **cumulative** `deny / allow-fragile / lock-acquired / lock-conflict-race / lock-released / total` for the process that last wrote it (each host tallies its own process-lifetime sessions; the file holds the latest writer's running tally, not a single session). `wstack doctor` additionally prints a `eventBus: listeners=… wildcards=…` line when invoked from a host that holds a live EventBus (the standalone fresh-process invocation has none and omits the line rather than fabricating counts).

---

## 7. WrongProxy provider routing (the sibling feature)

Distinct from the guardrails, and often confused with them because both default to port 3444 and both appear under one settings heading.

**Config** (`tools.wrongProxy`, `packages/core/src/types/config/tools.ts`):

```jsonc
{
  "tools": {
    "wrongProxy": {
      "enabled": true,           // master switch, default false
      "url": "http://localhost:3444"  // daemon base URL
    }
  }
}
```

When `enabled` is true **and** the daemon at `url` is reachable, every provider's base URL is rewritten through `${url}/proxy/<host><path>` — the daemon becomes a transparent intermediary for provider traffic. `openai-codex` is excluded by spec. The config mirrors the WebUI `LocalPrefs` shape and is persisted to the encrypted profile config.

**Health probe** (`packages/cli/src/wiring/proxy-probe.ts`): runs once at boot, then every 30 s; 2 s per-request timeout. Failures are **soft signals** — `active` flips to false only after 2 consecutive failures (configurable `deactivateAfterFailures`, clamped ≥ 1); a recovered daemon re-activates on the very next successful probe. Overlapping probes abort each other, and a probe whose config was toggled mid-flight is discarded so a stale 2xx can never resurrect `active` after a toggle-off. Toggle-off deactivates immediately.

**Settings surfaces:** TUI settings and the WebUI `SettingsPanel → Integrations` section expose both integrations under the "WrongProxy / WrongTrace" heading (`packages/webui/src/components/SettingsPanel/IntegrationsSection.tsx`, i18n key `wrongProxyHeading`).

---

## 8. Testing

| Suite | What it covers |
|---|---|
| `packages/wrongtrace/src/__tests__/client.test.ts` | Discovery contract (both health schemas, socket fallbacks), client behavior online/offline, per-endpoint shapes — all against a stubbed `fetch` |
| `packages/wrongtrace/src/__tests__/ipc.test.ts` | JSON-RPC 2.0 newline framing against an **in-process socket daemon**; IPC-first routing; error-envelope → HTTP fallback; the `lockFile` HTTP-first exception |
| `packages/wrongtrace/src/__tests__/agent-helpers.test.ts` | Risk-band heuristics, friction prose, activity merging, atlas digest — pure functions |
| `packages/wrongtrace/src/__tests__/hooks.test.ts` | Hook-pair gate events: confirmed `lock-acquired`/`lock-released` emission, fail-closed release on failed unlock (503 / 409 `ok:false` / offline), reference-counted sibling release |
| `packages/wrongtrace/src/__tests__/mcp.test.ts` | MCP transport adapter: unknown-tool/reject fail-open, empty bag unwired, per-call timeout bounds a never-settling handler, fast handler wins |
| `packages/cli/tests/wrongtrace-hooks.executor.test.ts` | Hook deny/allow/claim/release behavior on the executor path, **plus typed gate-decision events** (`deny` / `lock-acquired` / `lock-released` emitted and asserted) |
| `packages/cli/tests/wrongtrace-gate.live.test.ts` | Live-daemon assertions — **self-skip when the daemon is offline** (see trap below) |
| `packages/cli/tests/wrongtrace-telemetry.test.ts` | Telemetry payload mapping + fail-open report contract (report-once, offline no-op, throw-swallowed) |
| `packages/cli/tests/boot/system-prompt-builder.test.ts` | Pins the builder's contributor set — now autonomy + WrongTrace observability |
| `packages/webui-server/tests/wrongtrace-webui-gate.test.ts` | Standalone-WebUI gate registration contract (deny/claim/release against the live daemon, offline-degrade) |
| `packages/cli/tests/proxy-probe.test.ts` | Soft-signal threshold, mid-flight toggle guards, stale-probe discarding |
| `packages/core/tests/wiring/proxy-rewrite.test.ts` | Base-URL rewrite semantics incl. the openai-codex exclusion |
| `packages/webui-server/tests/wrongproxy-prefs-e2e.test.ts` | Settings → prefs → runtime propagation |

> **Trap — green ≠ live.** The WrongTrace suites are contract tests first: when the daemon is unreachable they skip their live assertions and still exit green. A green run proves the *offline/fail-open contract*, not lock acquire/deny/release against a real daemon. Before trusting a run as live coverage, check for the `[wrongtrace-gate.live] daemon offline` skip line or probe `/api/health` yourself.

---

## 9. Troubleshooting

**Integration silently inactive (guardrails never fire / proxy never rewrites).**
Most common cause: URL/port mismatch. Both integrations default to `http://localhost:3444`. If your daemon listens on a different port, set `WRONGTRACE_URL` (guardrails) *and* `tools.wrongProxy.url` + `enabled:true` (provider routing). For proxy routing specifically, `active` is gated by probing the configured URL — a settings URL pointing at a Vite dev-server port (e.g. `:5173`) instead of the daemon keeps `active=false` and rewrites silently disabled; symptoms include provider responses arriving as SPA-fallback HTML.

**Verify the daemon is where you think it is:**

```
curl http://localhost:3444/api/health
```

A 2xx with `ok:true` (or `status:"ok"`) is the single source of truth for both integrations.

**A file edit was denied with `WrongTrace lock: …`.**
Another owner holds the daemon lock. The deny reason carries the owner and expiry; wait for the TTL (≤ 15 min for WrongStack-held locks) or have the owner release it. WrongStack itself never force-steals a lock (`force` is only set by explicit callers).

**A lock seems stuck.**
WrongStack-held locks carry a 900 s TTL; if a session dies mid-edit the daemon reaps it. `listLocks()` (or `GET /api/guardrail/locks`) shows owner and `expires_at` for every active lock.

**Edits feel slower with the daemon up.**
Every gated edit pays one pre-flight round-trip (plus the lock claim). All timeouts are bounded (≤ 4 s HTTP, 2 s/5 s IPC), and the hooks are fail-open — worst case is one bounded timeout, never an edit lost. If latency matters, run the daemon locally so `/api/file/health` answers in single-digit milliseconds.

**Tests pass but I want live coverage.**
Start the daemon on the expected port and re-run `packages/wrongtrace` + `packages/cli` WrongTrace suites; confirm the skip line is *absent* in stderr.

---

## 10. File map

| Concern | Path |
|---|---|
| Adapter package (client, discovery, transports, helpers, types) | `packages/wrongtrace/src/` |
| Shared gate (singleton, preflight, withFileLock) | `packages/wrongtrace/src/gate.ts` |
| Shared guardrail hook factories + typed decision events | `packages/wrongtrace/src/hooks.ts` |
| Gate-decision counter (shared tally + counters-file persist) | `packages/wrongtrace/src/gate-counters.ts` |
| CLI counter re-export shim | `packages/cli/src/wiring/wrongtrace-gate-counters.ts` |
| Adapter unit + IPC tests | `packages/wrongtrace/src/__tests__/` |
| CLI gate re-export shim | `packages/cli/src/wiring/wrongtrace-gate.ts` |
| CLI hook re-export shim | `packages/cli/src/wiring/wrongtrace-hooks.ts` |
| Session telemetry (report at session completion) | `packages/cli/src/wiring/wrongtrace-telemetry.ts` |
| Boot-prompt atlas/friction contributor | `packages/cli/src/wiring/wrongtrace-prompt-contributor.ts` |
| Fleet subagent gate runner | `packages/cli/src/fleet/subagent-hook-runner.ts` |
| Standalone WebUI gate wiring | `packages/webui-server/src/server/backend-services.ts` |
| Runtime light-subagent factory hookRunner dep | `packages/runtime/src/fleet/light-subagent-factory.ts` |
| Typed `wrongtrace.gate.decision` event key | `packages/core/src/kernel/events/wrongtrace-events.ts` |
| Hook registration (leader lifecycle) | `packages/cli/src/wiring/lifecycle-plugins.ts` (`wrongtrace-gate`) |
| Boot warm-up | `packages/cli/src/boot/system-prompt.ts` |
| WrongProxy probe | `packages/cli/src/wiring/proxy-probe.ts` |
| Proxy rewrite semantics | `packages/core/src/wiring/proxy-rewrite.ts` |
| Config types (`tools.wrongProxy`) | `packages/core/src/types/config/tools.ts` |
| WebUI settings surface | `packages/webui/src/components/SettingsPanel/IntegrationsSection.tsx` |
| WebUI prefs propagation | `packages/webui-server/src/server/proxy-runtime.ts`, `pref-helpers.ts` |
| Hook executor tests | `packages/cli/tests/wrongtrace-hooks.executor.test.ts` |
| Live gate tests | `packages/cli/tests/wrongtrace-gate.live.test.ts` |
