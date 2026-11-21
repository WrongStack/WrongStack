# Tool portfolio, package boundaries, and request budgets

**Date:** 2026-11-21  
**Checkout:** WrongStack `main`, `15a18aaff`  
**Decision record:** Recommendations for the original catalog, followed by the Quick implementation described below. The portfolio measurements refer to the original checkout above.

## Decision

Keep the everyday file, shell, clarification and discovery tools in the default request. Ship Code Intelligence, Git and development tooling as enabled capabilities with most schemas deferred. Make Browser, LSP, Design and Media, Automation, Fleet, ToolFlow and external integrations opt-in by group. Move administrative and passive diagnostic operations to CLI/UI or host events wherever possible.

The first package extractions should be **Browser** and **Code Intelligence**. **ToolFlow** is a third, smaller extraction if it can own QuickJS and its integration tests independently. Everything else can start as logical groups in existing packages. An extraction changes installation and runtime dependencies. The request budget changes when the provider projection and discovery policy change.

## What was measured

| Surface | Schemas | Shared wire bytes | Estimated tokens |
|---|---:|---:|---:|
| Full generated built-in catalog | 82 | 103,584 | 28,652 |
| Canonical runtime, token saving off, browser false | 66 | 95,039 | 26,392 |
| Canonical runtime, medium | 57 | 86,539 | 24,064 |
| Canonical runtime, minimal | 30 | 31,744 | 8,724 |
| Quick, built-ins only, both shell tools present | 11 | 14,687 | 4,073 |
| Scout, built-ins only, before learned tools and optional host services | 13 | 16,418 | 4,543 |
| Proposed Quick, Bash slot, current `clarify` schema | 9 | 12,991 | 3,611 |
| Proposed Scout, Bash slot, current `clarify` schema and artifact support | 12 | 15,148 | 4,192 |
| Six-tool benchmark | 6 | 5,304 | 1,448 |

The generated catalog uses raw built-in definitions. Its medium ceiling is 57 / 86,843 bytes / 24,148 estimated tokens. The runtime rows use the registered tools and the real variant selector with no additional host services. The costs use the shared wire projection, prior to provider-specific adaptation. They exclude system prompt prose, tool responses, provider-native tools and billed token accounting. The separate one-shot CLI command `wstack tools catalog --json --check` returned **57** entries using the checkout's effective configuration. That command reports its registration surface, while Quick/Scout selections are resolved per conversation. A previous configured host snapshot included 190 names, including overlapping first-party packages and plugins. [Schema budget](../architecture/tool-schema-budget.json), [canonical registration](../packages/runtime/src/tool-registration.ts), [one-shot registry](../packages/cli/src/tool-gateway.ts), [prior runtime inventory](tool-audit-2026-10-31.md)

| Family or tool | Schemas | Estimated tokens | Decision |
|---|---:|---:|---|
| Work tracking (`todo`, `plan`, `task`, `kanban`) | 4 | 8,139 | Give session tracking one small surface. Enable the shared board explicitly. |
| `kanban` alone | 1 | 6,588 | Largest immediate saving in medium. It accounts for about 27% of the measured medium schema estimate. |
| Codebase index tools | 17 | 3,996 | Ship capability with coding profiles. Start most of it on demand. |
| Browser family | 16 | 2,176 | Explicit group opt-in and separate package. |
| `clarify` alone | 1 | 1,758 | Keep the direct route. Compact the common form and defer advanced forms. It accounts for about 43% of the current Quick estimate. |
| SAGE including two compatibility reads | 17 | 6,306 | Host memory can stay active. Expose one search and one save through the appropriate profile, with maintenance elsewhere. |
| Coordination factory inventory | 23 | 10,663 | Team and worker presets only. |
| Management factory inventory | 19 | 7,044 | CLI/UI for configuration and a few deferred, task-facing capabilities. |

SAGE, coordination and management totals were measured from current factories with stub ports. They describe possible surface sizes. Each host chooses which factories and tools to register.

### Observed usage

The WrongStack project journals contained **1,328 settled calls across 18 inspected journals**, with tool events in 14, from 2026-11-01 through 2026-11-21 09:36 UTC. The scan selected project journals modified in the window, up to 40 files and 16 MiB each. Eighteen qualified, with zero oversized, malformed or unsettled inputs. Only tool names and counts were aggregated.

- Files and shell accounted for **1,164 calls (87.7%)**. Shell usage was `exec` 244, `pwsh` 128 and `bash` 80. The six-tool Bash benchmark slice covered **792 (59.6%)**. Preserve an explicit route for structured argv and Windows-native shell use.
- `skill` was used **64 times in 10 sessions**. The Code Intelligence family recorded **44 calls** and SAGE search/save **15**. `project_kit` appeared six times in four sessions. These support keeping reliable discovery or role-specific exposure.
- The October sample had 1,663 settled calls and a 91.7% six-tool share. The November mix shows why a single corpus cannot settle a cross-platform default or justify deleting a tool with no observed calls. [October sample](tool-usage-sample-2026-10-31.json), [usage report implementation](../packages/core/src/observability/tool-usage-report.ts)

## Default system prompt surfaces

| Prompt or role | Direct provider choices | Prompt guidance |
|---|---|---|
| **Quick** | `read`, `write`, `edit`, `glob`, `grep`, one native shell (`bash` or `pwsh`), compact `clarify`, `tool_search`, `tool_use`. Add `exec` for a launch policy that needs structured argv. Add `skill` for mandatory playbooks. Code Intelligence and Kanban can be enabled live and stay deferred. | One line for finding and calling a deferred capability. Preserve the existing on-demand skill pointer for ordinary Quick. |
| **Lite** | Quick base plus `exec`, `skill` when enabled, and a small `todo` when session tracking is active. | One tracking route and one small verification hint. |
| **Default / Pro** | Lite base plus `codebase-search` and `codebase-context` when the index is usable. `context_manager` only for host-managed long-context sessions, and `present_artifact` when the host can present it. | Explain where to start in a large repository. Each specialist gets its own task instructions and tool slice. |
| **Scout** | Quick base plus `search` and `fetch` when web is enabled. Add `present_artifact` on artifact-capable hosts and `skill` when the skill manifest is active. Prefer `glob`/`grep` in the base and defer extra execution tools. | Brief guidance for public sources, artifacts and discovery. Fleet, browser and MCP guidance belongs to enabled group or role instructions. |
| **Team / specialist / worker** | Grant an explicit role slice. Team leaders start with `delegate`, `await_tasks` and, when collaboration is active, the appropriate fleet status or mail tool. Workers that need a structured completion get `submit_result`. Browser and LSP workers receive their own bounded slices. | State the operational contract only for the active roles. Solo sessions get no spawn tools. |
| **Benchmark / headless integration** | Honor its explicit allowlist. Keep the six-tool lean benchmark and its gateway exclusions. | Use the pinned harness prompt and report its own wire measurements. |

Normal CLI launch currently pins Quick when the user has not selected another preset or host profile. The shared factory configuration declares Pro, and WebUI or embedded hosts can choose their own profiles. Carry those entry-point choices through migration. Treat writing guidance and serializing schemas as two separate costs. The prompt builder currently emits a usage block from direct tools in addition to provider definitions. Keep only guidance that adds selection or safety information, and avoid duplicating full descriptions or specialist menus in both places. [CLI boot](../packages/cli/src/boot.ts), [defaults](../packages/core/src/storage/config-loader/defaults.ts), [variants](../packages/core/src/registry/scout-tool-surface.ts), [prompt builder](../packages/core/src/core/system-prompt-builder.ts)

## Package extraction decisions

| Priority | Package or capability | Why and where to draw the boundary |
|---|---|---|
| 1 | **Browser** | Move Playwright, browser ownership, process/profile lifecycle and trace/screenshots together. The browser implementation loads Playwright lazily and can provision it in a versioned cache. File-based artifact presentation can load the browser adapter only for a browser session. Keep `e2e_plan` in the browser/E2E profile as a read-only planning capability. [Browser runtime](../packages/browser-tools/src/runtime.ts), [artifact presentation](../packages/tools/src/present-artifact.ts), [binary externals](../scripts/build-binaries.mjs) |
| 2 | **Code Intelligence** | Extract index service/readers and their tool adapters as a cohesive boundary. The source tree has 14 tree-sitter WASM files totaling **25,369,760 bytes** before packaging. The existing MCP executable, WebUI CodeMap/completion, LSP bridge and SAGE anchors already consume the index. Keep one index and existing state/daemon ownership. Move generic ignore and path helpers to a shared dependency so file navigation can run without the index package. Keep AST writes as a distinct policy group over the same service. Measure release archives and cold start after extraction. [Index service](../packages/tools/src/codebase-index/index.ts), [WASM loader](../packages/tools/src/codebase-index/tree-sitter-parser.ts), [MCP adapter](../packages/codebase-index-mcp/src/adapter.ts), [WebUI file search](../packages/webui-server/src/server/file-content-search.ts) |
| 3 | **ToolFlow** | One schema, about 372 estimated tokens. QuickJS ownership and the nested executor boundary justify an optional package if they can be isolated. Make it an opt-in group first. Keep `tool_script` and declarative Project Kit as separate capabilities, with existing child-call governance. [ToolFlow](../packages/tools/src/tool-script.ts) |
| Existing packages | **LSP, SAGE, Vector Memory, Coordination, Telegram and MCP** | Use existing workspace boundaries. LSP is enabled per project/language. Keep SAGE's data, compatibility and retention routes. Enable vector memory independently. Fleet and Telegram stay profile-specific. Treat each MCP server as its own configured group. [LSP](../packages/plug-lsp/src/index.ts), [SAGE](../packages/sage/src/index.ts), [Vector Memory](../packages/vector-memory/src/tools.ts), [Telegram manifest](../packages/telegram/src/manifest.ts) |
| Logical groups in place | **Git/Dev Checks, Languages/Packages, Web, Design/Media, Project Kit, Work Tracking, Diagnostics and Release** | Group first. Most wrappers share existing tools or plugin services. Keep HTML conversion and PDF handling behind their existing lazy boundaries until an independent install has a measured benefit. Structured Git, dependency installation, test runners and graph-based QA retain separate policies wherever effects differ. [Tool dependencies](../packages/tools/package.json), [official plugins](../packages/plugins/src/manifest/index.ts) |

## All 82 built-ins

**Direct** ships a schema in the indicated standard profile. **Deferred** ships the capability without a recurring schema. **Opt-in** starts disabled in ordinary profiles and is reachable only after trusted enablement. Host-only options can expose their operations through UI, CLI or a specialist contract. Every built-in name below is assigned exactly once. [Current catalog](../architecture/tool-catalog.json)

| Group | Placement | Canonical tool names |
|---|---|---|
| Files | Direct in standard profiles | `read`, `write`, `edit`, `glob`, `grep` |
| Execution | Native shell direct, `exec` direct for structured execution profiles and deferred in ordinary Quick | `bash`, `pwsh`, `exec` |
| Interaction and discovery | Direct, compact clarification form | `clarify`, `tool_search`, `tool_use` |
| Artifact delivery | Direct on artifact-capable Scout/Pro, otherwise deferred | `present_artifact` |
| File utilities | Deferred; `tree` is a possible CLI/compatibility surface | `diff`, `patch`, `replace`, `tree`, `json` |
| Git and checks | Deferred in coding profiles | `git`, `lint`, `format`, `typecheck`, `test` |
| Dependency and language operations | Deferred in coding profiles. Keep install/mutation permission explicit. | `language_info`, `language`, `language_package`, `install`, `audit`, `outdated` |
| Public web | Scout direct search/fetch, deferred in Quick/coding profiles where allowed. Migrate the redundant URL reader once parity is proven. | `search`, `fetch`, `read_url_content` |
| Code Intelligence reads | Two entry points direct in indexed Default/Pro. The rest are deferred. | `codebase-search`, `codebase-context`, `codebase-read-symbol`, `codebase-skeleton`, `codebase-repo-map`, `codebase-impact-analysis`, `codebase-diff-impact`, `codebase-flow-trace`, `codebase-onboard`, `codebase-atlas`, `codebase-incoming-calls`, `codebase-outgoing-calls` |
| Index lifecycle and QA | Deferred. Stats and rebuild should also have CLI/UI routes. | `codebase-stats`, `codebase-index`, `codebase-targeted-test`, `codebase-invariant-check`, `dead-code-scan`, `security-ast-scan` |
| AST writes and automated cleanup | Opt-in for a refactor/audit workflow | `codebase-ast-replace`, `dead-code-fix` |
| Browser and E2E | Opt-in. Keep lifecycle and interaction together. Expose `browser_status` on demand or through the doctor. | `browser_open`, `browser_list`, `browser_status`, `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_type`, `browser_click`, `browser_hover`, `browser_select`, `browser_press`, `browser_drag`, `browser_wait`, `browser_evaluate`, `browser_upload`, `browser_close`, `e2e_plan` |
| Session work tracking | Small `todo` when tracking is active. `plan` and `task` deferred or host-driven for existing stored plans/tasks. | `todo`, `plan`, `task` |
| Board | Available on demand for project/team boards. Auto resolves to enabled for a session explicitly working from a board. Scope schemas by operation and keep the current board ID, evidence and governance contracts. | `kanban` |
| Process and session automation | Opt-in with active-job cleanup. `logs` is deferred in the diagnostics profile. | `process_watch`, `process_watch_control`, `session_wakeup`, `logs` |
| Project recipes | Deferred for projects with recipes. Inspection and execution keep distinct permissions. | `project_kit`, `project_kit_run` |
| Script composition | Opt-in with the same policy for each child call | `tool_script` |
| Design and references | Opt-in in design profiles | `design`, `design_reference` |
| Architectural decisions | Deferred in architecture/review profiles. Evaluate the overlapping decision-journal plugin contract before consolidation. | `architecture_decisions` |

## Host, plugin and integration placements

| Group | Placement and names |
|---|---|
| Skills and session protocol | `skill` as described above. `context_manager` deferred outside long-context profiles. `nextsteps` remains opt-in for hosts using structured final suggestions. `session_rename` and `session_branch` belong to CLI/UI, with an explicit session-management capability for agent-driven flows. |
| SAGE and legacy memory | Prefer `memory_search` and `remember` when agent memory is enabled. Make `memory_for_file`, `memory_for_path`, `memory_graph`, `memory_gather_batch`, `memory_candidates` deferred. Move `memory_search_explain`, `memory_verify`, `memory_hygiene`, and `memory_backfill_recoverable` to maintenance/diagnostics. Keep `memory_recover`, `memory_delete`, `memory_update`, `forget` in explicitly scoped memory management. Keep `search_memory` and `find_related_memories` as backend compatibility paths while they have callers. |
| Vector memory | Independent opt-in for `vector_memory_remember`, `vector_memory_search`, `vector_memory_stats`, `vector_memory_forget`; expose two backend choices only where users need to compare them. Stats are host diagnostics. |
| Language servers | Opt-in for `codebase-lsp-search`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols`, `lsp_diagnostics`, `lsp_completion`, `lsp_code_actions`, `lsp_rename`, `lsp_execute_command`, `lsp_request`. Prefer typed operations for model calls. Keep raw request/command at specialist or operator level. |
| Fleet work | Team group for `delegate`, `await_tasks`, `ask_result`, `ask_subagent`, `assign_task`, `spawn_subagent`, `define_subagent`, `roll_up`, `kanban_queue`, `fleet`, `fleet_status`, `fleet_emit`, `collab_debug`, `work_complete`, `terminate_subagent`, `terminate_all`. Give lower-level lifecycle calls to the team operator or explicit orchestration presets. `submit_result` belongs to workers. `quality_gate` and `mutation_test` belong to verification specialist profiles. |
| Collaboration | `mail_send`, `mail_inbox`, `mailbox` and `session_note` are enabled only with team collaboration. Keep mailbox-specific administrative operations for operators. `fleet` is Director-local and `fleet_status` is project-wide. Preserve both distinct contracts when reducing direct choices. |
| Provider and plugin control | CLI/UI by default for `provider_key_set`, `provider_manage`, `plugin_manager`, `system_config_view`, `fallback_chain_manage`, `fallback_profile_manage`, `favorite_manage`, `agent_model_assign`, `leader_model_set`, `leader_effort_set`, `leader_tier_set`. Grant explicit agent administration only in an operator profile. |
| Provider utilities | `image_generate` opt-in with Media. `council`, `llm`, `jev` opt-in with paid model assistance. `jev_status` is a diagnostic. |
| MCP and Telegram | `mcp_control` is operator control. Use `mcp_use` or the common lazy gateway for enabled servers. Server groups cover all `mcp__<server>__<tool>` names and later registrations. `telegram_approve`, `telegram_read`, `telegram_send` are explicit integration opt-ins. Inventory custom servers from each host's active registry. |
| Historical cron names | `cron_schedule`, `cron_list`, `cron_cancel` were in the 190-tool snapshot. The current repository search did not find matching first-party tool registrations. Existing automation CLI is its own supported surface. |
| Exported compatibility | `mode` is an exported factory. No first-party registration or implementation caller was found outside exports and tests. Keep the host's `/mode` command independently. |

The official plugin registrations in Appendix A follow one rule. Passive status goes to CLI/UI or events. Explicit inspection and write actions stay deferred inside their enabled plugin group. Optional plugin code and hooks follow their own activation policy. Existing default safety hooks can keep running with zero model schemas for their counters. In particular, turning off the diagnostic tools alone should never turn off `secret-scanner`, `dep-guard` or `injection-shield` protections. [Plugin defaults](../packages/plugins/src/manifest/index.ts), [plugin registration API](../packages/core/src/plugin/api.ts)

The nine host plugins include LSP and Telegram, whose agent tools are covered above. The other seven provide host commands or hooks. Keep `wstack-prompts`, `wstack-sync`, `wstack-cloud-config-sync` and the `wstack-skills` management commands at the operator surface. `wstack-chimera`, `wstack-auto-review` and `wstack-specialist-triggers` can use explicit worker profiles when active. [Host plugin catalog](../packages/plugins/src/plugin-audit-catalog/index.ts)

## Retirement and consolidation

| Candidate | Recommended action and evidence |
|---|---|
| **`mode` as a model tool** | Strongest dead registration candidate. The factory has an exported entry point, so remove it after checking or deprecating that export for SDK/embedded callers. `/mode` already owns the operator path. [Factory](../packages/tools/src/mode.ts), [slash command](../packages/cli/src/slash-commands/mode.ts) |
| **`read_url_content` as a standalone schema** | Best merge candidate. Both it and `fetch` read and convert HTML. Preserve `maxBytes`, URL compatibility, output fields and the intended URL policy. Today the two tools have different permission metadata and behaviors, so retain a tested compatibility adapter until parity is covered. [URL reader](../packages/tools/src/read-url-content.ts), [fetch](../packages/tools/src/fetch.ts) |
| **Per-plugin passive status schemas** | Remove from default direct and discovery surfaces. Preserve status data through diagnostics/events. If models need to explain a specific failure, expose one narrow, deferred read-only status query keyed by an enabled service. Keep actionable workflows such as verification evidence and browser setup as distinct operations. |
| **`tree`** | Can lose its standalone model schema if path listing supports depth, hierarchy, ignore rules and bounded output. Keep a CLI projection or adapter until those features and role prompts are migrated. [Tree implementation](../packages/tools/src/tree.ts) |
| **`search_memory`, `find_related_memories`, `mailbox`** | Reduce double exposure. Memory names have explicit roster/skill compatibility. Mailbox actions cover more than send and inbox. Use typed adapters or operator routes for the unique operations before retiring a schema. [Memory registration](../packages/runtime/src/tool-registration.ts), [mailbox](../packages/coordination/src/mailbox-tool.ts) |
| **`plan`, `task`, `kanban`** | Reduce three models worth of default guidance. Preserve stored plans, task IDs/dependencies, board history and goal/SDD/fleet consumers. Measure after isolating session tracking from board operations. |
| **`test_impact_analyze`, `codebase-diff-impact`, `codebase-targeted-test`** | Keep deferred. One recognizes evidence text, one maps change impact, and one chooses/runs tests. Share output conventions where sensible. |
| **`exec`, `pwsh`, `bash`, `e2e_plan`, `logs`** | Keep the capabilities. The shell tools serve distinct argv, platform and lifecycle needs. E2E planning has a role consumer. Logs can fetch a bounded Docker tail, while process watchers support subscription, scheduling and owned teardown. |

No currently registered executable family was proven unused across hosts, roles, skills and integrations. The evidence supports schema retirement now and implementation deletion only with consumer, permission and compatibility checks. A low-use observation alone cannot establish that an emergency or role-specific operation is redundant.

## Make disabled mean absent from the model context

Today, canonical registration admits every built-in before applying its provider projection. A read-only probe of the production registry confirmed that browser false still left 16 browser tools in the catalog, and that exact-name `tool_search` returned the full `browser_open` schema. Disabling `tool_search` in a minimal registry widened the measured Scout and Default provider surfaces to 81 definitions, including those 16 browser tools. Quick stayed at 10. Plugin registration can also promote every plugin tool directly in tier-based sessions. [Registry](../packages/core/src/registry/tool-registry.ts), [variant selector](../packages/core/src/registry/scout-tool-surface.ts), [discovery](../packages/tools/src/tool-search.ts)

1. **Use one effective group policy.** Resolve canonical names, alias targets, late plugin registration and MCP server ownership before building the session view. Use stable group identifiers instead of UI categories or name-prefix heuristics. Trusted explicit disables win over profile defaults, learned Scout tools, plugin registration, agent roles and per-tool promotion. A disabled group stays disabled in the full token-saving tier and cannot reopen through a model request.
2. **Model three separate decisions.** Decide whether the capability is installed, whether it is enabled for the session, and whether an enabled tool is direct or deferred. Disabled operations disappear from provider tools, system prompt hints, skill manifests that require them, discovery output and nested execution. Apply live group changes to the next request. Serve new deferred schemas with the request-scoped design below. Keep explicit operator catalogs for reconciliation and diagnostics.
3. **Search compactly.** Broad `tool_search` should return enabled names and short descriptions. Retrieve a single schema for an exact-name selection. The current search result includes up to three full input schemas plus usage metadata and can return a large `kanban` schema in ordinary context. Route calls through the existing governed executor. Keep explicit schema-validated invocation and avoid copying disabled schemas into errors or coaching.
4. **Keep bounded behavior when gateways are off.** If discovery or invocation is disabled, preserve the explicit direct allowlist and report missing discovery support to the operator. Keep documented direct and deferred behavior consistent between Quick, Scout, Pro, WebUI, CLI and embedder cases. Distinguish `mcp_control` server activation from permission to execute an enabled server tool.
5. **Keep existing permission contracts.** Apply the same effective policy to native calls, `tool_use`, `tool_script`, `mcp_use`, aliases, worker slices and any CLI/MCP gateway with the same session policy. Resolve the target before checking permission. Keep approved in-flight operations and cancellation behavior under the host's lifecycle rules. Changes to package install, credentials, scheduling or hooks remain explicit.

### Quick group settings

Use the same compact control in the TUI and WebUI, with individual rows for Code Intelligence, Kanban and other optional groups. The CLI equivalent can extend the existing `/tool` command with `/tool group codebase on`, `/tool group kanban off` and `/tool group kanban auto`. The setting applies to the current conversation from its next provider request, without a restart. Offer an explicit action to remember the selection as a project preference. Show the effective state and the reason when policy limits a choice. [CLI tool settings](../packages/cli/src/slash-commands/tool.ts), [WebUI tool settings](../packages/webui/src/components/SettingsPanel/ToolsSection.tsx)

| Choice | Code Intelligence | Kanban |
|---|---|---|
| **Auto** | Enable in a coding project with an available index. Keep the group deferred in Quick. Default/Pro can expose the two selected index entry points. | Enable for an explicitly board-linked session or an active project/team board workflow. Ordinary Quick starts with zero Kanban schemas and a disabled group. |
| **On** | Make available through discovery in Quick. If an index is unavailable, report that state and offer the normal index setup path. | Make board operations discoverable from Quick immediately. Fetch the required schema on demand and reuse the existing project board and task references. |
| **Off** | Exclude the group from the conversation's provider schemas, prompt guidance, discovery and calls. The host can continue serving CodeMap and other sessions. | Exclude the group from the conversation's provider schemas, prompt guidance, discovery and calls. Board data and the operator's board UI stay available. |

Use trusted host facts for Auto, such as index readiness, an explicit board link and the session's governance policy. If the operator explicitly turns a group off, task text cannot turn it back on. If Kanban governance requires board access, show the group as required and explain why the toggle is locked. Users can change governance through its own operator setting. Keep per-tool denies and permissions authoritative. Do not queue group activation behind a new session or require users to toggle every member. [Kanban boundary](../packages/core/src/security/kanban-boundary.ts), [Kanban policy](../packages/cli/src/wiring/pipeline.ts)

### Keep the provider cache stable

Freeze the direct tool declarations and core prompt for each Quick session profile. Make Codebase and Kanban toggles update the conversation's discovery and execution policy. Keep the direct `tools` array, its order, the stable system text and provider routing keys identical across those changes. Put any current-group hint in the existing request-scoped context after the reusable prefix, with no cache breakpoint on that hint. Other profiles can choose extra direct tools when starting a session. An explicit change to the direct tool set or any wire-visible schema or description starts a new cache epoch.

Broad discovery should return names and compact summaries. Fetch one canonical schema on exact-name lookup. Put the schema body in the current request's tail, and keep only the tool call/result linkage, canonical name and schema revision in durable model history. Use the same request-scoped mechanism on retry and until the active invocation is resolved. The existing composer supports a tail outside the explicit cache boundary and a separate request-scoped suffix outside automatic-cache replay. Disabled groups must also drop any pending schema attachment. Old sessions that already persisted large schema results need an explicit clean context boundary if those results must be removed from future requests. That operation can rewarm the affected context.

Treat the runtime schema and provider projection as distinct parts of one tool contract. Keep one canonical name, version the input contract, and generate stable provider projections with deterministic tool and object-key ordering. Preserve arrays and validation semantics. Use a short revision or fingerprint in discovery references, with no per-turn metadata in direct definitions. Keep historical inputs accepted through compatible adapters when fields change. Validate each deferred invocation against the current authorized contract and return a bounded refresh hint on schema drift. Track wire fingerprints so a description-only change can be diagnosed independently of a breaking input change. Current cache-key normalization already canonicalizes fields for hashing, so verify the actual serialized order independently. [Request composer](../packages/core/src/core/agent-response.ts), [request-scoped context](../packages/core/src/core/request-scoped-context.ts), [cache key](../packages/core/src/utils/cache-key.ts), [provider schema projection](../packages/core/src/utils/tool-wire-compact.ts)

| Provider path | Cache acceptance |
|---|---|
| Anthropic | Direct tool declarations, system blocks and previously transmitted content through the stable boundary match byte-for-byte across group toggles. Changed hints or schema attachments appear after that boundary. |
| OpenAI and Codex | Preserve the existing routing/session key and the previously reusable prefix. Schema attachments sit outside automatic replay. Check final request bodies for regressions in both tool order and message placement. |
| Gemini explicit cache | Reuse the same cached content identifier across group toggles. The cached resource fingerprints the model, system instructions and complete direct function declarations. |

Use local wire fixtures for `off → on → exact lookup → invoke → off`, including a late plugin or MCP registration, a retry and a genuine base-schema revision. Compare the final serialized prefixes and routing keys, and verify no schema attachment is replayed after disabling the group. A warm live run with a matched baseline should also compare provider-reported cache-read and cache-write tokens. Matching request bytes controls cache invalidation from this feature. Server expiry, minimum cache sizes and routing still affect observed hits. [Anthropic projection](../packages/providers/src/tool-format/to-anthropic.ts), [Codex body](../packages/providers/src/openai-codex-body.ts), [Gemini explicit cache](../packages/providers/src/google.ts), [prefix probe](../packages/providers/src/prompt-cache-probe.ts)

## Suggested order and acceptance

1. Fix group policy and request projection first. Pilot the live controls with Code Intelligence and Kanban in Quick. Measure the serialized tool arrays at OpenAI/Codex, Anthropic and Google adapters with fixtures, plus the rendered model-facing prompt. Cover Auto with an available index, Auto in a board-linked session, a governance-required board and Off in a parallel conversation. Repeat group checks after late plugin/MCP registration. Exercise native and nested paths plus re-enable, alias compatibility and a missing gateway. Require zero names, hints and schemas for off groups in new request context, plus zero new runtime calls to those operations.
2. Make the direct presets small. Move Kanban out of medium, compact Quick's common clarification form and move routine diagnostics out of model tools. Suggested budget targets for shared built-in projection are **2,800 estimated tokens for ordinary Quick** and **4,500 for ordinary Scout**. Scope certificates and optional additions separately. Benchmark structured argv vs native-shell selection on Windows and Linux, including policy denials and tasks that need both. Check clarify form controls and TUI/WebUI parity.
3. Extract Browser and Code Intelligence after group gates work. Verify base installs omit optional payloads and browser provisioning, and that index, MCP, LSP, SAGE and WebUI consumers keep the existing data contract. Measure binary/archive bytes, cold start and first use. Consider ToolFlow next. Avoid one package per wrapper or one oversized action schema per group.
4. Deprecate duplicate model surfaces after migration. Track exposure and calls by host, profile, role, OS and group, including zero-exposure tools, deferred lookups, retries and failures. Record only metadata. Run representative disabled-group, connector and specialist workloads before deciding to remove implementation or SDK exports.

**Verification performed:** `bun run tools:catalog:check` and `bun run docs:check` passed under Bun 1.4.5. Four focused Vitest suites passed **29 tests** for canonical registration, schema budgets, Quick and Scout. The browser/fallback evidence used a standalone read-only registry/discovery probe. No network provider requests, full suite, release builds or production telemetry were used.

## Quick implementation

Quick has live controls for 12 groups through `/tool group` and WebUI Tools settings. A session can override its project default and later inherit it again. Project defaults live under the user's WrongStack state, and concurrent writes are merged under a file lock. The direct Quick schema list stays stable when groups change. Discovery returns compact summaries. An exact lookup loads a revisioned schema for the next provider request, outside durable history and automatic context replay. Turning a group off prevents pending schema delivery and applies the same reachability check to direct and nested calls. MCP tools follow a shared Quick group. Individual MCP servers retain their own existing operator controls. [Tool group guide](../docs/slash/tool.md), [request-scoped schema delivery](../packages/core/src/core/request-scoped-context.ts)

Browser automation and the shared origin policy now live in `@wrongstack/browser-tools`. The existing browser import path remains a compatibility facade, and built-in names are preserved. The workspace package is bundled with WrongStack. Playwright is a development dependency and the runtime provisions it on demand. Code Intelligence extraction, per-server Quick policy controls and live provider cache-hit telemetry remain open. [Browser guide](../docs/browser-automation.md)

## Appendix A. Official plugin tools

The source inventory contains 119 distinct declared names across 90 owners in `packages/plugins/src`. It covers direct registrations and the evidence-analyzer and workflow factories. Each row uses the existing plugin as the opt-in unit, except for already-default hooks whose diagnostic tools should become host-only. “Deferred” describes the proposed agent surface when that plugin group is enabled. Disable a plugin group to suppress all of its agent tools. [Plugin manifest](../packages/plugins/src/manifest/index.ts), [evidence analyzer](../packages/plugins/src/evidence-analyzer/index.ts), [workflow factory](../packages/plugins/src/workflow-runtime/index.ts)

| Owner | Deferred in an enabled group | Host UI, CLI or diagnostics |
|---|---|---|
| `acceptance-verifier` | `acceptance_verify` | — |
| `accessibility-auditor` | `a11y_audit` | `a11y_status` |
| `adversary-mode` | — | `adversary_mode_status` |
| `agent-handoff` | `handoff_note` | `handoff_status` |
| `api-compatibility-gate` | — | `api_compat_status` |
| `api-consumer-replay` | `api_consumer_replay` | — |
| `architecture-boundary-checker` | `architecture_boundaries` | — |
| `auto-doc` | `auto_doc` | — |
| `auto-escalate` | — | `auto_escalate_status` |
| `auto-i18n-extractor` | `i18n_extract` | `i18n_status` |
| `branch-guard` | — | `branch_guard_status` |
| `bug-reproducer` | `bug_reproduce` | — |
| `bundle-budget-guard` | `bundle_budget_analyze` | — |
| `change-risk-classifier` | `change_risk_analyze` | — |
| `changelog-writer` | `changelog_add`, `changelog_preview`, `changelog_write` | — |
| `checkpoint` | `checkpoint_create`, `checkpoint_list`, `checkpoint_restore` | — |
| `ci-failure-triage` | `ci_failure_triage` | — |
| `commit-validator` | — | `commit_validator_status` |
| `concurrency-scenario-tester` | `concurrency_test` | — |
| `config-migration-assistant` | `config_migration_preview` | — |
| `config-validator` | — | `config_validator_status` |
| `context-pins` | `pin_add`, `pin_remove`, `pin_list` | — |
| `cost-tracker` | — | `cost_summary`, `cost_reset`, `cost_export` |
| `decision-journal` | `decision_record`, `decision_lookup` | — |
| `dep-guard` | — | `dep_guard_status` |
| `dependency-drift-detector` | `dependency_drift_analyze` | — |
| `dependency-upgrade-sandbox` | `dependency_upgrade_try` | — |
| `dependency-vulnerability-gate` | — | `dependency_audit_status` |
| `developer-environment-doctor` | `developer_environment_check` | — |
| `diff-summary` | — | `diff_summary_status` |
| `doc-sync-guard` | — | `doc_sync_status` |
| `duplicate-code-detector` | `detect_duplicate_code` | `duplicate_code_status` |
| `env-contract-guard` | `env_contract_analyze` | — |
| `error-lens` | — | `error_lens_history` |
| `executable-documentation` | `documentation_verify` | — |
| `failure-injection-lab` | `failure_inject` | — |
| `feature-flag-lifecycle` | `feature_flag_inventory` | — |
| `file-watcher` | `watch_start`, `watch_stop`, `watch_list` | — |
| `format-on-save` | — | `format_on_save_status` |
| `generated-artifact-tracker` | `generated_artifacts` | — |
| `git-autocommit` | — | `git_autocommit` |
| `gitignore-guard` | `gitignore_guard_append` | `gitignore_guard_status` |
| `import-organizer` | — | `import_organizer_status` |
| `injection-shield` | — | `injection_shield_status` |
| `license-audit-gate` | — | `license_audit_status` |
| `lint-gate` | — | `lint_gate_status` |
| `llm-cache` | — | `llm_cache_status`, `llm_cache_clear` |
| `localization-completeness` | `localization_compare` | — |
| `lockfile-consistency-guard` | `lockfile_consistency_analyze` | — |
| `loop-breaker` | — | `loop_breaker_status` |
| `migration-planner` | `migration_plan` | `migration_status` |
| `migration-rehearsal` | `migration_rehearse` | — |
| `model-router` | — | `model_router_status` |
| `monorepo-change-planner` | `monorepo_change_plan` | — |
| `notify-hub` | `notify_send` | `notify_hub_status` |
| `path-guard` | — | `path_guard_status` |
| `performance-regression-gate` | — | `perf_regression_status` |
| `plugin-stack-observer` | — | `plugin_stack_status` |
| `plugin-workbench` | `plugin_workbench_run` | — |
| `pr-drafter` | `pr_draft` | — |
| `process-guard` | — | `process_guard_status` |
| `prompt-firewall` | — | `prompt_firewall_status` |
| `public-api-auditor` | `public_api_analyze` | — |
| `release-notes-generator` | `generate_release_notes` | — |
| `release-readiness` | `release_readiness_analyze` | — |
| `resource-lifecycle-inspector` | `resource_lifecycle_inspect` | — |
| `responsive-journey-tester` | `responsive_journey_test` | — |
| `runtime-trace-explorer` | `runtime_trace_explore` | — |
| `schema-evolution-guard` | — | `schema_evolution_status` |
| `secret-scanner` | — | `secret_scanner_status`, `secret_scanner_test` |
| `security-hotspot-scanner` | `security_hotspot_scan` | `security_hotspot_status` |
| `semver-bump` | `semver_bump`, `semver_current`, `semver_changelog` | — |
| `service-topology-inspector` | `service_topology_inspect` | — |
| `session-recap` | — | `session_recap_status` |
| `shell-check` | `shellcheck` | — |
| `spec-linker` | — | `spec_linker_status` |
| `template-engine` | `template_expand`, `template_render`, `template_create`, `template_list` | — |
| `test-coverage-gate` | — | `coverage_gate_status` |
| `test-flake-detector` | `flake_detect` | `flake_status` |
| `test-generator` | `generate_unit_tests` | — |
| `test-impact-analyzer` | `test_impact_analyze` | — |
| `test-runner-gate` | — | `test_gate_status` |
| `todo-listener` | — | `todo_listener_status` |
| `token-budget` | — | `token_budget_status` |
| `token-throttle` | — | `token_throttle_status` |
| `type-gate` | — | `type_gate_status` |
| `verification-ledger` | `verification_record`, `verification_status` | — |
| `visual-regression-reviewer` | `visual_regression_compare` | — |
| `workspace-health` | `workspace_health_analyze` | — |
| `workspace-recipe-runner` | `workspace_recipes`, `workspace_recipe_run` | — |
