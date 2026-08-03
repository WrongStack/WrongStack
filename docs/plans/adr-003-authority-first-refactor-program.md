# Architecture Decision Record — 003: Authority-First Refactor Program

| Field | Value |
|---|---|
| **Date** | 2026-07-15 |
| **Status** | Accepted |
| **Deciders** | WrongStack core team |
| **Supersedes** | Sequencing and ownership assumptions in `architecture-refactor-plan.md` and the 2026-07 architecture-review backlog; historical evidence remains valid |
| **Superseded by** | — |
| **Execution graph** | [`architecture-refactor-task-graph-2026-07.md`](architecture-refactor-task-graph-2026-07.md) |
| **Historical backlog** | [`../archive/work-items/backlog/2026-07-architecture-review/README.md`](../archive/work-items/backlog/2026-07-architecture-review/README.md) |

## Context

WrongStack is a large TypeScript monorepo with a healthy amount of automated coverage and an acyclic workspace dependency graph. The system does not need a rewrite. The current architectural cost comes from a different source: the same behavior or contract is frequently authoritative in more than one place.

Examples observed in the 2026-07 live-tree audit:

- CLI still contains an embedded WebUI backend beside the neutral `@wrongstack/webui-server` package.
- WebSocket contracts are independently represented by WebUI, WebUI server, CLI, SimpleUI, and Desktop.
- Provider metadata is repeated across trusted presets, compatible presets, factory branches, model capability data, WebUI cards, JSON catalogs, tests, and documentation.
- Privileged ACP, WebUI, Desktop, and HQ actions do not all flow through a shared trust-decision boundary.
- Plugin setup has no host-owned disposable lifecycle in the CLI shutdown path.
- `@wrongstack/runtime` is explicitly transitional and still re-exports concrete defaults from Core.
- Large files such as TUI `app.tsx`, CLI `cli-main.ts`, and Core `director.ts` mix multiple responsibilities, but splitting them before their contracts are characterized would distribute coupling rather than remove it.

The verification architecture also has blind spots that make broad refactors unsafe:

- Runtime tests and TypeScript test checking do not cover the same file set.
- Root test discovery omits known special cases unless dedicated configurations are invoked.
- Most packages typecheck production sources but not tests.
- CI build, typecheck, and test jobs run in isolated checkouts even though some checks consume ignored workspace build artifacts.
- Current hotspot limits are mostly ceilings or advisory checks, not true no-growth ratchets.

Earlier plans correctly identified many hotspot files, but some implementation assumptions are now stale. In particular, `@wrongstack/webui-server` already exists as the neutral server package; moving server ownership into Core is no longer appropriate. Several prior extraction tasks are complete or partially complete, while governance and behavioral gates remain unfinished.

## Decision

WrongStack will use an **authority-first, verification-gated strangler program** for the next architecture refactor cycle.

The program follows this order:

1. Establish a trustworthy clean-checkout verification baseline.
2. Consolidate security and lifecycle decision boundaries.
3. Establish one typed protocol authority and one WebUI backend authority.
4. Generate provider, plugin, tool, and configuration projections from canonical definitions.
5. Decompose hotspots by tested behavioral seam, not by arbitrary line movement.
6. Resolve Core/Runtime/persistence/memory ownership through measured pilots.
7. Remove compatibility adapters only after parity, deprecation, and rollback gates pass.

### Decision 1 — Verification precedes structural movement

No high-risk package move, protocol cutover, or god-module split starts until its behavior is characterized by the relevant gate in the execution graph.

A green production-source typecheck is not sufficient evidence for a changed test file. Verification must explicitly report:

- expected files,
- discovered files,
- executed tests,
- skipped tests,
- typechecked test files,
- and whether build artifacts were produced in the same clean CI lineage.

Zero-test collection is a failure, not a passing test job.

### Decision 2 — One authority per cross-surface contract

Each cross-surface concern must have one canonical owner:

| Concern | Canonical direction |
|---|---|
| Surface wire protocol | A neutral, dependency-light protocol package with runtime decoders and version/capability negotiation |
| WebUI server behavior | `@wrongstack/webui-server`; CLI becomes a host/capability adapter |
| Privileged action decision | One capability-oriented trust-boundary port; surfaces provide actor and authentication context |
| Provider metadata | One typed `ProviderDefinition` registry; UI, presets, factories, and docs are projections |
| Plugin metadata | One typed manifest; catalogs, exports, audit state, and docs are projections |
| Tool-tier registration | `@wrongstack/tools`; hosts compose rather than duplicate selection rules |
| Plugin configuration | One precedence resolver with explicit hot/restart/immutable/secret field semantics |
| Memory behavior | One `MemoryPort`; legacy backends become compatibility adapters |

Renderer-specific visual state remains renderer-owned. The decision unifies semantic contracts and projections, not every UI implementation detail.

### Decision 3 — Preserve `@wrongstack/webui-server` as the neutral server home

The program rejects moving the WebUI server into Core. Core must not acquire HTTP/WebSocket host ownership to solve duplication.

The CLI embedded server will be migrated handler family by handler family behind `BackendServices`-style capability ports until CLI is a thin `startWebUI` adapter. Source-regex parity checks are temporary characterization aids; golden request/response and event fixtures become the authoritative parity mechanism.

### Decision 4 — Privileged surfaces share a trust-decision seam

ACP filesystem/terminal operations, WebUI process control, HQ control actions, and privileged Desktop IPC must call a common policy port before execution.

The port evaluates at least:

- actor and authenticated surface,
- capability,
- subject/resource,
- risk tier,
- project/session scope,
- and any scoped authorization token.

Execution remains surface-specific. For example, ACP file writing and WebUI process termination need different executors, but they must not invent unrelated authorization semantics.

The first pilot is ACP because it provides concrete adversarial gates: realpath containment, symlink escape prevention, and sanitized child environments.

### Decision 5 — Plugin loading returns a disposable host resource

Plugin lifecycle becomes host-scoped:

```ts
const plugins = await setupPlugins(options);
try {
  await runHost();
} finally {
  await plugins.dispose();
}
```

The disposable handle owns:

- reverse-order teardown,
- cleanup draining even when a plugin has no teardown callback,
- setup-failure rollback,
- enforceable setup/teardown deadlines,
- timer/listener cleanup,
- idempotent disposal,
- and per-host state isolation.

Cooperative `AbortSignal` notification may accompany a deadline, but it is not itself an enforceable timeout.

### Decision 6 — Hotspots are split by behavioral seam

Line count is a guardrail and outcome metric, not the primary decomposition rule.

Examples of required sequencing:

- TUI: top-level journey tests → key routing → submit/run orchestration → overlays/pickers → domain reducers → root shell.
- CLI: shared services out of slash commands → bootstrap/runtime/surface/shutdown phases → smaller composition root.
- Director: realistic multi-agent journeys → director-tool contracts → budget/lease/recovery policies → assignment lifecycle → orchestration shell.
- Desktop: extracted helpers must be imported by the production composition path before their old implementations are deleted.
- HQ: prefer deleting the second featureful fallback implementation after asset guarantees exist; do not modularize two full dashboards.

A hotspot stream is stopped or re-scoped after two slices if it does not reduce target LOC or cross-domain imports by at least 20%, or if it increases integration-test flakiness.

### Decision 7 — Runtime ownership is conditional, not predetermined

`@wrongstack/runtime` does not automatically receive every concrete default merely because the transitional package exists.

Before physical movement, an ADR/pilot must choose between:

- making Runtime the concrete owner of storage, security, config, observability, models, compaction, skills, and host composition; or
- folding the facade back when the additional package boundary does not reduce change cost.

One complete subsystem is piloted first. The Runtime direction is stopped or folded if:

- more than 50% of the pilot remains pass-through re-exporting,
- reverse workspace edges are introduced,
- host import complexity increases,
- or the change does not reduce Core coupling measurably.

### Decision 8 — Compatibility is additive and time-bounded

Public exports and legacy entrypoints are not removed in the same slice that introduces their replacement.

The default migration sequence is:

1. characterize current behavior,
2. introduce canonical authority,
3. adapt old entrypoints to it,
4. compare parity,
5. deprecate for at least one release,
6. remove after usage scan and release gate.

Every temporary architecture exception records an owner, reason, review/expiry date, and removal condition.

### Decision 9 — Architecture status is generated from one registry

The execution graph accompanying this ADR is the canonical status and dependency registry for the program. Historical backlog files remain evidence and issue detail, but their old recommended order is no longer authoritative.

Architecture health reporting, hotspot ratchets, exception checks, backlog status views, and dependency visualization should eventually be generated from the same machine-readable registry. Until that generator exists, the Markdown graph is the reviewed source of truth.

## Program invariants

The following invariants apply to every task in the execution graph:

1. **No hidden second authority.** A migration slice identifies the old and new owner explicitly.
2. **No deletion before parity.** Legacy code remains behind an adapter until equivalent behavior is demonstrated.
3. **No package move without DAG validation.** Workspace edges remain acyclic.
4. **No false-green tests.** Expected/discovered/executed/skipped counts are reported.
5. **No opportunistic broad refactor.** Each PR changes one behavioral seam.
6. **No unowned exceptions.** Temporary allowlists have owner and expiry metadata.
7. **No line-only success claim.** Success includes coupling, ownership, behavior, and flake metrics.
8. **No shared-tree ownership assumptions.** Implementers re-read status and diffs before editing or committing.

## Consequences

### Positive

- Refactor risk is reduced because behavior and build topology are verified first.
- Protocol, policy, metadata, and lifecycle drift become structurally harder.
- UI and host packages can evolve without copying semantic contracts.
- Hotspot reductions correspond to real ownership changes instead of wrapper proliferation.
- Compatibility and rollback remain available throughout migration.
- Existing successful extractions are retained rather than repeated or moved again.

### Negative

- The program begins with verification and governance work rather than visible feature delivery.
- Some duplication remains temporarily while adapters and golden parity fixtures coexist.
- A neutral protocol package and persistence primitive add package boundaries that must be kept dependency-light.
- Generated metadata requires tooling and review discipline.
- Conditional pilots may deliberately terminate planned migrations, leaving some facades in place.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Protocol package becomes a new god package | Split by domain; runtime-free types where possible; cap domain/barrel sizes |
| Shared trust boundary becomes surface-unaware | Require actor, surface, auth context, capability, and subject in every decision |
| Generated metadata hides behavior | Keep generated outputs reviewable and test projection parity |
| Compatibility layer becomes permanent | Owner/expiry policy and release-level removal criteria |
| Ratchets freeze legitimate work | Explicit, reviewed baseline update with reason and expiry |
| Hotspot split creates forwarding wrappers | Apply the 20% coupling/LOC and flake kill criteria |
| Runtime pilot introduces cycles | Run workspace DAG gate before and after every move |

## Alternatives considered

### Alternative A — Continue splitting the largest files first

Rejected. Large files are real risks, but several are composition points for duplicated contracts. Splitting them before authority and verification work would distribute existing coupling across more files.

### Alternative B — Rewrite Core or the UI stack

Rejected. The workspace DAG, package contracts, source typechecks, and large test estate demonstrate substantial reusable structure. A rewrite would discard working behavior and remove incremental rollback.

### Alternative C — Move WebUI server behavior into Core

Rejected. `@wrongstack/webui-server` is already the neutral server home. Moving HTTP/WebSocket ownership into Core would increase Core responsibility and recreate an obsolete plan.

### Alternative D — Keep parity through source-code regex scans

Rejected as the final mechanism. Regex scans can detect missing labels, but cannot prove runtime validation, authorization, side effects, ordering, or response equivalence. Golden behavioral fixtures replace them.

### Alternative E — Force Runtime to become the concrete owner immediately

Rejected. The current package is primarily a facade. A measured subsystem pilot provides evidence before a high-cost package migration.

### Alternative F — Share all UI state across surfaces

Rejected. Semantic events, transport state, and pure projections should be shared. Renderer layout, selection, focus, and interaction state remain local.

## Validation and governance

The task graph defines task-specific gates. Program-level health must include:

- clean-checkout workspace build,
- source and test-inclusive typecheck coverage,
- expected/discovered/executed/skipped test counts,
- architecture boundary and DAG checks,
- API/export snapshots,
- golden protocol fixtures,
- package contracts and pack smoke tests,
- hotspot no-growth ratchets,
- exception expiry checks,
- and scoped E2E journeys for migrated behavior.

Architecture status is reviewed at the end of each wave. A task is not marked `done` because code exists; its documented exit gate must pass against the current tree.

## Backlog disposition

The detailed mapping of all 19 historical architecture-review items to `done`, `partial`, `superseded`, `pending`, or `killed` is maintained in the execution graph:

- [`architecture-refactor-task-graph-2026-07.md#historical-backlog-disposition`](architecture-refactor-task-graph-2026-07.md#historical-backlog-disposition)

No historical file is deleted by this ADR. The mapping controls execution priority while retaining prior measurements and reasoning for auditability.

## When to re-evaluate

Revisit this decision if any of the following occurs:

1. The verification program cannot produce deterministic clean-checkout results after two implementation slices.
2. The neutral protocol adds more cross-package coupling than it removes.
3. The single-backend migration cannot preserve CLI and standalone behavior through domain adapters.
4. The shared trust-decision port cannot express a surface's required authorization model without unsafe generic escape hatches.
5. The Runtime pilot crosses a kill criterion.
6. Two consecutive hotspot slices fail the 20% improvement/flake criteria.

A re-evaluation updates this ADR or adds a superseding ADR; it does not silently change the task graph's dependency order.
