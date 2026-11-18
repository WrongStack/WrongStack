# WrongStack Architecture Rules

> **Status**: Active — adopted 2026-05-20, reconciled with the current layout 2026-11-14
> **Supersedes**: Nothing (new document)
> **Current layout authority**: [`architecture/core-layers.json`](../architecture/core-layers.json) — this document keeps the rationale and the rule set; layer *membership* is machine-readable there and enforced by `bun run check:core-layers`.
> **Reason**: Previous plan to extract `@wrongstack/kernel` was abandoned after discovering `WrongStackError` (runtime class) is used everywhere in core, making extraction disproportionately expensive. This document captures the agreed-upon alternative: strict internal layering with automated enforcement.

---

## Current decision: Shared contracts plus enforced core layers

The kernel and shared types live together in `@wrongstack/contracts`
(`packages/contracts/src/{kernel,types}/`). Keeping their runtime error types
in the same package avoids a cyclic dependency. Core consumes these contracts;
coordination and other extracted domains are composed above core by hosts.
Within core, runtime imports follow the machine-readable ranks in
[`architecture/core-layers.json`](../architecture/core-layers.json), enforced by
`bun run check:core-layers`.

### Historical rationale (2026-05-20; superseded layout)

The original proposal was a kernel-only `@wrongstack/kernel` extraction. It was
deferred because `kernel/container.ts` used `WrongStackError` from `types/`,
which would have left a cross-package runtime dependency. Internal layering was
adopted first. The later extraction moved **both** kernel and types into
`@wrongstack/contracts`; the earlier recommendation to keep them in core is no
longer current guidance.

---

## Layer Definitions

The following layers exist within `packages/core/src/`. Rules below govern what each layer may and may not depend on. `kernel/` and `types/` now live in `@wrongstack/contracts` and `coordination/` in `@wrongstack/coordination` (the current gate reads `architecture/core-layers.json`), so the layers below record the original core-internal layout.

### Layer 1 — Primitives (lowest level) — *moved out of core*
`kernel/` (Container, Pipeline, EventBus, RunController, TOKENS) and `types/`
(public contracts, error hierarchy, type aliases) left core for
`@wrongstack/contracts` (`packages/contracts`) on 2026-10-24. Core depends on that
package from below every area, so the lowest rank inside `packages/core/src` is
now `primitives` (`utils/`, `vcs/`, `performance/`) — see
[`architecture/core-layers.json`](../architecture/core-layers.json).

### Layer 2 — Infrastructure
- `infrastructure/` — Logger, TokenCounter, PathResolver, ContextManager, MCPServers presets

### Layer 3 — Domain
- `core/` — Agent, Context, ConversationState, system prompt building, streaming response, input building, provider runner
- `models/` — ModelsRegistry, ModelSelector, ModeStore
- `security/` — PermissionPolicy, SecretVault, SecretScrubber, ConfigSecrets
- `registry/` — ToolRegistry, ProviderRegistry, SlashCommandRegistry

### Layer 4 — Execution
- `execution/` — ToolExecutor, RetryPolicy, Compactor, ErrorHandler, SkillLoader, AutonomousRunner

### Layer 5 — Storage
- `storage/` — SessionStore, ConfigStore, ConfigLoader, MemoryStore, PlanStore, TodosCheckpoint, QueueStore, RecoveryLock, AttachmentStore, SessionReader, SessionRewinder, SessionAnalyzer, PlanTemplates, ConfigMigration, DirectorState

### Layer 6 — Coordination — *moved out of core*
`coordination/` (MultiAgentCoordinator, Director, FleetManager, FleetBus,
AgentBridge, AgentSubagentRunner, SubagentBudget, Transport, DelegateTool, fleet
state) left core for `@wrongstack/coordination` (`packages/coordination`). Core
never imports it: the agent loop reaches coordination only through the
`AGENT_COORDINATION` container token, which `@wrongstack/runtime` binds. The
current rank ladder therefore has **no coordination row** — see
[`architecture/core-layers.json`](../architecture/core-layers.json).

### Layer 7 — High-level / UI-facing
- `plugin/` — PluginAPI, PluginLoader
- `extension/` — ExtensionRegistry
- `observability/` — Metrics, Tracer, Health, Prometheus, OTLP
- `sdd/` — *moved out*: SpecParser, TaskGenerator, TaskFlow, SpecBuilder live in `@wrongstack/sdd` (`packages/sdd`); see [architecture/core-layers.json](../architecture/core-layers.json)
- `skills/` — SkillInstaller, ManifestStore, GitHubFetcher

---

## Dependency Rules

### Rule 1 — Lower layers must not import higher-layer runtime values
A lower layer must not directly import a higher layer's implementation. Runtime imports from a higher consumer layer into a lower provider layer are the normal dependency direction; type-only imports are erased and are permitted in either direction. The automated test treats the order in `LAYERS` as lowest to highest and rejects runtime edges whose source appears earlier than the target.

### Rule 2 — the contracts rank is the base
The former in-core exception is gone. `kernel/` (including `container.ts`, which
imported `WrongStackError` from `types/errors.js` — the relaxation recorded here
on 2026-05-20) and `types/` both left core for `@wrongstack/contracts`, so the
edge this rule used to relax no longer exists inside `packages/core/src`; the
package boundary now enforces it. The rank ladder that replaces the in-core
`kernel/` base, and the exact area membership of every rank, is
[`architecture/core-layers.json`](../architecture/core-layers.json): contracts →
primitives → services → agent → features → composition. The gate is
`bun run check:core-layers`, documented in
[`architecture/README.md`](../architecture/README.md).

### Rule 3 — core/ (agent loop) may not reach into execution or storage
`core/agent.ts` and `core/context.ts` must not import runtime values from
`execution/` or `storage/`. They may import from `@wrongstack/contracts`
(`kernel/` + `types/` now live there), `utils/`, `vcs/`, `performance/`,
`infrastructure/`, `models/`, `security/`, `registry/`, `plugin/`, `extension/`,
`hooks/`, `observability/`, and `skills/`. `coordination/` is no longer an
in-core target — it is `@wrongstack/coordination`, reached only through the
`AGENT_COORDINATION` token.

### Rule 4 — observability/ may not reach into core/execution/storage
`observability/` may import from `@wrongstack/contracts` (types), `utils/`, and
`infrastructure/`. It must not import runtime values from `core/`, `execution/`,
or `storage/`.

### Rule 5 — security/ is a leaf at layer 3
The specialized check forbids runtime imports from `execution/` and `storage/`.
It does not apply the general upward-edge check to every other target; type-only
imports remain permitted.

### Rule 6 — registries are consumers, not providers
`registry/` may import from `@wrongstack/contracts`, `utils/`, `security/`,
`infrastructure/`, and `models/`. It must not import from `execution/` or
`storage/`.

### Rule 7 — infrastructure/ is a thin integration layer
`infrastructure/` must not import runtime values from `core/`, `models/`,
`security/`, `registry/`, `execution/`, `storage/`, `plugin/`, `extension/`,
`observability/`, or `skills/`. It may import from `@wrongstack/contracts` and
`utils/`.

### Rule 8 — models/ must not reach execution or storage
`models/` (ModelsRegistry, ModelSelector, ModeStore) must not import runtime
values from `execution/` or `storage/`.

### Rule 9 — extension/ must not reach execution or storage
`extension/` (ExtensionRegistry) must not import runtime values from
`execution/` or `storage/`.

---

## Layer Diagram

Current ranks inside `packages/core/src` (authoritative membership and per-file
edge baseline: [`architecture/core-layers.json`](../architecture/core-layers.json)):

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  composition   <root>   index.ts · boot.ts · public-*.ts   (wiring/barrels)   │
│                                   ↑                                          │
│  features      design/                                                       │
│                                   ↑                                          │
│  agent         core/ · execution/ · plugin/                                  │
│                                   ↑                                          │
│  services      brain · security · sandbox · registry · hooks · notifications  │
│                extension · observability · infrastructure · tasking ·        │
│                prompts · typesafe · models · quota · storage ·               │
│                session-catalog · replay · skills · statusline · wiring       │
│                                   ↑                                          │
│  primitives    utils/ · vcs/ · performance/                                  │
│                                   ↑                                          │
│  contracts     @wrongstack/contracts  (packages/contracts)                    │
│                kernel/ + types/ — a package now, below every area            │
└──────────────────────────────────────────────────────────────────────────────┘

Extracted to packages above core (core must not import them):
  coordination · sdd · chronicle · goal · worktree · tools · builtin-plugins
```

**Rule of thumb**: dependency arrows point from a higher consumer toward a lower
provider. A lower rank must not import a higher rank's runtime values. The gate
is `bun run check:core-layers`; the baseline is empty, so any new upward edge
fails.

---

## Test Coverage

The following rules are enforced automatically by `packages/core/tests/architecture/package-boundaries.test.ts`:

| Rule | What it checks |
|---|---|
| Cross-package | `@wrongstack/core` must not import higher-level packages (`@wrongstack/cli`, etc.) |
| contracts (below core) | `kernel/` and `types/` are `@wrongstack/contracts`; that package boundary replaces the old in-core `kernel/` rule, which this suite no longer models |
| core/ | No runtime imports from `execution/` or `storage/` |
| observability/ | No runtime imports from `core/`, `execution/`, or `storage/` |
| security/ | No runtime imports from `execution/` or `storage/` |
| registry/ | No runtime imports from `execution/` or `storage/` |
| infrastructure/ | No runtime imports from domain/execution/storage layers |
| models/ | No runtime imports from `execution/` or `storage/` |
| extension/ | No runtime imports from `execution/` or `storage/` |
| Bidirectional | No two non-barrel layers have mutual runtime dependencies |
| Cycle | No directed cycle exists in the runtime dependency graph |

The test covers internal layers, bidirectional/cycle checks, extracted-package
regressions, and the workspace DAG. Run it with
`bun --bun run vitest run packages/core/tests/architecture/package-boundaries.test.ts`.
The seven groups summarize the historical `LAYERS` list, which does not cover
every present Core directory. `sdd/` is now a historical test-list label; its
implementation is in the separate `@wrongstack/sdd` package.
`architecture/registry.json` and the health checker track broader ownership,
cycles, exceptions and ratchets.

---

## When to Revisit This Decision

Extract `@wrongstack/kernel` (or `@wrongstack/kernel-types`) as a separate package becomes the right move when:

1. `WrongStackError` is refactored into a minimal core error module that other packages can depend on without pulling in the full error hierarchy, OR
2. A concrete need emerges (e.g., external tooling that only needs the Container/Pipeline primitives without the full agent runtime)

Until then, the layering rules keep the internal structure clean without the overhead of physical package splits.

---

## Consistency with Package Exports

The `package.json` exports map mirrors the current layering. Representative
subpaths (48 declared at the time of writing — use the manifest, not this list):

```json
{
  "./agent":           "./dist/core/index.js",
  "./execution":       "./dist/execution/index.js",
  "./infrastructure":  "./dist/infrastructure/index.js",
  "./storage":         "./dist/storage/index.js",
  "./security":        "./dist/security/index.js",
  "./session-catalog": "./dist/session-catalog/index.js",
  "./skills":          "./dist/skills/index.js",
  "./tasking":         "./dist/tasking/index.js"
}
```

`./kernel`, `./types`, and `./coordination` were removed when those areas left
core (`@wrongstack/contracts`, `@wrongstack/coordination`), so the old
specifiers no longer resolve. Public subpaths map to source owners or focused
facades; `./tasking` is outside the historical `LAYERS` list. Use the current
Core manifest's declared exports. The removed `./defaults` facade is not an
import target. Architecture checks, rather than the exports map alone, enforce
internal runtime edges.
