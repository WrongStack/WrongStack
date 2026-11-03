# WrongStack connection and migration plan

Status: proposed integration; this document explicitly covers how WrongStack will connect to WrongMemory.

## 1. Preserve the host-facing boundary

Implement `WrongMemoryPort` behind the existing `MemoryPort` contract and expose the current capability IDs:

```text
wrongstack.memory.sage-service.v1
wrongstack.memory.retrieval.v1
wrongstack.memory.surface.v1
```

Legacy `MemoryStore` methods and richer SAGE capabilities remain usable by current consumers. The adapter maps them to authorized service operations, carries trusted project/workspace/session context, and translates typed failures/events. It never opens a local writable database as a silent fallback.

The current [memory port factory and capability accessors](../../../packages/sage/src/memory-port.ts) are the integration seam. The current [runtime container](../../../packages/runtime/src/container.ts) binds one instance under both MemoryStore and MemoryPort. Preserve that single-object identity and any capability wrapper behavior expected by hosts.

## 2. Proposed configuration

Illustrative new fields under the existing capitalized `Sage` section:

```json
{
  "Sage": {
    "enabled": true,
    "service": {
      "mode": "wrongmemory",
      "startPolicy": "on-demand",
      "projectBinding": "registered"
    },
    "storage": {"directory": ".wrongstack/memories"},
    "inject": {"toolResults": true, "turnContext": false}
  }
}
```

These fields do not exist yet. Add them to canonical config types, parser/defaults, UI settings, docs, and compatibility tests together.

| Mode | Required behavior |
|---|---|
| `local` | Existing project SAGE daemon, only if external ownership is absent/released |
| `wrongmemory` | Require compatible WrongMemory; start/connect under policy; surface failure explicitly |
| `auto` | Discover compatible registered service, otherwise use supported local mode only after safe ownership checks |

Keep the current default until transfer/no-fallback/full-profile gates pass. `Sage.enabled=false` retains current semantics: disabling automatic injection/hygiene is not replacing or deleting the memory backend. `features.memory=false` and optional capture flags need their existing behavior exported into tests.

`storage.directory` remains meaningful for legacy project-local stores. A service-managed external store uses the registered descriptor, not an unchecked absolute path stuffed into the old relative field. UI must show effective store location and owner to prevent hidden split memory.

## 3. Boot connection sequence

```mermaid
sequenceDiagram
    participant H as WrongStack host
    participant A as WrongMemoryPort
    participant D as wrongmemoryd
    participant S as Project sage.db
    H->>A: create with trusted project/workspace/config/events
    A->>D: discover/connect/start singleton
    A->>D: authenticate host grant; negotiate profiles/capabilities
    A->>D: resolve/register canonical project and actual workspace
    D->>S: read-only profile check; supported ownership admission
    D-->>A: project/store/owner epoch and effective capabilities
    A->>D: acquire trusted session binding
    H->>A: install existing SAGE middleware
    A->>D: register maintenance policy if enabled
    D-->>A: scoped event stream / reconnect snapshot
```

Registration includes canonical SAGE root/storage directory, actual checkout/workspace, host version/profile, requested mode, and explicit storage descriptor if already managed. The daemon checks identities rather than trusting arbitrary path labels.

No heavyweight full-corpus scan is required on every host boot. Validate profile, resume pending maintenance, and warm bounded caches. Optional semantic model readiness is separate from lexical memory readiness.

## 4. Exact source integration map

| Current source | Proposed change |
|---|---|
| [runtime/container.ts](../../../packages/runtime/src/container.ts) | Select port through an injected/factory boundary; bind one adapter under both tokens; do not require local SQLite availability just to use a remote native service |
| [sage/memory-port.ts](../../../packages/sage/src/memory-port.ts) | Preserve capability IDs; add/export supported service adapter construction or keep client in a narrow new package |
| [remote-memory-port.ts](../../../packages/sage/src/remote-memory-port.ts) | Retain local legacy path; do not confuse project-daemon reconnection with WrongMemory transport |
| [project-server client](../../../packages/sage/src/project-server-client.ts) | Local mode only; suppress spawn if external owner holds the store |
| [host-wiring.ts](../../../packages/sage/src/host-wiring.ts) | Reuse injection/capture/remap hooks; negotiate maintenance ownership and avoid duplicated schedules |
| [CLI sage wiring](../../../packages/cli/src/wiring/sage.ts) | Continue shared setup; report effective backend/health without separate implementation |
| [SAGE tool factories](../../../packages/sage/src/tools/memory-tools.ts) | Keep external schemas/permissions; propagate trusted caller session and service revision errors |
| [MCP adapter](../../../packages/sage-mcp/src/adapter.ts) | Resolve service capability without a local-SQLite gate for external mode; retain local mode behavior |
| [attached MCP server](../../../packages/sage-mcp/src/attached-server.ts) | Keep explicit old attach-only mode; add documented forwarding/replacement path to independent service |
| [sage-connect planner](../../../packages/cli/src/sage-connect.ts) | Offer explicit WrongMemory launch target/replacement diff; preserve existing owned entries/skills |
| [vector port wrapper](../../../packages/vector-memory/src/sage-port-wrapper.ts) | Select exactly one fusion owner; no host + daemon double RRF |
| [vector event mirror](../../../packages/vector-memory/src/sage-event-mirror.ts) | Avoid duplicated re-embedding and distinguish independent vector corpus from SAGE mirrors |
| [WebUI memory handlers](../../../packages/webui-server/src/server/memory-handlers.ts) | Delegate port operations; keep trusted management visibility and revision checks |
| [WebUI unified search contract](../unified-sage-search-backend-contract.md) | Preserve exclusion of all session records and corpus-specific scores/cursors |
| [WebUI service restarts](../../../packages/webui-server/src/server/connections/service-action-restarts.ts) | Restart project connection/lease rather than accidentally terminate the global daemon |
| [Memory Companion](../../../packages/fleet/src/host-memory-companion.ts) | Keep host-owned read-only review; obtain current records/evidence from adapter; preserve revision/source freshness |
| [Codebase ecosystem bridge](../../../packages/tools/src/codebase-index/ecosystem-bridge.ts) | Route path/symbol remap through the selected memory owner; coordinate later WrongIndex events |
| [HQ sync projection](../../../packages/sage/src/sqlite-store-hq-sync.ts) | Preserve export/apply semantics through trusted internal capability; not default MCP |

M0 also searches every direct `SqliteSageStore`, `createSqliteMemoryPort`, legacy import, doctor/maintenance, clear/purge, and container consumer. This map is a concrete start, not proof that no other call sites exist.

## 5. Operation mapping

| Existing capability | Service use case |
|---|---|
| `remember/read/list/search/findRelated/scoreRelevant` | Legacy compatibility surface with the same scope/result mapping |
| `rememberSage/updateSage/deleteSage` | Canonical mutations with revision/action grants and durable receipts |
| `retrieveForPath/searchSage/searchSageWithBreakdown` | Policy-bound recall plus negotiated channel explanations |
| `retrieveForAudience/findRelatedSage/findMemoriesForFile` | Audience/graph/file retrieval under trusted session/workspace |
| `unifiedSearchService/listSagePage/getSage` | Distinct relevance/library/exact-ID management policies |
| `recordInjection/recordUse` | Deduplicated attributed telemetry without content recency churn |
| `create/list/accept/reject/resolveCandidate` | Review workflow with target/member revision checks |
| `verify/verifyForPaths/hygiene/maintenance/doctor` | Bounded direct operation or durable job, preserving existing wrapper completion semantics |
| `recoverSage/backfillRecoverable` | Dry-run/apply recovery with explicit results |
| `getHqSyncVersion/listHqSync/applyHqSync` | Trusted synchronization adapter with current projection/conflict semantics |

The current [project-server operations](../../../packages/sage/src/project-server-protocol.ts) provide the initial inventory, including import/consolidate/admin compatibility. Do not drop less-visible operations simply because the default MCP list does not expose them.

## 6. Session identity and host context

WrongStack already knows an active agent session, role/mode/task classification, tool result, and rendering location. Bind that through the trusted host grant to a daemon session capability. External MCP cannot claim access to the same session by copying its string ID.

Session resume/rewind/fork/subagents need explicit rules: resume the same trusted durable session only with appropriate capability; fork receives its own ownership identity unless the product explicitly shares selected memory; role/audience is applicability metadata, not a replacement for session authorization.

WebUI access tokens do not establish an agent session. Its normal search/exact-ID navigation excludes session records, including legacy unowned ones. Retain this policy even when the daemon supports broader trusted management APIs. Hidden/absent records must not be distinguishable through vector navigation or totals.

## 7. Injection and capture behavior

Continue using `setupSage` with the selected port:

- Concrete tool-result memory retrieval remains the default.
- Optional turn-context retrieval stays opt-in.
- Request-time evidence refresh revalidates selected revisions/source evidence before rendering.
- One injection tracker connects tool and turn paths; avoid duplicate use credit.
- Outcome/error capture stays behind its existing flags.
- Domain-term extraction and its markdown mirror retain one producer per host/project policy.
- Successful path/symbol edits remap anchors through the selected owner.
- Session-end extraction/triage produces attributed candidates using the current policy.
- Teardown releases resources and awaits required writes; it is not the only maintenance scheduler.

Inside WrongStack, do not automatically install the external MCP bridge alongside native SAGE tools. ACP workers can deliberately receive a scoped WrongMemory MCP endpoint with task-start guidance, but it should point to the same project owner and retain worker/proposer permissions.

## 8. Event mapping and cache invalidation

Map committed service events to current `memory.accepted`, `memory.updated`, `memory.deleted`, injection/use, review, verification, maintenance, and relevant host event shapes. Preserve trace/request/session attribution without trusting client-supplied audit identity.

Maintain local caches keyed by project/store epoch, record revision, purpose/visibility, and semantic provider. Warm vector/exact-ID/review caches cannot survive a relevant revision or grant change. Reconnect fetches a new snapshot/change cursor and resyncs mirrors if replay was lost.

Keep content, usage, verification, and provider events distinct so a counter bump does not launch re-embedding, HQ replication, or a full WebUI refresh. Older hosts lacking a new optional operation may receive an explicit unsupported capability; core behavior cannot silently disappear.

## 9. Availability and safe fallback

On daemon disconnect: mark service unavailable/degraded, preserve committed data, reconnect/restart under policy, retry reads safely, and resolve uncertain writes through receipts. Host request-time injection can omit unavailable memory with an observable reason rather than block the coding session indefinitely; explicit user memory operations receive errors.

No fallback from a timeout to an inline SQLite writer. `auto` may return to local only after supported ownership release/recovery and profile/location validation. A managed external store may have no valid legacy-local fallback until exported. A user sees that concrete constraint, not an apparently empty memory store.

One host closing, one WebUI reconnect, or one MCP bridge EOF must not stop the machine's memory service or another project's maintenance.

## 10. Rollout sequence

1. Freeze current source/fixtures and install adapter behind an opt-in flag.
2. Run fixture-based read/write differential tests through native IPC.
3. Demonstrate supported legacy-to-service ownership transfer on disposable copied databases.
4. Prove one WrongStack host and one external MCP client share the same committed memory/review state.
5. Prove project/session isolation with multiple concurrent clients and linked worktrees.
6. Adopt an explicitly selected real project only during a separately requested implementation/deployment step with a consistent backup.
7. Run controlled preview with disclosed legacy worker dependency if needed.
8. Replace backend with native Rust after full SAGE parity, retaining the same adapter.
9. Enable auto discovery/default behavior only after restart, rollback, and incompatible-client gates pass.

## 11. End-to-end connection acceptance

Required demonstration:

- WrongStack boots with `wrongmemory` mode and reports its actual store/owner/profile.
- Existing memory is recalled through a normal anchored tool result with correct revision/applicability.
- An external agent proposes a memory while WrongStack is closed; candidate persists.
- WrongStack reopens and reviews/accepts that candidate; external search sees the accepted revision.
- A second project cannot read the candidate, ID, graph, counters, or vector entry.
- A session-private memory remains hidden from the external default client and WebUI discovery.
- Source edit/rename updates evidence/remaps without erasing conditional knowledge.
- Daemon restart recovers committed writes; host close does not stop other clients.
- Supported rollback restores the intended local owner/location without duplicate authoritative stores.

Record actual commands, build/profile IDs, source/store paths, IDs/revisions, query results, and ownership receipts. Do not claim integration from type compatibility alone.
