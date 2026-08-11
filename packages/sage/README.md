# SAGE ownership

`@wrongstack/sage` is the implementation owner for WrongStack memory
backends. Hosts depend on Core's `MemoryPort`; they do not construct or inspect a
concrete store.

## Supported composition

- `createProjectSageMemoryPort(...)` is the production default. It connects
  every CLI, TUI, ACP, and WebUI host for a canonical project to one detached
  project server. That server is the only process that owns the SQLite
  connection, mutation queue, counters, and automatic hygiene throttle.
  Linked Git worktrees resolve to the main checkout identity and share it.
- `createSqliteMemoryPort(...)` is reserved for tests and explicit offline
  recovery (`WRONGSTACK_SAGE_INLINE=1`).
- `LegacyMemoryPortAdapter` wraps third-party or historical `MemoryStore`
  implementations.
- Optional retrieval and administration features are obtained with
  `getSageRetrieval(...)`, `getSageService(...)`, or
  `getSageSurface(...)`.

## Internal boundaries

- `memory-port.ts`: host-facing lifecycle, adapters, and typed capabilities
- `project-server.ts`: single per-project SQLite owner and request dispatcher
- `project-server-client.ts` / `remote-memory-port.ts`: reconnecting IPC client
  and transparent `MemoryPort`/SAGE capability proxies
- `sqlite-store.ts`: persistence and migration implementation
- `store-helpers.ts`: canonical validation, normalization, and index helpers
- `retrieval/`: ranking and rendering helpers
- `host-wiring.ts`: shared `setupSage()` for CLI and WebUI — tool/turn inject,
  domain-term extract, context monitor, opt-in outcome capture, path-remap on
  rename commands, session-end commit extract, optional daily dry-run, and
  throttled full-option hygiene teardown
- `middleware/`: injection, turn, and tool-call policies; the injector emits
  per-memory rejection evidence (`rejectedDetail`) and a rolling-window
  `injector_rejection_burst` event when a memory is repeatedly rejected by
  the `belowScore` gate, so triage can fold fresh rejection signals into
  `value-score` without scanning the chronicle
- `triage/`: the 5-phase memory lifecycle pipeline — pre-filter (deterministic
  KEEP/DISCARD/UNCERTAIN), value-score (anchor + usage + freshness +
  quality + persistence, with optional `injectorEvidence`), llm-evaluator
  (appends a bounded `REJ:` line to its prompt when rejection pressure is
  observed), action-dispatcher (auto-applies or proposes; one computed
  path lowers `importance` when a memory is repeatedly rejected by the
  `belowScore` gate — never crossing the 0.9 user-designated floor), and
  `orchestrator.ts` which wires them and accepts an optional
  `injectorEvidenceProvider` per run
- `anchors/`, `embeddings/`, and `tools/`: focused feature adapters

Shared text normalization is owned by `store-helpers.ts`. Middleware may depend
on it directly; it must not import another middleware merely to reuse helpers.

## Verification

`tests/memory-port.test.ts` runs the same lifecycle and query contract against
SQLite and the legacy adapter. Consumer-boundary rules live in
`packages/core/tests/architecture/memory-port-boundary.test.ts`. Triage
tests cover the value-score, llm-evaluator, and action-dispatcher behavior
in `packages/sage/tests/triage/`; the injector's per-memory rejection
accounting is covered in
`packages/sage/tests/middleware/tool-call-memory-rejected-detail.test.ts`.
