# Tool-by-Tool Improvement Audit — WrongStack Runtime Catalog

**Date:** 2026-10-31
**Scope:** all **190** tools registered in this session's runtime catalog
**Type:** analysis only — no source, config, or test file was modified by this audit
**Method:** full catalog enumeration + source spot-checks against `packages/**`

---

## 1. How the catalog was enumerated (completeness proof)

`tool_search` paginates at 100 results, so the catalog was walked as four **disjoint**
`permission × mutating` slices — the same technique used by the 2026-09-10 predecessor
inventory. The slices sum exactly to the declared catalog size, and no slice was
discarded as truncated without a second pass:

| Slice | Tools returned | Truncated? | Second pass |
|---|---|---|---|
| `permission=auto`, `mutating=true` | 15 | no | — |
| `permission=auto`, `mutating=false` | 105 | yes (100 shown) | re-queried; tail confirmed individually (`fleet`, `define_subagent`, `work_complete`, `fleet_emit`, `collab_debug`) |
| `permission=confirm`, `mutating=true` | 59 | no | — |
| `permission=confirm`, `mutating=false` | 11 | no | — |
| **Total** | **190** | | equals the runtime's declared `190 tools in catalog` |

Because the four slices add up to exactly 190, the catalog contains **no `permission: 'deny'`
tool** — any such tool would have made the sum fall short. That is itself an observation
(see §5, theme 6).

---

## 2. Catalog-wide metrics

| Metric | Value |
|---|---|
| Total tools | 190 |
| `auto` permission | 120 |
| `confirm` permission | 70 |
| `auto` + mutating (state-changing, no prompt) | 15 |
| `confirm` + mutating | 59 |
| `confirm` + read-only | 11 |
| Naming: `snake_case` | 129 |
| Naming: `kebab-case` | 21 |
| Naming: single word | 40 |
| Plural-segment families | `codebase-*` 18, `browser_*` 16, `memory_*` 13, `lsp_*` 10 |
| Dedicated `*_status` observability tools | 18 |
| Distinct "work tracking" tools | 5 (`todo`, `plan`, `task`, `kanban`, `kanban_queue`) |
| Distinct memory-retrieval entry points | 8 |

Two structural facts drive most of the findings below: the catalog is **large relative to
the distinct jobs it performs** (heavy family overlap), and **permission/mutating metadata is
not consistently derived from actual effects**.

---

## 3. Rubric used for every tool

Each tool is judged on seven dimensions; tags in the tables refer to them.

| Tag | Dimension | What "good" looks like |
|---|---|---|
| **[D]** | Description | States primary job, when to use, and the boundary in the first two sentences |
| **[S]** | Input schema | Every parameter described, enums/patterns constrained, `additionalProperties: false` |
| **[C]** | Output contract | Declares `outputSchema`; machine-readable status instead of prose |
| **[P]** | Permission / mutating | Derived from real side effects; destructive actions never `auto` |
| **[O]** | Overlap | Clear, documented boundary vs. neighbouring tools |
| **[N]** | Naming | One convention across the catalog |
| **[V]** | Verifiability | Result tells the caller how to confirm success |

---

## 4. Per-tool findings

### 4.1 Files, search and reading

| Tool | Perm | Finding / suggested improvement |
|---|---|---|
| `read` | auto / ro | **[D]** Open with the operational envelope (byte/line caps, PDF/binary behaviour, truncation signal) rather than "safely"; **[O]** explicitly route large files to `codebase-read-symbol`. |
| `write` | confirm / mut | **[O]** Add `selection.doNotUseWhen` pointing at `edit`/`patch`; state that full-file replacement is destructive and loses non-text content. |
| `edit` | confirm / mut | **[V]** Document the mismatch failure mode (no partial write) so callers know to re-`read` instead of retrying blind. |
| `replace` | confirm / mut | **[S]** Make `dryRun`/preview the documented default path; **[P]** clarify whether preview-only invocations still need confirmation. |
| `patch` | confirm / mut | **[O]** State the boundary vs. `edit` (multi-hunk vs. single block) — currently both read as "apply a change". |
| `glob` | auto / ro | **[D]** Add the ignore semantics explicitly; **[O]** pair with `grep` selection hint on both sides (currently one-directional). |
| `grep` | auto / ro | **[C]** `output_mode` gains from a `files_only`/`count` example per mode; **[D]** note the `rg → native` fallback in the description, not only in the output enum. |
| `tree` | auto / ro | **[O]** Overlaps `glob` for discovery but never says so; **[S]** document default depth and node cap so the result is predictable. |
| `json` | auto / ro | **[D]** Say explicitly that it is read-only and which merge semantics apply (the current parenthetical carries the whole rule). |
| `diff` | auto / ro | **[O]** Three modes in one tool (file view, worktree diff, commit range) — split the usage examples per mode. |
| `search` | auto | **[O]** Overlaps `fetch`: document "discover with `search`, read with `fetch`" inside `search` itself. |
| `fetch` | confirm / ro | **[P]** Read-only yet gated; `read_url_content` does the same job with `auto`. Align the two or document why one needs approval. |
| `read_url_content` | auto / ro | **[O]** Duplicate of `fetch` for the common case — merge, or state the difference (format conversion vs. approval scope) in one sentence. |
| `present_artifact` | auto / ro | **[D]** Closing caveat ("requests presentation; does not prove display") is excellent — promote it to the description's second sentence. |
| `language_info` | auto / ro | **[V]** Report which operations are actually available per workspace, not just detected tooling. |
| `security-ast-scan` | auto / ro | **[C]** Findings need a stable severity/rule-id contract so downstream gates can count them. |
| `dead-code-scan` | auto / ro | **[O]** State that it is TS/JS-only in the first sentence (currently buried) to stop it being reached for Go/Rust repos. |
| `codebase-stats` | auto / ro | **[V]** Add an explicit "index is cold/stale" status that tells the caller to run `codebase-index`. |
| `codebase-search` | auto / ro | **[O]** Boundary vs. `grep` and `codebase-lsp-search` is good; add index-freshness to the result envelope. |
| `codebase-lsp-search` | auto / ro | **[O]** Third symbol-search entry point; document the fallback order index → LSP → grep in one place. |
| `codebase-read-symbol` | auto / ro | **[O]** Should be the named replacement for large-file `read`; cross-link both descriptions. |
| `codebase-skeleton` | auto / ro | **[S]** Document the output budget/truncation rule so callers know when to narrow the path. |
| `codebase-repo-map` | auto / ro | **[D]** "~1200 tokens by default" is the right instinct — add what is dropped first when the budget is hit. |
| `codebase-context` | auto / ro | **[V]** Natural-language selection is non-deterministic; return the score/reason a file was included. |
| `codebase-impact-analysis` | auto / ro | **[O]** Near-duplicate of `codebase-diff-impact` for the symbol case; state "symbol → use this, git change → use that". |
| `codebase-diff-impact` | auto / ro | **[O]** Document the range resolution rules (`HEAD~3..HEAD`, staged, working tree) explicitly. |
| `codebase-flow-trace` | auto / ro | **[C]** Return the entry-point inventory separately from the traced path so both are reusable. |
| `codebase-onboard` | auto / ro | **[S]** Add a token-budget parameter; the guide is the largest single output in the family. |
| `codebase-atlas` | auto / ro | **[V]** Surface `.wrongstack/atlas/` staleness in the same response as the projection. |
| `codebase-invariant-check` | auto / ro | **[D]** "Structural invariants that may have changed" is vague — name the invariant classes checked. |
| `codebase-incoming-calls` | auto / ro | **[O]** Overlaps `codebase-impact-analysis`; keep this as the primitive and make the other a documented composition. |
| `codebase-outgoing-calls` | auto / ro | **[D]** Add one worked example; the pairing with `incoming-calls` is what makes it usable. |
| `clarify` | auto | **[V]** Record whether the operator actually answered vs. skipped, so the caller can distinguish "no decision" from "default accepted". |
| `skill` | auto | **[D]** State the resolution order (bundled → workspace) and what happens on a miss. |
| `context_manager` | auto | **[D]** One-line description hides a destructive capability (reorganising context); spell out what can be dropped. |
| `nextsteps` | auto | **[P]** Session-visible side effect declared read-only; at minimum document that it mutates the suggestion list. |
| `project_kit` | auto / ro | **[O]** Good — it explicitly guards against duplicate scripts; make `project_kit_run` point back here on every failure. |
| `project_kit_run` | confirm / mut | **[V]** "Verification also executes code" is a strong warning — repeat it in the error text when verification is required. |
| `tool_script` | auto / ro | **[P]** Composes arbitrary tool calls including mutating ones but is itself `auto`/non-mutating; the declared effect does not reflect the composed effect. |
| `tool_search` | auto | **[C]** Add a `total`/`remaining` field to the response so callers can tell truncation from exhaustion (the 100-cap behaviour is currently only in prose). |
| `tool_use` | confirm / mut | **[P]** Invoking a *read-only* withheld tool demands confirmation and is flagged mutating; derive flags from the target tool instead of the gateway. |

### 4.2 Editing, execution, quality gates

| Tool | Perm | Finding / suggested improvement |
|---|---|---|
| `codebase-ast-replace` | confirm / mut | **[O]** vs. `lsp_rename` and `replace` — three rename paths, no stated preference order. |
| `codebase-index` | confirm / mut | **[V]** Return elapsed time, file/symbol counts and the new freshness so a re-run is provably unnecessary. |
| `dead-code-fix` | confirm / mut | **[C]** Good contract (re-scan → apply → typecheck → rollback); expose the undo-backup path in the result, not just the description. |
| `bash` | confirm / mut | **[D]** The tool guide correctly forbids POSIX syntax on Windows; surface that constraint in the description so it is read before the first failure. |
| `exec` | confirm / mut | **[O]** Boundary vs. `bash`/`pwsh` is documented; add "prefer this when arguments contain shell metacharacters". |
| `pwsh` | confirm / mut | **[O]** Currently selected by platform, but the description should say when *not* to use it on Windows (allowlisted single binaries → `exec`). |
| `git` | confirm / mut | **[S]** Multi-mode tool: document the read-only subcommands so users can pass `status`/`diff` cheaply. |
| `git_autocommit` | confirm / mut | **[P]** Commits on the operator's behalf — keep `confirm`, and state that it never pushes. |
| `lint` | confirm / mut | **[P]** Flagged `mutating: true` although a linter run does not modify source; `typecheck`/`test` are correctly read-only. Align. |
| `format` | confirm / mut | **[S]** Expose `check`-only mode separately; a formatter that rewrites files should say so in the first clause. |
| `typecheck` | confirm / ro | **[O]** Overlaps `language` for non-TS ecosystems; state which wins per language. |
| `test` | confirm / ro | **[V]** The `no_tests ≠ pass` rule is excellent and lives only in `usageHint`; also encode it in `outputSchema` docs and the summary line. |
| `codebase-targeted-test` | confirm / ro | **[O]** vs. `test`: say "this chooses the files, `test` runs an explicit set". |
| `flake_detect` | confirm / ro | **[C]** Needs a machine-readable verdict (stable/flaky per test), not just prose. |
| `mutation_test` | auto / ro | **[P]** Writes sabotaged source into the tree while declaring itself non-mutating and `auto`; this is the single most inconsistent metadata entry in the catalog. |
| `audit` | confirm / ro | **[D]** Name the ecosystem commands it delegates to, so users know what will run. |
| `install` | confirm / mut | **[O]** State the lockfile policy (frozen vs. update) — currently the most consequential undocumented decision. |
| `outdated` | confirm / mut | **[P]** Read-only by its own description ("without changing manifests") yet flagged mutating. |
| `language` | confirm / mut | **[D]** "A supported language-tooling operation" — enumerate the operations and which ecosystems support them. |
| `language_package` | confirm / mut | **[P]** Can change dependency state; confirm that `plan` mode is genuinely side-effect-free. |
| `logs` | confirm / ro | **[S]** Document the tail bound and whether the cursor is stable across calls. |
| `e2e_plan` | auto | **[V]** Output is a plan, not evidence — say so and point at `browser_*` for execution. |
| `design` | confirm / mut | **[D]** "Choose, preview, or materialize a UI design kit (e.g. …" — the sentence is doing three jobs; split into three modes. |
| `design_reference` | confirm / mut | **[O]** vs. `browser_screenshot`: one measures, one captures; state the choice. |
| `image_generate` | confirm / mut | **[C]** Return the written path plus provider/model and a seed when available, so regeneration is possible. |

### 4.3 Browser (16 tools)

| Tool | Perm | Finding / suggested improvement |
|---|---|---|
| `browser_status` | auto | **[D]** Good, short. Add the actionable fix command when Chromium is missing. |
| `browser_list` | auto | **[S]** Include the last-used timestamp and the owning session scope in the response. |
| `browser_open` | confirm / mut | **[D]** The `/browser allow <origin>` escape hatch is the right content — also return it programmatically in the error payload. |
| `browser_navigate` | confirm / mut | **[O]** Duplicates `browser_open(url)`; state that `open` creates a session and `navigate` reuses one. |
| `browser_snapshot` | auto | **[O]** Advertised as the "prefer before interacting" primitive; make every mutating browser tool point back to it. |
| `browser_screenshot` | confirm / mut | **[P]** Produces a sensitive artifact yet sits in the same tier as clicking; consider `auto` with redaction, or document why not. |
| `browser_click` | confirm / mut | **[S]** Selector syntax and the "specific stable selector" rule belong in the schema description, not only `usageHint`. |
| `browser_type` | confirm / mut | **[D]** The `secretEnv` guidance is exactly right; add that `text` is rejected for credential-looking values, or that it is not. |
| `browser_select` | confirm / mut | **[S]** Document value-vs-label matching for `<select>`; this is the usual failure. |
| `browser_press` | confirm / mut | **[V]** Return whether the key triggered navigation or submit, so the caller need not guess. |
| `browser_hover` | confirm / mut | **[O]** Hover is often a pre-step; link it to `browser_click` as the usual follow-up. |
| `browser_drag` | confirm / mut | **[C]** Needs an explicit "drag not supported by this element" verdict rather than a timeout. |
| `browser_wait` | auto | **[S]** Enumerate the three wait modes and their defaults; unbounded waits are the main hang source. |
| `browser_evaluate` | confirm / mut | **[P]** Arbitrary JS in a page is the most powerful browser tool; ensure it is never reachable through the `auto` gateway without confirmation. |
| `browser_upload` | confirm / mut | **[P]** Correctly gated. **[D]** State that only project-local paths are accepted. |
| `browser_close` | auto | **[V]** Good artifact metadata in the description; make trace paths discoverable after close. |

### 4.4 Memory (SAGE) — 17 tools

| Tool | Perm | Finding / suggested improvement |
|---|---|---|
| `memory_search` | auto / ro | **[O]** Four near-synonyms (`memory_search`, `search_memory`, `memory_search_explain`, `find_related_memories`); collapse to one entry point with a `mode` flag. |
| `search_memory` | auto / ro | **[O]** Lowercase-description sibling of `memory_search`; as written the caller cannot tell them apart. |
| `memory_search_explain` | auto / ro | **[D]** Excellent diagnostic content — better framed as `memory_search(mode="explain")` than a separate tool. |
| `find_related_memories` | auto / ro | **[O]** Graph traversal that `memory_graph` also performs; unify or cross-reference. |
| `memory_graph` | auto / ro | **[S]** Document traversal direction and depth caps. |
| `memory_gather_batch` | auto / ro | **[C]** Define the batch bound and what is dropped when it is exceeded. |
| `memory_for_file` | auto / ro | **[O]** Special case of path-anchored search; keep, but state the precedence. |
| `memory_for_path` | auto / ro | **[O]** Ancestor-directory semantics should be explicit (inclusive? how many levels?). |
| `remember` | confirm / mut | **[S]** Require a kind/tag policy; untyped memories are what makes retrieval noisy. |
| `forget` | confirm / mut | **[P]** Correctly destructive-gated. **[D]** Case-insensitive match should be stated in the description, not only the schema. |
| `memory_update` | confirm / mut | **[C]** Return a diff of what changed so the write is auditable. |
| `memory_delete` | confirm / mut | **[V]** Soft-delete + cascade is described well; surface the recovery window. |
| `memory_recover` | confirm / mut | **[O]** Pairs with `memory_backfill_recoverable` — two recovery paths, no stated difference. |
| `memory_backfill_recoverable` | confirm / ro | **[O]** Preview-by-default is good; make it the single recovery entry point and fold `memory_recover` in. |
| `memory_verify` | confirm / mut | **[P]** Anchor verification can be read-only in "check" mode but is always `confirm`; split modes or document why. |
| `memory_hygiene` | confirm / mut | **[C]** The most powerful memory tool — needs a mandatory dry-run summary before mutation. |
| `memory_candidates` | confirm / mut | **[O]** Accept/reject workflow overlaps `memory_hygiene`; define which one promotes candidates. |

### 4.5 LSP and symbol navigation (10 tools)

| Tool | Perm | Finding / suggested improvement |
|---|---|---|
| `lsp_diagnostics` | auto / ro | **[V]** State whether diagnostics are pushed (stale) or pulled fresh. |
| `lsp_definition` | auto / ro | **[S]** Position input needs an explicit `file:line:col` convention shared by all `lsp_*` tools. |
| `lsp_references` | auto / ro | **[O]** vs. `codebase-incoming-calls`: semantic vs. indexed; state it in one sentence on both. |
| `lsp_hover` | auto / ro | **[D]** One-line description is fine; add the truncation rule for large hover payloads. |
| `lsp_completion` | auto / ro | **[V]** Completions are near-useless out of context; document the intended use (probing API surface). |
| `lsp_symbols` | auto / ro | **[O]** Overlaps `codebase-skeleton`; the LSP one is semantic, the index one is cheap — say which to reach for. |
| `lsp_code_actions` | auto / ro | **[O]** Listing actions is read-only, but applying them is not — there is no documented apply path. |
| `lsp_execute_command` | confirm / mut | **[P]** Arbitrary server commands; keep `confirm`, and warn that effects are server-defined. |
| `lsp_request` | confirm / mut | **[D]** "Custom request method" — state that any LSP method is reachable, which is a wide surface. |
| `lsp_rename` | confirm / mut | **[O]** Semantic rename vs. `codebase-ast-replace` vs. `replace`; add a decision table. |

### 4.6 Coordination, fleet and subagents

| Tool | Perm | Finding / suggested improvement |
|---|---|---|
| `spawn_subagent` | auto | **[P]** Spends budget and starts an autonomous agent with no confirmation, while `delegate` (same effect) is `confirm`. Align. |
| `delegate` | confirm | **[O]** Two delegation entry points (`delegate`, `spawn_subagent`) with different gates; consolidate or document the split. |
| `define_subagent` | auto | **[S]** 14 parameters with `system_prompt`/`systemPrompt` aliases; drop the alias or document precedence. |
| `assign_task` | auto | **[V]** Return the queue position so the caller can reason about ordering. |
| `await_tasks` | auto | **[S]** Document timeout and partial-completion semantics — blocking calls without a bound are a hang risk. |
| `ask_subagent` | auto | **[O]** vs. `delegate` + `await_tasks`; the synchronous form needs a stated timeout. |
| `ask_result` | auto | **[C]** The >2K out-of-context spill is good; expose the truncation threshold in the schema. |
| `roll_up` | auto | **[C]** Define the summary format so results are machine-mergeable. |
| `terminate_subagent` | auto / mut | **[P]** Aborting an agent mid-write is destructive and ungated. |
| `terminate_all` | auto / mut | **[P]** Forcibly stops *every* subagent and drains the queue with no confirmation. Highest-risk `auto` tool in the catalog. |
| `work_complete` | auto | **[P]** Changes fleet-wide state (fleet winds down) yet declared non-mutating. |
| `fleet` | auto | **[D]** Description is literally "Fleet observation tool." — the weakest description in the catalog. |
| `fleet_status` | auto | **[O]** Same job as `fleet`; one of the two should disappear. |
| `fleet_emit` | auto | **[P]** Publishes events to other agents yet is declared non-mutating. |
| `collab_debug` | auto | **[O]** A 3-agent orchestration behind a single `auto` call; the description should state the cost and duration up front. |
| `council` | auto | **[D]** "Multi-persona Council" — name the personas and the decision contract; also state the token cost. |
| `llm` | auto | **[S]** A raw one-shot model call with no cost/RateLimit note; add model-default and cost warning. |
| `quality_gate` | auto | **[D]** "First-class implementation quality gate" says nothing about what runs; enumerate the checks. |
| `mail_send` | auto / mut | **[D]** Semantics of the nine message types are well documented but very long; move the type matrix into `usageHint` to keep the description scannable. |
| `mail_inbox` | auto / mut | **[V]** Good. Add a stable message-id list so acknowledgements can be batched. |
| `mailbox` | auto / mut | **[O]** Superset of `mail_send`/`mail_inbox`; its own description admits "prefer the simpler tools" — retire or make it the single API. |
| `session_note` | auto | **[P]** Cross-agent messaging declared non-mutating. |
| `handoff_note` | auto | **[P]** Same: writes a handoff to the project mailbox but is flagged read-only. |
| `handoff_status` | auto | **[O]** Thin status tool; candidates for the consolidated status surface (§5). |
| `kanban_queue` | auto / mut | **[O]** Dispatches work into the fleet; overlaps `assign_task`. |
| `jev_status` | auto | **[D]** "Check whether the Jev decision tool is enabled" — but there is no `jev` tool in this catalog, so the status tool has no actionable target. |
| `telegram_read` | auto / ro | **[P]** Correctly read-only. **[V]** Add a cursor so repeated reads are idempotent. |
| `telegram_send` | confirm / mut | **[D]** "Scrubbed" is a strong promise — state what is scrubbed and that failures are surfaced, not silently dropped. |
| `telegram_approve` | confirm / mut | **[S]** Blocking wait + button press: document the timeout and what happens when nobody answers. |

### 4.7 Work tracking and session state

| Tool | Perm | Finding / suggested improvement |
|---|---|---|
| `todo` | confirm / mut | **[P]** Session bookkeeping should not need approval; `nextsteps` (the same class of action) is `auto`. |
| `plan` | confirm / mut | **[O]** Third work model after `todo`/`task`; define the hierarchy in one place. |
| `task` | confirm / mut | **[O]** Dependencies/ownership overlap `plan` and `kanban`; the catalog gives no rule for choosing. |
| `kanban` | confirm / mut | **[O]** Fourth work model. **[D]** Description is one short clause — cannot support the six operations it implies. |
| `pin_add` | confirm / mut | **[V]** Good gating. Return the pin id plus a preview of the injected line. |
| `pin_remove` | confirm / mut | **[S]** Accept both `pin-N` and label; make precedence explicit. |
| `pin_list` | auto | **[C]** Include the exact injected text, not just the facts. |
| `checkpoint_create` | auto | **[P]** Writes snapshot storage while declaring `auto`/non-mutating; `checkpoint_restore` is correctly gated. |
| `checkpoint_list` | auto | **[C]** Return age/size so the caller can prune. |
| `checkpoint_restore` | confirm / mut | **[V]** State that restore overwrites current work (no merge). |
| `error_lens_history` | auto | **[O]** Overlaps `logs`; it is session-scoped, say so. |
| `session_rename` | auto / mut | **[P]** Fine, but renaming is visible to peers — document that. |
| `session_recap_status` | auto | **[D]** Status-only; see §5 consolidated-status proposal. |
| `watch_start` | confirm | **[S]** Document event kinds and whether events are queued or dropped. |
| `watch_stop` / `watch_list` | auto | **[C]** `watch_list` should include the last fired event, otherwise it is only an inventory. |
| `cron_schedule` | confirm | **[P]** Schedules recurring side effects without stating persistence across sessions. |
| `cron_cancel` | auto | **[P]** Cancelling a scheduled job is a state change declared read-only. |
| `cron_list` | auto | **[C]** Add last-run outcome, not just counts. |
| `semver_current` | auto | **[O]** Three `semver_*` tools; `current` is a strictly cheaper read — good split, just cross-link. |
| `semver_changelog` | auto | **[V]** State whether output is markdown-only (it says so) and where it is written. |
| `semver_bump` | confirm / mut | **[P]** Writes version files; ensure it never commits implicitly. |
| `gitignore_guard_append` | confirm / mut | **[D]** Good specific description; add the exact pattern syntax accepted. |
| `gitignore_guard_status` | auto | **[O]** One of 18 status tools (see §5). |
| `image_generate` | confirm / mut | (see §4.2) |
| `mcp_control` | confirm / mut | **[P]** Enabling a server at runtime expands the tool surface mid-session; that is a privilege change, not routine config. |
| `mcp_use` | confirm / mut | **[O]** Every MCP call needs a confirmation, which makes MCP workflows unusably slow — derive the gate from the called MCP tool's own annotation. |
| `plugin_manager` | auto / mut | **[P]** Loads code into the process with no confirmation, while `provider_key_set` (lower risk) requires one. |
| `provider_key_set` | confirm / mut | **[V]** Correctly gated. Never echo the key in the result or the audit trail. |
| `provider_manage` | auto / mut | **[P]** Can repoint providers — a routing/trust change — while ungated. |
| `agent_model_assign` | auto / mut | **[P]** Silent cost/behaviour change for every agent role; ungated. |
| `leader_model_set` | auto / mut | **[P]** Same class of change, ungated. |
| `leader_tier_set` | auto / mut | **[P]** Changes the leader's own cost tier without confirmation. |
| `leader_effort_set` | auto | **[P]** Changes the leader's own reasoning effort; declared read-only. |
| `favorite_manage` | auto / mut | **[P]** Benign but inconsistent with the gated `provider_key_set`. |
| `fallback_chain_manage` | auto / mut | **[P]** Can reorder silent failover for all requests; ungated. |
| `fallback_profile_manage` | auto / mut | **[P]** Same. |
| `system_config_view` | auto | **[C]** A config dump with no redaction contract; state that secrets are omitted. |
| `workspace_health_analyze` | auto | **[D]** "Health-contract failures" is undefined — name the contracts. |
| `test_impact_analyze` | auto | **[O]** Overlaps `codebase-diff-impact` + `codebase-targeted-test`; clarify whether it advises or executes. |
| `secret_scanner_test` | auto | **[P]** Sends a user-supplied string through the detection pipeline; state that matches are echoed back (and therefore land in the transcript). |

### 4.8 Plugin gates and observability (`*_status`, 18 tools)

| Tool | Perm | Finding / suggested improvement |
|---|---|---|
| `secret_scanner_status` | auto | **[O]** Consolidate: 18 single-purpose status tools should become one `diagnostics_status { component }`. Each currently costs a schema slot in the catalog and a decision for the model. |
| `lint_gate_status` | auto | **[O]** Same consolidation. |
| `todo_listener_status` | auto | **[O]** Same; counters with no stated interpretation. |
| `coverage_gate_status` | auto | **[O]** Same; "last coverage percentage" needs a timestamp to be meaningful. |
| `type_gate_status` | auto | **[O]** Same; report pass/fail/error separately from the gate's current mode. |
| `flake_status` | auto | **[O]** Same; overlaps `flake_detect` result — status adds little. |
| `loop_breaker_status` | auto | **[O]** Same; "oscillations" is undefined. |
| `dep_guard_status` | auto | **[O]** Same; deny/allow lists should be returned as structured arrays. |
| `config_validator_status` | auto | **[O]** Same; "files checked" without the file list is not actionable. |
| `injection_shield_status` | auto | **[O]** Same; pattern *names* without counts per pattern hide drift. |
| `prompt_firewall_status` | auto | **[O]** Same; mode + counters is a two-field projection of one shared status shape. |
| `process_guard_status` | auto | **[O]** Same; "last detected kill-related command" should include the verdict. |
| `gitignore_guard_status` | auto | **[O]** Same. |
| `browser_status` | auto | **[D]** The only status tool with a clear next action when unhealthy — make that the pattern. |

---

## 5. Cross-cutting themes (ranked by impact)

1. **Permission metadata is not derived from effects (highest risk).** Verified mismatches:
   `mutation_test` (writes sabotaged source, `auto`/non-mutating), `terminate_all` (destroys
   fleet state, `auto`), `plugin_manager` (loads code, `auto`) vs. `provider_key_set`
   (`confirm`), `checkpoint_create` (writes snapshots, `auto`), `cron_cancel`/`fleet_emit`/
   `session_note`/`handoff_note`/`work_complete` (peer-visible state, non-mutating),
   `lint`/`outdated` (mutating despite being read-only). Recommendation: derive
   `mutating`/`permission` in the registry from declared `capabilities`, and add a test that
   fails when a tool with `shell.*`, `fs.write`, or `fleet.*` capabilities is registered
   `auto` without an explicit allowlist entry.

2. **Five competing work-tracking models.** `todo`, `plan`, `task`, `kanban`, `kanban_queue`
   all answer "what should I do next", all `confirm`+mutating, none cross-references the
   others. Pick a hierarchy (todo → plan → task → kanban card) and encode it in each
   description's first line.

3. **Eight memory entry points for one store.** `memory_search`, `search_memory`,
   `memory_search_explain`, `find_related_memories`, `memory_graph`, `memory_gather_batch`,
   `memory_for_file`, `memory_for_path`. Collapse to one search tool with `mode` +
   `scope`, keeping `explain` as a mode. This is the largest single reduction available
   (~7 schema slots).

4. **18 `*_status` tools with no aggregate view.** Each is a thin projection of plugin
   state, each costs a catalog slot, and together they still cannot answer "what is
   blocking me right now". One `diagnostics_status { component?, verbose? }` replaces 17 of
   them; keep `browser_status` separate because it has an actionable fix.

5. **Naming is split three ways.** 129 `snake_case`, 21 `kebab-case` (all the
   `codebase-*`/`dead-code-*` index tools), 40 single words. Any model-generated tool name
   is a coin flip. Adopt `snake_case` for new tools, add aliases for the kebab families, and
   enforce it in a lint rule.

6. **No `deny` tier is in use anywhere.** 190 tools, 120 of them `auto`. The catalog has an
   explicit `deny` permission value in `tool_search`'s own filter enum, but nothing uses it.
   At minimum the irreversible tools (`terminate_all`, `plugin_manager`, `mutation_test`)
   deserve a tier that cannot be auto-accepted by a blanket YOLO setting.

7. **Gateway flags are inherited from the wrapper, not the target.** `tool_use` is always
   `confirm`+mutating even when the withheld tool is `read`; `tool_script` is always
   `auto`/read-only even when its script calls `bash`. Both make the approval prompt lie in
   one direction or the other.

8. **Description quality is bimodal.** The best descriptions (`fetch`, `test`,
   `present_artifact`, `mail_send`, `codebase-*`) state the job, the boundary and the
   failure mode. The worst (`fleet` — "Fleet observation tool.", `quality_gate`,
   `context_manager`, `kanban`, `language`) state neither the job nor the boundary, and
   those are exactly the tools where a wrong choice is expensive.

9. **Long descriptions crowd out decision content.** `mail_send` (~1.2k chars) and
   `tool_script` (~630) put routing matrices in `description` where they compete with
   `usageHint`. Keep `description` ≤ ~300 chars (job + boundary + one anti-pattern) and move
   the rest to `usageHint`, which is only materialised on demand.

10. **Read paths are gated inconsistently.** `fetch` (`confirm`) vs. `read_url_content`
    (`auto`) for the same action; `typecheck`/`test`/`audit` (`confirm`) vs. `lint`
    (`confirm`+mutating). Users learn the prompt is noise, which is how a real destructive
    approval gets rubber-stamped.

---

## 6. Prioritised roadmap

**P0 — safety metadata (small diffs, high value)**

1. Fix `mutation_test`, `terminate_all`, `plugin_manager`, `checkpoint_create`,
   `fleet_emit`, `session_note`, `handoff_note`, `work_complete`, `cron_cancel` metadata.
2. Correct the false-positive mutating flags: `lint`, `outdated`.
3. Derive gateway flags in `tool_use`/`tool_script` from the composed/target tool.
4. Add a registry invariant test: capability ⇒ minimum permission.

**P1 — catalog reduction (biggest usability win)**

5. Merge the 8 memory search tools into 1 + modes.
6. Merge the 18 `*_status` tools into `diagnostics_status`.
7. Retire `mailbox` (or `mail_send`/`mail_inbox`) and `fleet` (or `fleet_status`).
8. Merge `fetch`/`read_url_content`; document `search` as discovery-only.
9. Declare the `todo → plan → task → kanban` hierarchy.

**P2 — contract and polish**

10. Require `outputSchema` for tools that still return prose-only results (enables `tool_script`
    to consume results without parsing text); verify per tool before enforcing.
11. Normalise naming to `snake_case` with aliases for the `codebase-*` family.
12. Rewrite the five weakest descriptions (`fleet`, `quality_gate`, `context_manager`,
    `kanban`, `language`) and cap `description` at ~300 chars.
13. Add `selection.doNotUseWhen`/`useInstead` to the tools that still lack it — most of the
    catalog's neighbours are only distinguishable today through prose in `usageHint`.

---

## 7. Limitations

- Findings are derived from catalog metadata (descriptions + schemas) plus targeted source
  reads in `packages/tools/src`; this is not a line-by-line review of all 190 implementations.
- Runtime behaviour was not exercised: no tool was invoked destructively, and no test suite
  or typecheck was run, because the task was explicitly analysis-only.
- Where a claim concerns permission/mutating accuracy, it comes from the catalog's own
  declared flags as returned by `tool_search`, cross-checked against the tool's description.
- The 5 tail entries of the largest slice were confirmed by individual exact-name queries
  rather than by a paginated second pass; counts (105) and identities are both verified.

---

## 8. Appendix A — tool attribute table (all 190 tools)

One row per catalog tool, alphabetical. Columns: declared name, resolved icon id, icon color (hex), declared permission / mutability, and the description served to the model.

| # | Tool | Icon | Color | Permission | Description |
|---:|---|---|---|---|---|
| 1 | `agent_model_assign` | fallback | `#9ca3af` | auto / mut | Assign a provider/model or a fallback profile to a specific agent role, phase, or the fleet-wide default. This is the LLM-accessible equivalent of /s… |
| 2 | `ask_result` | fallback | `#9ca3af` | auto / ro | Retrieve a large `ask_subagent` response that was stored out-of-context (>2K chars). Returns the full stored value. |
| 3 | `ask_subagent` | fallback | `#9ca3af` | auto / ro | Synchronously ask a subagent a question. Blocks until the subagent replies via the bridge. |
| 4 | `assign_task` | fallback | `#9ca3af` | auto / ro | Queue a task on a previously spawned subagent. NON-BLOCKING: returns a `taskId` IMMEDIATELY — the subagent processes the task on its next iteration w… |
| 5 | `audit` | package | `#f472b6` | confirm / ro | Run a security audit against project dependencies (using pnpm/npm audit). Reports known vulnerabilities with severity. |
| 6 | `await_tasks` | fallback | `#9ca3af` | auto / ro | Block until one or more `taskId`s complete, then return their results. The subagents keep running in the background — only the leader's iteration pau… |
| 7 | `bash` | terminal | `#67e8f9` | confirm / mut | Execute an arbitrary command in the user's default shell (bash/zsh/pwsh/cmd). stdout and stderr are merged into one stream. This is the most powerful… |
| 8 | `browser_click` | fallback | `#9ca3af` | confirm / mut | Click an element in an owned browser session. |
| 9 | `browser_close` | fallback | `#9ca3af` | auto / ro | Close an owned browser session, reclaim its context, and return sensitive trace metadata. |
| 10 | `browser_drag` | fallback | `#9ca3af` | confirm / mut | Drag one element to another in an owned browser session. |
| 11 | `browser_evaluate` | fallback | `#9ca3af` | confirm / mut | Evaluate bounded JavaScript in the page. Requires confirmation because page code is arbitrary. |
| 12 | `browser_hover` | fallback | `#9ca3af` | confirm / mut | Hover an element in an owned browser session. |
| 13 | `browser_list` | fallback | `#9ca3af` | auto / ro | List browser sessions owned by the current agent without exposing other agents sessions. |
| 14 | `browser_navigate` | fallback | `#9ca3af` | confirm / mut | Navigate an owned browser session to an approved http(s) URL. Allow a private/localhost origin for this project with /browser allow <origin>, or WRON… |
| 15 | `browser_open` | fallback | `#9ca3af` | confirm / mut | Open an isolated first-party Playwright browser session, optionally navigating to a URL. Allow a private/localhost origin for this project with /brow… |
| 16 | `browser_press` | fallback | `#9ca3af` | confirm / mut | Press a keyboard key in an owned browser session. |
| 17 | `browser_screenshot` | fallback | `#9ca3af` | confirm / mut | Capture a page or element PNG and return sensitive artifact metadata with integrity hash. |
| 18 | `browser_select` | fallback | `#9ca3af` | confirm / mut | Select an option in an owned browser session. |
| 19 | `browser_snapshot` | fallback | `#9ca3af` | auto / ro | Return bounded accessibility state plus redacted console and network summaries. |
| 20 | `browser_status` | fallback | `#9ca3af` | auto / ro | Check whether first-party Playwright Chromium is installed and ready to launch. |
| 21 | `browser_type` | fallback | `#9ca3af` | confirm / mut | Fill an input in an owned browser session. Use secretEnv instead of text for credentials so values stay out of tool arguments and session audit. |
| 22 | `browser_upload` | fallback | `#9ca3af` | confirm / mut | Upload project-local files through a file input in an owned browser session. |
| 23 | `browser_wait` | fallback | `#9ca3af` | auto / ro | Wait for an element or a bounded duration in an owned browser session. |
| 24 | `checkpoint_create` | fallback | `#9ca3af` | auto / ro | Manually snapshot the current content of one or more files before a risky operation (codemod, bulk rename, script run). |
| 25 | `checkpoint_list` | fallback | `#9ca3af` | auto / ro | List captured file snapshots (newest first) with ids for checkpoint_restore. |
| 26 | `checkpoint_restore` | fallback | `#9ca3af` | confirm / mut | Restore file(s) to the content captured in a snapshot (see checkpoint_list). |
| 27 | `clarify` | meta | `#cbd5e1` | auto / ro | Pause and ask the user for required decisions in one structured, tabbed form. Supports single-select, multi-select, free text, option descriptions, w… |
| 28 | `codebase-ast-replace` | edit | `#fbbf24` | confirm / mut | Surgically replace the implementation body or full definition of a named declaration (function, method, class, interface, type alias, enum, variable)… |
| 29 | `codebase-atlas` | index | `#06b6d4` | auto / ro | Inspect or project the Codebase Atlas: PageRank hubs, subsystem summaries, concept coverage, Louvain file communities, and `.wrongstack/atlas/` fresh… |
| 30 | `codebase-context` | index | `#06b6d4` | auto / ro | Find the files and declarations a task touches, from a plain-language description. Combines ranked symbol search with a personalised walk over the re… |
| 31 | `codebase-diff-impact` | index | `#06b6d4` | auto / ro | Analyze the blast radius of current git changes (working tree, staged diff, or commit/branch range). Maps modified diff hunks to affected symbols, fi… |
| 32 | `codebase-flow-trace` | index | `#06b6d4` | auto / ro | Discover architectural entry points (HTTP routes, CLI commands, tools, handlers, main orchestrators) and trace their forward execution flows (`Domain… |
| 33 | `codebase-impact-analysis` | index | `#06b6d4` | auto / ro | Perform a blast radius and impact analysis before modifying or refactoring a function, class, or type. Identifies all production call sites, affected… |
| 34 | `codebase-incoming-calls` | index | `#06b6d4` | auto / ro | Find all callers of a function, method, or symbol — who invokes or references it. Uses the codebase index ref graph for instant, exact results. Prefe… |
| 35 | `codebase-index` | index | `#06b6d4` | confirm / mut | Build or incrementally update the project-wide symbol index. This powers fast codebase search and understanding. By default it only processes files t… |
| 36 | `codebase-invariant-check` | index | `#06b6d4` | auto / ro | Deterministically check AST backward-compatibility invariants between original code and a candidate mutation for TypeScript/JavaScript, Python, Go an… |
| 37 | `codebase-lsp-search` | fallback | `#9ca3af` | auto / ro | Search code symbols through the index with a live LSP workspace-symbol fallback. Use preferLsp=true when current language-server state matters more t… |
| 38 | `codebase-onboard` | index | `#06b6d4` | auto / ro | Generate a dependency-ordered Guided Architectural Tour and Onboarding Guide for the repository. Synthesizes PageRank hubs, Louvain community cluster… |
| 39 | `codebase-outgoing-calls` | index | `#06b6d4` | auto / ro | Find all functions/methods/symbols that a given symbol calls or depends on — its callees. Uses the codebase index ref graph for instant, exact result… |
| 40 | `codebase-read-symbol` | file | `#60a5fa` | auto / ro | Read the exact implementation of a named declaration (function, method, class, interface, type, enum, variable) from a file using AST parsing. Return… |
| 41 | `codebase-repo-map` | index | `#06b6d4` | auto / ro | Generate a centrality-ranked, token-budgeted Repository Map of the codebase (~1200 token default). Use it for orientation before a cross-file change.… |
| 42 | `codebase-search` | index | `#06b6d4` | auto / ro | Search code symbols using a fast SQLite+BM25 index. Prefer this before broad `tree`, `glob`, or `grep` exploration when finding code by name or conce… |
| 43 | `codebase-skeleton` | index | `#06b6d4` | auto / ro | Extract an AST-based skeleton of a file or directory with implementation bodies stripped. Preserves imports, type definitions, interfaces, docstrings… |
| 44 | `codebase-stats` | index | `#06b6d4` | auto / ro | Check whether a persisted codebase index exists and report its health and statistics (symbols, files, language/kind breakdown, size, last update). |
| 45 | `codebase-targeted-test` | test | `#4ade80` | confirm / ro | Smart targeted test runner. Automatically identifies and executes only the test suites that cover a specific symbol or file using Call Graph referenc… |
| 46 | `collab_debug` | fallback | `#9ca3af` | auto / ro | Start a collaborative debugging session: BugHunter, RefactorPlanner, and Critic run in parallel on the same target files. BugHunter finds bugs and em… |
| 47 | `config_validator_status` | fallback | `#9ca3af` | auto / ro | Reports config-validator state: watched extensions and counters (files checked, problems found). |
| 48 | `context_manager` | fallback | `#9ca3af` | auto / ro | Inspect or reorganize the conversation context window. Use "check" to see token budget. Use "summary" to collapse a message range into a concise note… |
| 49 | `council` | fallback | `#9ca3af` | auto / ro | Ask an independent, multi-persona Council to evaluate a decision or synthesize an answer. Uses bounded parallel voters, quorum/veto/weighted resoluti… |
| 50 | `coverage_gate_status` | fallback | `#9ca3af` | auto / ro | Reports test-coverage-gate state: threshold, mode, last coverage percentage, and counters. |
| 51 | `cron_cancel` | fallback | `#9ca3af` | auto / ro | Cancel and remove a cron job by name. |
| 52 | `cron_list` | fallback | `#9ca3af` | auto / ro | List all registered cron jobs with their intervals, next run times, and execution counts. |
| 53 | `cron_schedule` | fallback | `#9ca3af` | confirm / ro | Schedule a recurring action to fire at a fixed interval (in milliseconds). |
| 54 | `dead-code-fix` | edit | `#fbbf24` | confirm / mut | Remove dead code found by dead-code-scan, by finding id: delete unreachable files, remove dead declarations (and the imports/helpers only they used)… |
| 55 | `dead-code-scan` | index | `#06b6d4` | auto / ro | Find dead code in executable source files (TS/JS): unreachable files, exports nothing imports, unused re-exports, test-only code, unused top-level lo… |
| 56 | `define_subagent` | meta | `#cbd5e1` | auto / ro | Defines a new custom or ad-hoc subagent type that can be invoked via `delegate` or `spawn_subagent`. Use this when you need a specialized subagent fo… |
| 57 | `delegate` | fallback | `#9ca3af` | confirm / ro | Hand a piece of work to a subagent. By default this call does NOT block: it spawns the worker and returns at once with `{status:'running', delegation… |
| 58 | `dep_guard_status` | fallback | `#9ca3af` | auto / ro | Reports dep-guard state: deny/allow lists, mode, and counters (installs seen, blocks, warns). |
| 59 | `design` | fallback | `#9ca3af` | confirm / mut | Browse, load, customize, and enforce curated frontend/mobile UI design kits. Use BEFORE writing UI code to commit to one coherent, modern, responsive… |
| 60 | `design_reference` | fallback | `#9ca3af` | confirm / mut | Measure rendered pages in a browser instead of describing them. "extract" records a reference site’s design DNA (color roles, type scale, spacing uni… |
| 61 | `diff` | diff | `#93c5fd` | auto / ro | Show file content with line numbers, staged/working-tree diffs via git, or commit/branch diffs. A safer and more structured alternative to raw `git d… |
| 62 | `e2e_plan` | test | `#4ade80` | auto / ro | Discover Playwright and Cypress projects and preview bounded E2E execution plans without loading configs or starting processes. |
| 63 | `edit` | edit | `#fbbf24` | confirm / mut | Perform a precise, surgical text replacement in a file. This is the preferred tool for modifying existing code. It works best after a prior `read`, b… |
| 64 | `error_lens_history` | fallback | `#9ca3af` | auto / ro | Lists failures observed this session (error line, source frames, repeat counts). |
| 65 | `exec` | terminal | `#67e8f9` | confirm / mut | Execute a command directly with argument validation and permission gating. Outside YOLO, the curated command roster applies; YOLO/YOLO+ accept other… |
| 66 | `fallback_chain_manage` | fallback | `#9ca3af` | auto / mut | View or change the active rate-limit fallback chain. When the primary model is overloaded (429/5xx), the agent rotates through this chain in order. E… |
| 67 | `fallback_profile_manage` | fallback | `#9ca3af` | auto / mut | Manage named fallback profiles. A profile is a reusable, ordered list of model references that can be assigned to agent roles. Every entry in a profi… |
| 68 | `favorite_manage` | fallback | `#9ca3af` | auto / mut | Manage your favorite provider/model list. Favorites are the only models that can be added to fallback chains and profiles. The LLM uses this tool to… |
| 69 | `fetch` | web | `#34d399` | confirm / ro | Fetch a URL and return its content. HTML pages are automatically converted to clean markdown. This tool has strong SSRF protections (private IPs, loc… |
| 70 | `find_related_memories` | fallback | `#9ca3af` | auto / ro | Find memories related to the given text via graph traversal. Only available with graph backends; falls back to content search with file backends. |
| 71 | `flake_detect` | fallback | `#9ca3af` | confirm / ro | Runs a test command multiple times and reports tests that fail non-deterministically. |
| 72 | `flake_status` | fallback | `#9ca3af` | auto / ro | Reports test-flake-detector state: config and per-session counters. |
| 73 | `fleet` | fallback | `#9ca3af` | auto / ro | Fleet observation tool. Use `action` to select what you need: "status" — snapshot of all subagents + coordinator counts + pending tasks; "usage" — to… |
| 74 | `fleet_emit` | fallback | `#9ca3af` | auto / ro | Emit a structured event on the FleetBus. Known collaboration events are schema-validated and role-bound; custom event types remain extensible. Use it… |
| 75 | `fleet_status` | fallback | `#9ca3af` | auto / ro | Live snapshot of every agent working on this canonical project (all clients, processes, sessions, branches, and linked Git worktrees): who is online… |
| 76 | `forget` | settings | `#9ca3af` | confirm / mut | Remove memory entries whose text/tag/anchor matches the query (case-insensitive). Requires force: true — this is a bulk delete. Prefer `memory_delete… |
| 77 | `format` | code | `#818cf8` | confirm / mut | Format source files according to project style (Biome/Prettier for JS/TS, or the detected language formatter such as cargo fmt, ruff format, dart for… |
| 78 | `git` | git | `#a3e635` | confirm / mut | Git repository inspection, diffs, log, commit (mcp-server-git)stdiouvxmcp-server-git--repository. |
| 79 | `git_autocommit` | fallback | `#9ca3af` | confirm / mut | Stage files and create a git commit with an AI-generated conventional commit message. |
| 80 | `gitignore_guard_append` | fallback | `#9ca3af` | confirm / mut | Appends a .gitignore entry for a build-artifact-looking path (or an explicit pattern). |
| 81 | `gitignore_guard_status` | fallback | `#9ca3af` | auto / ro | Reports gitignore-guard state: mode, active pattern lists, and per-session suggest/append/skip counters. |
| 82 | `glob` | folder | `#38bdf8` | auto / ro | Find files by path pattern. Results are sorted by modification time, newest first, so when the list is truncated at `limit` it is the oldest files th… |
| 83 | `grep` | search | `#a78bfa` | auto / ro | Search exact file contents using a regular expression. Use index-backed `codebase-search` first for symbol or concept discovery when it is live. Pref… |
| 84 | `handoff_note` | fallback | `#9ca3af` | auto / ro | Manually compose and send a handoff note to another agent via the project mailbox. |
| 85 | `handoff_status` | fallback | `#9ca3af` | auto / ro | Reports agent-handoff counters and the last handoff message id. |
| 86 | `image_generate` | file | `#60a5fa` | confirm / mut | Generate an image from a text prompt with an image model of a configured provider (OpenAI images, Gemini/Imagen) and save it into the project. |
| 87 | `injection_shield_status` | fallback | `#9ca3af` | auto / ro | Reports injection-shield state: watched tools, pattern names, and counters (scans, detections). |
| 88 | `install` | package | `#f472b6` | confirm / mut | Install, update or manage packages using the detected package manager (pnpm/npm/yarn). Strongly preferred over raw shell commands for dependency mana… |
| 89 | `jev_status` | fallback | `#9ca3af` | auto / ro | Check whether the Jev decision tool is enabled and usable. No network request. Reports local account readiness and shared client health; does not pro… |
| 90 | `json` | json | `#eab308` | auto / ro | Parse, pretty-print, query, validate, transform, and merge JSON (read-only — does not write files). Input must be strict JSON; results can be rendere… |
| 91 | `kanban` | task | `#5eead4` | confirm / mut | Manage project Kanban boards, cards, assignments, and acceptance evidence. |
| 92 | `kanban_queue` | fallback | `#9ca3af` | auto / mut | Claim dependency-ready Kanban tasks and dispatch them into the Director fleet. Preserves per-task provider/model/role/tool routing metadata, seeds le… |
| 93 | `language` | code | `#818cf8` | confirm / mut | Execute predefined language-specific checks, linters, formatters, tests, builds, and debugging evidence. |
| 94 | `language_info` | code | `#818cf8` | auto / ro | Detect language workspaces and preview predefined language-specific command plans without executing them. |
| 95 | `language_package` | package | `#f472b6` | confirm / mut | Restore, mutate, audit, or report outdated packages via predefined ecosystem-specific plans. |
| 96 | `leader_effort_set` | fallback | `#9ca3af` | auto / ro | Change YOUR OWN reasoning effort for the rest of this conversation when the work changes shape: raise it before deep debugging, design, security or r… |
| 97 | `leader_model_set` | fallback | `#9ca3af` | auto / mut | View or change the leader provider/model and system toggles. The leader is the primary model used for the main agent interactions. "set" changes it d… |
| 98 | `leader_tier_set` | fallback | `#9ca3af` | auto / mut | Inspect or change the leader's own cost tier (e.g. "budget" \| "standard" \| "premium"). Use "set" when the nature of the work has changed enough to ju… |
| 99 | `lint` | code | `#818cf8` | confirm / mut | Run the project linter (Biome/ESLint for JS/TS, or the detected language linter such as clippy, ruff, golangci-lint/go vet, rubocop, dotnet). Detects… |
| 100 | `lint_gate_status` | fallback | `#9ca3af` | auto / ro | Reports lint-gate state: linter detected, mode, severity threshold, and per-session invocation/hit/error counters. |
| 101 | `llm` | fallback | `#9ca3af` | auto / ro | Make a one-shot LLM call with a system prompt and user input. Supports provider selection, model routing by role, fallback chains, and timeout. Retur… |
| 102 | `logs` | logs | `#a3a3a3` | confirm / ro | Read logs from files or Docker containers. Useful for debugging running applications. |
| 103 | `loop_breaker_status` | fallback | `#9ca3af` | auto / ro | Reports loop-breaker state: config, current repeat streak, and counters (warnings, blocks, oscillations). |
| 104 | `lsp_code_actions` | fallback | `#9ca3af` | auto / ro | List quick fixes and refactors offered by the language server. |
| 105 | `lsp_completion` | code | `#818cf8` | auto / ro | Get semantic code completions from a configured language server. |
| 106 | `lsp_definition` | search | `#a78bfa` | auto / ro | Find where a symbol is defined. |
| 107 | `lsp_diagnostics` | code | `#818cf8` | auto / ro | Get diagnostics from configured language servers. |
| 108 | `lsp_execute_command` | fallback | `#9ca3af` | confirm / mut | Execute a named command exposed by a configured language server. |
| 109 | `lsp_hover` | fallback | `#9ca3af` | auto / ro | Get type and documentation information for a symbol. |
| 110 | `lsp_references` | fallback | `#9ca3af` | auto / ro | Find semantic references to the symbol at a source position. |
| 111 | `lsp_rename` | edit | `#fbbf24` | confirm / mut | Rename a symbol semantically across the workspace. |
| 112 | `lsp_request` | fallback | `#9ca3af` | confirm / mut | Invoke a custom request method exposed by a language server. |
| 113 | `lsp_symbols` | fallback | `#9ca3af` | auto / ro | List the semantic symbol tree of a source file. |
| 114 | `mail_inbox` | fallback | `#9ca3af` | auto / mut | Read your unread project-wide mail from agents in any client, session, branch, or linked Git worktree and mark it read. Covers mail addressed to you… |
| 115 | `mail_send` | fallback | `#9ca3af` | auto / mut | Send mail to any agent on this canonical project across clients, processes, sessions, branches and linked worktrees; use it to hand off work, ask que… |
| 116 | `mailbox` | fallback | `#9ca3af` | auto / mut | Low-level inter-agent mailbox with 7 actions (check, send, ack, query, status, online, unread). For most use cases, prefer the simpler `mail_send` an… |
| 117 | `mcp_control` | fallback | `#9ca3af` | confirm / mut | Manage MCP server lifecycle: list available servers, search by name or capability, enable or disable servers at runtime, restart running servers. Use… |
| 118 | `mcp_use` | fallback | `#9ca3af` | confirm / mut | Call an MCP tool on a lazy-loaded server. Activates the server temporarily (starting a sleeping server), calls the tool, returns the result, and deac… |
| 119 | `memory_backfill_recoverable` | search | `#a78bfa` | confirm / ro | Find status="deleted" memories that are still recoverable and either preview them (default) or restore them as fresh active versions. |
| 120 | `memory_candidates` | settings | `#9ca3af` | confirm / mut | List, accept, reject, propose, or resolve memory candidates. Proposing files a non-destructive review suggestion into the ReviewQueue; resolving appl… |
| 121 | `memory_delete` | settings | `#9ca3af` | confirm / mut | Delete one SAGE entry by id (soft-delete with graph/relationship cascade cleanup). Requires force: true — all deletions are audited and need explicit… |
| 122 | `memory_for_file` | search | `#a78bfa` | auto / ro | Retrieve memories attached to a file, grouped by how they match. Supports a cursor line range so symbol-anchored memories under the caret surface fir… |
| 123 | `memory_for_path` | search | `#a78bfa` | auto / ro | Retrieve project knowledge for a path and its ancestor directories. |
| 124 | `memory_gather_batch` | search | `#a78bfa` | auto / ro | Gather a bounded batch of memories with optional graph relations. Use this for bulk memory review and cleanup workflows — enumerates active memories… |
| 125 | `memory_graph` | tree | `#22d3ee` | auto / ro | Traverse relationships between memories, files, symbols, commands, and sessions. |
| 126 | `memory_hygiene` | settings | `#9ca3af` | confirm / mut | Deduplicate, verify anchors, mark stale, supersede old versions, and surface review candidates for deletion or archival. Never auto-deletes live memo… |
| 127 | `memory_recover` | settings | `#9ca3af` | confirm / mut | Restore a deleted SAGE entry to active status. Superseded entries resolve to the head of their version chain (no-op write). |
| 128 | `memory_search` | search | `#a78bfa` | auto / ro | Search structured project memory using lexical, tag, path, and anchor signals. |
| 129 | `memory_search_explain` | search | `#a78bfa` | auto / ro | Like `memory_search` but each result carries a per-channel score breakdown — lexical score, vector score, RRF final score, and a `source` attribution… |
| 130 | `memory_update` | settings | `#9ca3af` | confirm / mut | Update a single SAGE entry by id — edit text, tags, kind, anchors, importance/confidence, status, or relationships. |
| 131 | `memory_verify` | settings | `#9ca3af` | confirm / mut | Verify file, directory, symbol, content-hash, and git-blob anchors and update stale state. |
| 132 | `mutation_test` | fallback | `#9ca3af` | auto / ro | Chaos Monkey mutation testing: deterministically sabotage boundary conditions in the target code (> to >=, + to -, boolean flips, return null), re-ru… |
| 133 | `nextsteps` | todo | `#facc15` | auto / ro | Record the after-task follow-on suggestions for this turn. Equivalent to ending your final message with a <nextsteps> block — use whichever you prefe… |
| 134 | `outdated` | package | `#f472b6` | confirm / mut | Check for outdated dependencies in the project. Reports current, wanted (semver range), and latest versions available. |
| 135 | `patch` | edit | `#fbbf24` | confirm / mut | Apply a unified diff (patch) to the project. This is the correct tool when you have a diff that needs to be applied precisely, including handling of… |
| 136 | `pin_add` | fallback | `#9ca3af` | confirm / mut | Pin a short durable fact into the system prompt so it survives context compaction. |
| 137 | `pin_list` | fallback | `#9ca3af` | auto / ro | List all pinned facts currently injected into the system prompt. |
| 138 | `pin_remove` | fallback | `#9ca3af` | confirm / mut | Remove a pinned fact by its id (pin-N) or label. |
| 139 | `plan` | plan | `#2dd4bf` | confirm / mut | Manage a session-persistent strategic plan. The plan is written to disk and survives conversation resumptions within the same session, but is isolate… |
| 140 | `plugin_manager` | fallback | `#9ca3af` | auto / mut | Manage WrongStack plugins through a guarded discovery-first workflow. Search the host catalog, inspect effective state and live plugin-owned tool sch… |
| 141 | `present_artifact` | document | `#94a3b8` | auto / ro | Present an existing project text file, raster image, unified diff, or an owned live browser session. Graphical surfaces use read-only previews or the… |
| 142 | `process_guard_status` | fallback | `#9ca3af` | auto / ro | Reports process-guard state: mode, counters, and last detected kill-related command. |
| 143 | `project_kit` | package | `#f472b6` | auto / ro | Discover reusable project-specific tools before writing ad hoc scripts. Inspect contracts and guides, retrieve authoring templates, or read execution… |
| 144 | `project_kit_run` | terminal | `#67e8f9` | confirm / mut | Verify or run a revision-pinned Project Kit tool with schema-checked parameters in a tracked Node process. Executes arbitrary project code; verificat… |
| 145 | `prompt_firewall_status` | fallback | `#9ca3af` | auto / ro | Reports prompt-firewall state: mode, pattern kinds, and detection/redaction/block counters. |
| 146 | `provider_key_set` | fallback | `#9ca3af` | confirm / mut | Set the API key for a provider. For security, prefer using envVar (reads from environment variable, value never visible to the LLM) over passing the… |
| 147 | `provider_manage` | fallback | `#9ca3af` | auto / mut | View or configure provider entries. List all configured providers with their type, model lists, base URL, key status, and disabled state. Add new pro… |
| 148 | `pwsh` | terminal | `#67e8f9` | confirm / mut | Execute a PowerShell command (`pwsh -Command`) in a fresh process on Windows and return its stdout/stderr. Stateless per call: pass `workdir` instead… |
| 149 | `quality_gate` | fallback | `#9ca3af` | auto / ro | Run a first-class implementation quality gate. It can await implementer task ids, spawn independent verifier/reviewer agents, summarize their verdict… |
| 150 | `read` | file | `#60a5fa` | auto / ro | Read the contents of a file with line numbers. This is the primary way to inspect source code, configuration, or any text file before making changes.… |
| 151 | `read_url_content` | web | `#34d399` | auto / ro | Fetch content from a URL via HTTP request (invisible to USER). Use when: (1) extracting text from public pages, (2) reading static content/documentat… |
| 152 | `remember` | settings | `#9ca3af` | confirm / mut | Persist structured project knowledge into long-term SAGE. Bind it to files, symbols, or commands with `anchors` so it can be verified and auto-surfac… |
| 153 | `replace` | edit | `#fbbf24` | confirm / mut | Perform a search-and-replace across multiple files using a regex pattern. This is a powerful bulk transformation tool. Dry-run is ON by default — set… |
| 154 | `roll_up` | fallback | `#9ca3af` | auto / ro | Aggregate completed task results into a single formatted summary. |
| 155 | `search` | search | `#a78bfa` | auto / ro | Perform a web search and return results with title, URL, and snippet. Use this when you need up-to-date external information that is not in the local… |
| 156 | `search_memory` | fallback | `#9ca3af` | auto / ro | Search memory entries by content. With the default backend this does substring matching; semantic/graph backends use embedding similarity or graph tr… |
| 157 | `secret_scanner_status` | fallback | `#9ca3af` | auto / ro | Reports the current secret-scanner state: pattern count, last block (if any), and per-mode invocation counters. |
| 158 | `secret_scanner_test` | fallback | `#9ca3af` | auto / ro | Run the scanner against a user-supplied string and report which patterns matched. |
| 159 | `security-ast-scan` | code | `#818cf8` | auto / ro | Scan source code for contract-based security vulnerabilities and performance bottlenecks (N+1 SQL queries, SQL injection, hardcoded secrets, prototyp… |
| 160 | `semver_bump` | fallback | `#9ca3af` | confirm / mut | Determine the next version bump from conventional commits since the last tag, or force a specific bump. |
| 161 | `semver_changelog` | fallback | `#9ca3af` | auto / ro | Generate a changelog (in markdown) between two version tags or from a tag to HEAD. |
| 162 | `semver_current` | fallback | `#9ca3af` | auto / ro | Return the current version from package.json and the latest git tag. |
| 163 | `session_note` | fallback | `#9ca3af` | auto / ro | Send an ephemeral note to the leader or another agent in THIS session. Delivered at their next iteration. Use it for same-session talk (findings, a s… |
| 164 | `session_recap_status` | fallback | `#9ca3af` | auto / ro | Reports session-recap state: config, accumulated metrics (tokens, tool calls, commits), and last recap status. |
| 165 | `session_rename` | fallback | `#9ca3af` | auto / mut | Give the current session a short descriptive title, shown in session history and resume lists. Use it once the task is clear, or when the work has mo… |
| 166 | `skill` | document | `#94a3b8` | auto / ro | Load a skill's instructions or a bundled resource on demand (agentskills.io progressive disclosure). With only `name`: returns the SKILL.md body + a… |
| 167 | `spawn_subagent` | fallback | `#9ca3af` | auto / ro | Create a new subagent under this director (own LLM context, own budget). NON-BLOCKING: returns a `subagentId` immediately without triggering any mode… |
| 168 | `system_config_view` | fallback | `#9ca3af` | auto / ro | Get a comprehensive view of all provider, model, fallback, and matrix configuration. Shows the complete state across all configurable areas so you ca… |
| 169 | `task` | task | `#5eead4` | confirm / mut | Manage session-persistent structured work items with dependencies, types, and priorities. Unlike `todo` (flat, tactical), `task` supports typed work… |
| 170 | `telegram_approve` | fallback | `#9ca3af` | confirm / mut | Post a scrubbed yes/no prompt only to the paired Telegram chat or an explicitly allowed outbound chat, then wait for a button press. Returns approval… |
| 171 | `telegram_read` | fallback | `#9ca3af` | auto / ro | Read recent incoming Telegram messages the bot has received, newest first. Returns messages with sender, text, and timestamp. After reading, acknowle… |
| 172 | `telegram_send` | fallback | `#9ca3af` | confirm / mut | Send a scrubbed message to the paired Telegram chat or an explicitly allowed outbound chat. Write natural prose for a human reader; summarize results… |
| 173 | `terminate_all` | fallback | `#9ca3af` | auto / mut | Forcibly stop every subagent in the fleet and drain the pending task queue. In-flight tasks are terminated mid-execution; pending tasks receive "abor… |
| 174 | `terminate_subagent` | fallback | `#9ca3af` | auto / mut | Forcibly abort a subagent. The subagent finishes its current iteration then exits with status "stopped". |
| 175 | `test` | test | `#4ade80` | confirm / ro | Execute the project's test suite. This is one of the most critical tools for validating that your changes are correct. |
| 176 | `test_impact_analyze` | fallback | `#9ca3af` | auto / ro | Inspect a diff, changed-file list, or test output for test-impact signals. |
| 177 | `todo` | todo | `#facc15` | confirm / mut | Manage the compact active-work list. With a managed Kanban binding, every row resolves to a real card and status changes advance that card; without K… |
| 178 | `todo_listener_status` | fallback | `#9ca3af` | auto / ro | Reports todo-listener state: config plus per-session counters (invocations, sent, skipped, errors) and last broadcast id. |
| 179 | `tool_script` | meta | `#cbd5e1` | auto / ro | WrongStack ToolFlow: run a short JavaScript program that calls tools as async functions and returns only its result. |
| 180 | `tool_search` | meta | `#cbd5e1` | auto / ro | Search the catalog of available tools by name or description. Use this to discover which tool to use for a task, including tools whose schemas were w… |
| 181 | `tool_use` | meta | `#cbd5e1` | confirm / mut | Directly execute any registered tool by its exact name, bypassing normal discovery. This is a powerful meta-tool intended for cases where the agent h… |
| 182 | `tree` | tree | `#22d3ee` | auto / ro | Display a project or subpath directory tree. Use it for structural layout; use index-backed `codebase-search` first for code understanding when it is… |
| 183 | `type_gate_status` | fallback | `#9ca3af` | auto / ro | Reports type-gate state: command, tsconfig, severity, and per-session pass/fail/error counters. |
| 184 | `typecheck` | code | `#818cf8` | confirm / ro | Run Bun's TypeScript type checker without emitting files. Requires a working Bun checker and provisions the pinned runtime if needed. Other languages… |
| 185 | `watch_list` | fallback | `#9ca3af` | auto / ro | List all currently active file watches with their IDs, paths, and creation times. |
| 186 | `watch_start` | fallback | `#9ca3af` | confirm / ro | Start watching one or more file paths for changes (add, change, delete). |
| 187 | `watch_stop` | fallback | `#9ca3af` | auto / ro | Stop a file watch by its ID. |
| 188 | `work_complete` | fallback | `#9ca3af` | auto / ro | Signal that the director is satisfied with the results and the fleet should wind down. Until the next user request, spawn_subagent and delegate refus… |
| 189 | `workspace_health_analyze` | fallback | `#9ca3af` | auto / ro | Inspect package.json, tool output, or workspace configuration for health-contract failures. |
| 190 | `write` | file | `#60a5fa` | confirm / mut | Write or completely overwrite a file on disk. This is a high-privilege operation. For modifying existing files, you should almost always prefer the `… |

**Reading this table**

- **Icon** follows the shipping resolver `getToolIcon()` (`packages/tools/src/tool-icon-map.ts`): an inline `icon:` field on the tool definition wins, then `TOOL_ICON_MAP` (lower-cased name), then `fallback`.
- **107 of 190 tools resolve to `fallback`** — they declare no inline `icon:` and are absent from `TOOL_ICON_MAP`. All `browser_*` tools are in this group: they are built by the `selectorTool`/`tool()` factories in `packages/tools/src/browser/tools.ts`, which never set `icon`.
- **Color** comes from `TOOL_ICON_CONFIG` in `packages/tools/src/tool-icons.ts`, which documents itself as the canonical source both surfaces read. `packages/tools/src/tool-icon-map.ts` also exports a `TOOL_ICON_CONFIG` for the same 24 ids with **different hex values** (`file`: `#60a5fa` vs `#6366f1`; `terminal`: `#67e8f9` vs `#fb923c`) — an unresolved duplicate table.
- **Permission** is rendered `permission / mutability`; `confirm / mut` means it prompts and changes state.
- **Description** is the tool's own `description`, collapsed to one line and truncated at 150 characters (`…`). 40 tools build their description through factories, constants or template literals; their text is taken from the catalog metadata served in this session rather than re-derived, and is marked here as authoritative catalog text.
