# Tool governance implementation and validation

Date: 2026-10-31. Base commit: `03fd39be8b9b894d9c96855e00fd7533f62db2a7`.

Later validation and blocker fixes are recorded in the [follow-up report](tool-governance-followup-2026-10-31.md); the results below describe the initial implementation stage.

The safety, catalog, schema-budget, alias/deprecation and usage-reporting foundations are implemented in the existing shared checkout. Repository-wide certification is **not clean**. No commit, push, release, deployment or installed-binary replacement was performed. Unrelated working-tree changes were preserved.

## Implemented behavior

- Registry metadata is projected through a shared machine-readable catalog. Built-in contract checks cover permission/risk consistency, descriptions, usage hints, icons and reviewed exceptions. Director descriptors have a separate complete contract check. Catalog drift and schema budgets participate in CI and the existing release-check matrix.
- A hard tool `deny` now takes precedence over queued one-shot approval and permissive autonomy. The defect was reproduced with a passing confirm-tool control before the policy and explanation paths were corrected. Alias denials remain effective; old alias grants do not silently become canonical grants.
- Aliases resolve through the registry, discovery, nested execution, ToolFlow and the CLI gateway. Canonical exposure boundaries and disabled-tool checks remain effective. Deprecation metadata and a two-minor compatibility policy provide a migration path; incompatible input schemas still require explicit adapters.
- Permission metadata was corrected for mutation tests, termination, plugin management and queued work. Paid/fan-out operations expose cost and retry hints on demand. The outer `tool_use` confirmation remains; this change does not claim fully dynamic gateway permission inheritance.
- Icons and colors have one canonical definition with a compatibility re-export. All 78 built-ins and all 190 names in the supplied audit inventory resolve to a non-fallback icon. Unknown third-party names can still use the fallback.
- Generated JSON and per-tool documentation use the shared projection. The website generator consumes it too. `wstack tools catalog --json --check` exports the active CLI registry; WebUI introspection can opt into the active session catalog without enlarging its normal response.
- Schema budgets measure actual tool wire-schema projection by tier, including the six-tool lean profile. Host metadata does not enlarge the provider schema. These estimates exclude prompts, provider wrappers, runtime additions and billed token accounting. Increasing a checked-in budget requires an explicit adoption flag.
- Usage reporting reads journal events without retaining arguments, results, session identifiers or journal paths. Invocation counts now count settled execution once instead of counting both start and completion. The report reconstructs calls from real core journal message records and joins results by call identity.

Implementation policy and selection guidance: [Tool governance](../docs/tool-governance.md). Generated artifacts: [catalog](../architecture/tool-catalog.json), [schema budgets](../architecture/tool-schema-budget.json), [tool reference](../docs/tool-reference.md).

## Scope and usage evidence

The generated catalog contains **78 built-ins**. The isolated built CLI smoke exported **54 enabled registered tools** in its default standalone context. The supplied **190-row audit inventory** includes a different runtime surface; it is not interchangeable with either count and was not presented as a fresh live host inventory.

The [usage sample](tool-usage-sample-2026-10-31.json) covers 20 stable recent local project journals within the October reporting window: **1,663 calls, 13 observed tool names, zero unmatched result records**. The six lean tools account for 1,525 calls (91.7%). Journal selection is bounded and excludes recently changing files. Absence from this sample does not establish that a tool is unused.

The proposed memory, tracker, fleet and URL-fetch mergers do not have enough usage evidence in this sample. No tools were removed, no compatibility names were renamed, and no tier was changed on that evidence. Alias infrastructure makes a later measured migration possible.

## Validation evidence

| Check | Result and boundary |
| --- | --- |
| Core security suite | **PASS:** 55 files, 1,397 tests passed, 2 skipped. Includes hard-deny and alias permission regressions. |
| Coordination suite | **PASS:** 184 files, 2,940 tests passed, 1 todo. |
| Final focused integration batch | **PASS:** 7 files, 106 tests passed, single worker. Includes ToolFlow aliases, CLI gateway allow/deny/disabled boundaries, index freshness, nested execution, registry and WebUI introspection. |
| Production typechecks | **PASS:** core (638 source files), tools (392), coordination (190), WebUI server (325), CLI production (616). |
| Catalog, schema budgets and website drift | **PASS:** fresh dependency-closure build; 78 built-ins, 78 icons, 12 selection contracts; six schema profiles within budget. |
| Built CLI smoke | **PASS:** compiled CLI, isolated empty application home and explicit environment allowlist; schema version 1, 54 registered tools, exit 0, empty stderr. No provider calls. |
| Core API snapshots | **PASS:** snapshots regenerated and checked; generator uses the pinned formatter for writing and comparison. |
| Scoped formatting/lint and whitespace | **PASS:** owned supported source/config files checked with Biome; `git diff --check` passed. |
| Documentation | **PASS:** documentation/catalog/link checks. Counts can include concurrent unrelated workspace additions. |
| Broader related test batch | **NOT CLEAN:** 401 files: 397 passed, 1 failed, 1 skipped, 2 workers exited with code 9; 5,834 tests passed, 1 failed, 19 skipped. Windows `bash-treekill-win32` grandchild cleanup assertion failed. Both worker-exit files passed later in isolation; this does not make the batch clean. |
| Full root test attempt | **NOT CLEAN:** intermediate mutable-tree run: 4,343 files, 4,315 passed, 16 failed, 12 skipped; 56,062 tests passed, 19 failed, 71 skipped, 1 todo, plus an unhandled HQ rejection. Some then-failing owned cases were subsequently fixed and rerun. Parallel cache activity also produced an ENOENT. This was not final-tree certification. |
| CLI complete typecheck command | **FAIL outside owned changes:** test callers in `kanban-run-mirror.test.ts:307` (TS2554) and `embedded-session-agents-fallback.test.ts:114` (TS2322). Production CLI checking passed. |
| Global test typecheck | **NOT CLEAN:** 43 projects, 1,200 diagnostics, 536 unique; baseline 1,920. There are 32 newly unique diagnostics / 96 added occurrences, zero in owned files, and no unparsed failures. Baselines were not loosened. |
| Architecture report | **NOT CLEAN globally:** no new owned hotspot, test-only export or cycle violation. Existing/concurrent provider-routes, desktop-v2 ratchets and CLI HQ test-only-export findings remain. Report-only success is not a clean architecture gate. |
| Hosted CI, full release certification, publication, live browser rendering and external MCP-client integration | **NOT RUN.** |

The final focused batch was run with `bun --bun run vitest run` and `--maxWorkers=1` over `tool-script.test.ts`, the three CLI tools suites (main, grants/batch and index freshness), `nested-tool-call.test.ts`, registry `tool-governance.test.ts` and WebUI-server `introspection-routes.test.ts`. Vitest/build writers were serialized for the final checks. The project used pinned Bun 1.4.3, Vitest 5.0.5 and Biome 2.5.13.

## Remaining work and limits

The original 32 suggestions are a roadmap, not 32 completed changes. Actual consolidation, a new aggregate diagnostics tool, universal domain error codes, uniform truncation migration, complete selection coverage, scheduled audit publication and per-tool reference website pages remain follow-up work. Existing result/error contracts are reused rather than replaced wholesale. New metadata fields are additive; automatic retries are not enabled.

The built-in CI checks and Director checks do not prove correctness of arbitrary future plugin/MCP metadata. Runtime catalog exports surface declared issues for those registrations. The one reviewed Director exception is bounded, attributed in-process `fleet_emit`; its exact capabilities and rationale are pinned in tests and policy. Four existing long descriptions have individually bounded documented exceptions rather than a blanket lint bypass.

Final acceptance is therefore: the implemented foundations and targeted regressions pass their stated checks; the repository remains uncertified until the explicitly listed broader failures are resolved and the full gates are rerun on a stable final tree.
