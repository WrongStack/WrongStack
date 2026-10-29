# Desktop v2: continuation and remaining delivery work

Updated: 2026-10-29 (second pass). This is the handoff for the next implementation agent.

## Start here

Continue the existing Tauri implementation in `D:\Codebox\PROJECTS\WrongStack`.
The objective remains a complete, polished, engine-backed desktop application for working with
multiple projects and multiple persistent sessions. The application is substantial, but full
WebUI action parity and production release certification are still open.

**Continue from the current working directory, including its uncommitted files. A checkout of
HEAD alone does not contain the latest desktop work.** Do not recreate completed features from
the original analysis or treat an old validation entry as the latest state.

Read these documents together:

- [Product architecture and owner overrides](desktop-v2-analysis.md).
- [Action-level feature inventory](desktop-v2-feature-parity.md).
- [Chat and composer action inventory](desktop-v2-chat-parity.md).
- [Dated executable evidence](desktop-v2-validation.md).
- [Desktop development and native test instructions](../apps/desktop-v2/README.md).

The feature inventory supplies the broad coverage map. This handoff adds the latest work,
uncommitted dependencies, verification exceptions, implementation priorities and concrete next steps.

## Product constraints that must survive the handoff

1. All product screens and interactions belong inside the Tauri application. Do not open, embed,
   iframe or import the WebUI frontend to implement projects, sessions or settings. Reading its
   source to understand behavior is expected. Sharing engine services and protocol contracts is
   allowed. Runtime frontend imports must not reach WebUI/HQ/VibeUI UI modules.
2. Preserve ownership boundaries:
   - Project: Memory/SAGE, Kanban, Atlas, Chronicle, reviews, Goals/SDD, Automations and other
     project tools open without creating a conversation.
   - WrongStack profile: providers, models, Brain, fleet, execution and other engine defaults are
     settings; they must work before registering projects or sessions.
   - Session: chat, queue, reasoning/effort, approvals, processes, session model plans and recovery
     operate on the owning persistent conversation.
   - Desktop: appearance and native window/workspace preferences remain separate from engine config.
3. Use the existing WrongStack logo, canonical color pairs, themes, System/Light/Dark behavior and
   shared CSS tokens. Build readable workflows, graphs, inspectors and settings. Raw JSON dumps,
   generic forms and an ever-growing wall of tabs do not establish feature parity.
4. Keep resting chat calm. Its compact composer still needs model/effort, BTW/queue/steer,
   refinement, references and attachments. Put infrequent diagnostics and advanced controls in
   contextual dialogs or dedicated Tools workspaces.
5. SAGE and vector memory are distinct. SAGE opens with canonical counts and its actual directed,
   labelled relationship graph. Do not require vector linkage, vector loading or vector search to
   display SAGE records or totals. Never fabricate relationships from shared tags.
6. Use real engine contracts. If the engine lacks an operation, document or implement that contract
   rather than inventing a successful local-only button. This matters for job deletion, atomic
   writes, queue prioritization, worktree operations and task execution.
7. Preserve unsupported catalog metadata and explicit false/zero values. Distinguish unknown,
   inherited, estimated, observed and verified states in both implementation and reports.
8. Documentation and handoff prose are written in English. Communicate progress to the user in Turkish.

The earlier system-prompt/cache investigation was explicitly set aside by the user in favor of
desktop work. Do not resume it as this task or absorb independent prompt changes into desktop commits.

## Shared checkout and commit state

- Use this existing main checkout. Do not create, switch to or use a Git worktree unless the user
  explicitly overrides that preference.
- The checkout is heavily dirty and shared. Bench, prompt infrastructure, agent learning files,
  other packages and independent fixes are present. Do not reset, stash, clean, overwrite or stage
  them as part of desktop work. Inspect current status before edits and commits.
- Handoff HEAD: `f348a7dd3`. It includes independent commits after the desktop checkpoint. Re-read
  `git log` because other agents may advance HEAD without changing this task.
- Second pass (2026-10-29): the price-tier/draft/profile work is committed as `a7827d8a8` and
  `4fcafaf8d`; HEAD was `5e87de43a` with a clean tree. The saved-draft administration increment
  is uncommitted: `ModelDraftAdministration.tsx`, `model-draft-admin.ts`,
  `tests/model-draft-admin.test.ts` (new) plus edits to `ModelCatalogSettings.tsx`,
  `model-editor-draft.ts`, `useModelEditorDraft.ts`, `model-catalog.css`, `registry.rs`,
  `desktop.rs`, `native-model-profiles.mjs` and the three desktop docs.
- The index was empty when this handoff was prepared. No feature commit was created during the
  latest price-tier/profile-draft increments.
- Existing desktop commits include:

| Commit | Scope |
| --- | --- |
| `c7eeb5211` | Revision-aware retained conversation catalog paging |
| `25c9f1a21` | Engine APIs, correlation, structured policy and desktop tool support |
| `e22d3362c` | Native registry/drafts and recorded conversation restoration |
| `aa195a088` | Structured provider/model/Brain/fleet/execution/refinement/review settings |
| `4f3b5d4c3` | Project knowledge and engineering workspaces |
| `b089b1334` | Session/composer integration and native acceptance coverage |
| `e9906c6a6` | Shared scrubbing of Git review errors |
| `b2d11741d` | Parity and native acceptance documentation |
| `21c900681` | Reviewed restoration of inherited Brain monitor defaults |

The user previously approved skipping generated Core API snapshots and architecture report
production for that specific desktop commit series. Other commit guards were retained with a
temporary per-command hook. The repository hook and configured `.githooks` path were not changed.
**That was a scoped exception, not permanent permission to bypass hooks.** Inspect the current
hook and session authorization before another commit series. Do not reuse old bypass commands
automatically or let report generation commit unrelated shared-checkout inputs.

Do not delete the existing `apps/desktop-v2/.engine-chronicle-proof/` directory or broadly remove
`.temp_files`. There are retained proofs and unrelated fixtures. Remove only disposable files
whose ownership and resolved target directory you have verified.

## Latest completed implementation: preserve and build upon it

### Context price tiers

The native model catalog now has a structured context-price tier editor and saved-price view.
It uses the observed catalog shape `cost.tiers[].tier = { type: "context", size: <tokens> }`.
Input/output/cache/reasoning/audio rates, explicit zero, unspecified fields, ordering, removal,
duplicate-threshold refusal and exact tier readback are implemented.

Provider-specific rows and unknown metadata are retained. The shared model schema accepts both
legacy scalar and structured `context_over_200k` schedules. Unrelated edits retain structured
legacy rates instead of deleting them through an empty scalar input.

These are catalog metadata controls. The conversation Usage & cost estimate still uses aggregate
current-model rates; it does not implement historical, tier-aware or TTL-specific billing.

Entry points:

- `apps/desktop-v2/src/ModelPriceTiers.tsx`
- `apps/desktop-v2/src/model-price-tiers.ts`
- `apps/desktop-v2/src/model-catalog-editor.ts`
- `packages/core/src/models/models-dev-schema.ts`
- `apps/desktop-v2/tests/model-price-tiers.test.ts`
- `apps/desktop-v2/tests/native-model-price-tiers.mjs`

### Durable native model-editor drafts

Native SQLite has a separate `profile_form_drafts` table and trusted Tauri
`profile-draft.get/save` IPC. Saves and clears use expected revisions, checked acknowledgements,
bounded payloads and SQLite transactions. They do not create project/session records.

The full editor, its original saved-definition baseline, reasoning controls and unfinished price
fields survive acknowledged saves. Recovery is opt-in. Local/saved comparisons, changed-again
refusal, pre-apply draft verification and acknowledged cleanup are implemented. A failed or stale
clear retains the editor and cannot erase a newer peer draft.

Applying provider configuration and clearing the native draft remain two operations. They are not
one atomic transaction. Do not claim atomic custom-model writes from the draft CAS implementation.

Entry points:

- `apps/desktop-v2/src/model-editor-draft.ts`
- `apps/desktop-v2/src/useModelEditorDraft.ts`
- `apps/desktop-v2/src/ModelDraftNotice.tsx`
- `apps/desktop-v2/src/ModelCatalogSettings.tsx`
- `apps/desktop-v2/src-tauri/src/registry.rs`
- `apps/desktop-v2/src-tauri/src/desktop.rs`
- `apps/desktop-v2/tests/model-editor-draft.test.ts`
- `apps/desktop-v2/tests/native-model-drafts.mjs`

### Actual process restart acceptance

`--model-draft-restart` exercises two UI-process restarts and two complete owned host/engine
restarts, with fresh WebView2 data directories. The acknowledged SQLite snapshot and original
model baseline survive, an unfinished definition is not applied, a stale recovered model cannot
overwrite newer settings, and an acknowledged discard remains cleared.

Previously verified portable identity: `59b87f3dc9da-890d72a48a36`.
The current profile-ownership changes update this test's storage keys, but this exact restart scope
has not yet been rerun against the newest profile-aware bundle. The new profile scope below does
exercise cold restarts with the new keys.

Entry points: `apps/desktop-v2/tests/native-model-draft-restart.mjs` and the shared harness
`apps/desktop-v2/tests/native-smoke.mjs`.

### Latest increment: real profile ownership and reviewed legacy copying

Implemented in the working tree and passed the dedicated native profile scope:

- The standalone engine reports `profileIdentity` through `prefs.get`. Its opaque ID is derived
  from the canonical path of the profile config file actually opened by that runtime; the config
  contents and a provider name alone are not the identity. The path itself is not exposed.
- Model settings acquire a verified profile context. Missing identity fails closed with reconnect
  guidance. Reads and model mutations verify that the runtime still belongs to the expected profile.
- Draft keys hash the profile ID together with the provider ID. Store caches and saved envelopes
  also carry profile ownership. An envelope from another profile is rejected.
- Earlier provider-only drafts are treated as unassigned. The user can review and explicitly copy
  one into the selected profile. The target must be free; copying retains the unassigned source
  and does not apply provider settings. Source deletion is explicit and revision checked.
- The modal shows the profile name alongside the provider. This increment does not add a general
  interactive profile-management UI.
- Native `--model-profiles` switches the real bootstrap-selected profile through cold restarts,
  using the same desktop SQLite database and the same provider/model IDs in two profile files.
  Drafts remain separate; applying a model in A leaves B unchanged and vice versa. Legacy copy
  retains its source, and a changed legacy draft cannot be deleted using an older review.

Important source files:

- `packages/webui-server/src/server/profile-identity.ts`
- `packages/webui-server/src/server/prefs-route-context.ts`
- `packages/webui-server/src/server/prefs-handlers.ts`
- `packages/webui-server/tests/profile-identity.test.ts`
- `apps/desktop-v2/src/ModelCatalogProfile.tsx`
- `apps/desktop-v2/src/model-draft-key.ts`
- `apps/desktop-v2/src/LegacyModelDraftNotice.tsx`
- `apps/desktop-v2/tests/model-profile-drafts.test.ts`
- `apps/desktop-v2/tests/native-model-profiles.mjs`

The standalone profile runtime is wired. Audit any other host adapter before relying on this
metadata there. Do not fabricate a default profile identity when a host does not supply one.
Saved-draft administration for orphaned, other-profile and unverified drafts is implemented (see the
2026-10-29 validation entry). Profile renames/moves and future draft-format migration still need work.

## Verification at handoff: exact boundaries

| Check | Latest observed result |
| --- | --- |
| Desktop package suite | **373 tests / 80 files PASS** |
| Desktop typecheck | **231 source files PASS** |
| Backend typecheck | **318 source files PASS** |
| Focused backend profile/preferences/correlation checks | **62 tests / 7 files PASS** |
| Focused Biome checks for profile increment | **16 files PASS** |
| Fresh engine build and Tauri release build | **PASS** |
| Native `--model-profiles` | **PASS**, exit 0, `46264c02100d-34d54c7e64c5`, bundled engine and checksums verified |
| Latest full backend package run | **3337 tests / 341 files PASS** (2 workers, serialized, 2026-10-29) |
| Isolated rerun of the failing history file | **5 tests PASS**, 21 seconds, unchanged assertions/timeout |
| General native `--models` against the newest bundle | **PASS** on `2f5045c5270f-8d5e009090b5` |
| Exact `--model-draft-restart` scope against the newest bundle | **PASS** on `2f5045c5270f-8d5e009090b5` |
| Native Rust suite | Earlier draft-storage increment: **20 tests PASS**; no new Rust change in the profile-identity increment |
| Full repository release/coverage, hosted CI, installed app replacement | **NOT RUN for these increments** |

The full backend failure is
`tests/project-history-search.test.ts > searches an older-than-500 record through catalog continuation with bound query and pool revisions`.
It exceeded the existing 60-second timeout. The failure stack points into the serial construction
of hundreds of real transcript fixture files. The same file passed alone with one worker after
the broad run completed. This suggests load sensitivity; a clean full-package result is still
required. Do not call the failure pre-existing or fully diagnosed without further evidence.

No timeout, assertion or test count was weakened. No fixture optimization was applied before
this handoff. The user requested this document while the next step was being considered.

Artifacts to inspect:

| Path under `.temp_files/desktop-v2-native/` | Evidence |
| --- | --- |
| `model-profiles/native-result.json` | Latest native profile PASS and exact portable identity |
| `model-profiles/native-model-profile-proof.json` | Distinct actual profile IDs, namespace/config isolation and legacy decisions |
| `model-profiles/native-model-profile-owned-recovery.png` | Inspected native owned-draft recovery screen |
| `model-profiles/native-model-profile-legacy-review.png` | Legacy migration review |
| `model-profiles-native.log` / `.err` | Dedicated profile acceptance output |
| `model-profiles-backend-tests.log` | Focused 62-test result |
| `model-profiles-backend-full.log` | Full run with the one history timeout |
| `model-profiles-history-isolated.log` | Isolated five-test PASS |
| `model-profiles-engine.log` / `.err` | Latest engine build |
| `model-profiles-build.log` / `.err` | Latest Tauri build |
| `model-draft-restart/` | Earlier actual process-restart proof and process identities |
| `models/` | Earlier catalog, pricing, model-draft and provider acceptance screenshots/results |

Artifact directories are reused. An older `native-result.json` does not establish that a later
failed run passed. Check process exit, result timestamp, scope and portable identity together.

The most recent profile result has been recorded here; it was not yet appended as a new detailed
section in `docs/desktop-v2-validation.md` when work switched to this handoff.

## First actions for the next agent

1. Read current Git status and preserve both tracked WIP and untracked desktop dependencies.
   Inventory new source files before committing; relative imports to forgotten untracked modules
   can pass locally and fail in a clean checkout.
2. Finish verification of the latest profile-ownership increment:
   - Review the new profile identity, namespace/envelope and legacy-copy code.
   - Recheck metadata availability in the runtime paths used by desktop.
   - Run `--models` against the exact new portable bundle; rerun the dedicated restart scope if
     changing ownership, lifecycle or acknowledgement behavior.
   - Resolve the full backend timeout using isolated evidence and serialized verification first.
     Try the repository's worker override with native UI tests stopped. Keep all 507 fixture
     records, the older-than-500 assertion, valid/error controls and the existing timeout.
     If fixture construction is the reproduced bottleneck, consider bounded independent file-write
     batches; do not skip the test, reduce its catalog or simply raise its timeout.
   - Append the final verification record with honest full-package status.
3. Group and commit the pending desktop work when appropriate. Suggested groups: shared pricing
   schema fix; native price-tier authoring; durable model drafts; process restart acceptance;
   profile-owned drafts/legacy copying; evidence/docs. Keep independent prompt/bench/other changes
   outside these commits, including unrelated hunks in mixed preference files.
4. Then continue P1 implementation below. Do not spend the next round reimplementing SAGE graphs,
   Brain seat defaults, monitor reset or the composer features that already have native proof.

## Remaining implementation and acceptance backlog

Priorities describe a suggested delivery order, not completion percentages. Many domains already
have real workflows; the work below closes their missing actions, durability and execution proof.

### P1: everyday work and state correctness

| Area / entry points | What remains | Acceptance to require |
| --- | --- | --- |
| Files: `FileWorkspace.tsx`, `file-draft.ts`, `FileContentSearch.tsx` | Language-aware editor depth; bulk copy/rename and an atomic multi-item contract (bulk move/delete exist per item, 2026-10-29). The directory tree is virtualized and the folder listing pages 200 entries at a time (2026-10-29 validation entry). Saves are now version-bound (`files.write` `expectedSha256`, see the 2026-10-29 validation entry); OS-level exclusion against external writers is not provided. Keep current 2 MiB draft and bounded search/recovery limits visible. | Real external modification and simultaneous-save cases, large trees/files, symlink boundaries, preserved unsaved text and no silent overwrite. |
| Git/review: `GitHunkReview.tsx`, `MergeConflictReview.tsx`, `review-notes-store.ts` | Per-line staging, unsupported partial added/deleted/binary/mode changes, automatic rename grouping, larger/symlink/submodule conflicts, history topology, worktree management and threaded/resolved review discussions. | Real repository/index operations with stale-index refusal, binary/rename/mode cases and precise file-layer ownership. Worktree features must not cause this agent to create a workspace worktree against the user's instruction. |
| Session history: `ProjectSessionHistory.tsx`, `ProjectHistorySearch.tsx`, `SessionTranscript.tsx` | Compressed and large retained histories, binary viewers, over-100-block message expansion, full structured tool inputs, atomic rename policy, older-host migration and richer story/navigation. File-store full scans remain explicitly budgeted at 10,000 records. | Real compressed/long journals, exact-ID navigation, full-catalog search consistency, stale revisions, bounded memory and cancellation. |
| Session recovery: `SessionRecovery.tsx`, `session-recovery-model.ts` | Redo and richer recovery administration, edit/resend/retry, durable recovery-operation records and broader partial-error/restart handling. | Real files and journal state after each operation; active-run refusal, preserved conversation/drafts, stale-operation refusal and visible partial failures. |
| Model/profile settings: `ModelCatalogSettings.tsx`, `ProviderOAuth.tsx`, `ProviderHealth.tsx` | Profile rename/move migration, future draft versions, atomic custom-model writes, live OAuth/account refresh, full vault lifecycle and broader external-provider quota/test cases. | Actual profile/account behavior where authorized, exact config/draft ownership, safe failed writes and restart coverage. Metadata-only OAuth fixture tests do not establish external authentication. |
| Runtime policies: Brain/Fleet/Execution/Refinement/Review settings | Cross-runtime policy refresh, advanced fleet lifecycle/dispatch/probe policies, Brain decision inspection and actual council execution/quality, Shadow, advanced security-rule/display policy editing, and session-specific effective routing. | Actual worker/council decisions and effective settings in the owning runtime. Saving configured policy does not prove dispatch or model behavior. |
| Durable secondary forms | Mailbox compose and automation job drafts are restart-durable (2026-10-29 validation entries). Environment dialog edits become durable only once applied to the job draft; unapplied dialog text is lost on close or reload. | Native ownership, bounded versioned envelopes, load/ack/error states, stale-window comparison, explicit discard and cleanup only after successful domain writes. Reuse `DurableFormDraft` (`durable-form-draft.ts`, first used by Project Kit parameters) without putting project forms into profile/session storage. |

### P1: finish conversation parity while preserving simplicity

Use the [chat action inventory](desktop-v2-chat-parity.md) for exact existing behavior.

- Complete tool-specific and chronological activity presentation, binary/document viewers,
  complete media handling and large-transcript virtualization.
- Add richer model capability/context/pricing detail and quick-switch variants without replacing
  the existing current-profile filtering, favorites/exclusions or session effort controls.
- Add supported reasoning mode/preserve controls and prove provider-specific effort vocabularies
  and leader overrides/resets. Do not manufacture support when the provider reports unknown.
- Finish active worker assignment/topology and actual execution of session-owned model plans.
  Plan drafts are durable per session (2026-10-29); atomic same-plan writes still need a
  canonical contract.
- Add richer skill/resource invocation progress and reference-aware durable recall. File,
  line-range and quoted-snippet references, the code-paste hint/undo and the prompt journal
  month filter, export and older-page loading exist (2026-10-29).
- Implement speech only with real platform support, permission and recording/transcript states;
  unsupported systems must not show a fake working microphone.
- Add BTW delivery/read/processing receipt history, richer queue presentation and longer restart
  coverage. Presentation sorting must not change engine FIFO order.
- Preserve the existing steer rule: queued work must be removed explicitly. Atomic prioritization
  of steer over a nonempty queue needs an engine contract; never silently clear or bypass it.
- Refinement keeps completed reviews across restart and offers a word-level comparison with
  the original (2026-10-29); it still needs richer provenance, external-model quality and reconnect/cancellation/empty/timeout cases. Countdown or automatic submit is a new
  deliberate UX; current refinement must not acquire hidden auto-send.
- Whole-message context editing is validated and applied through the engine (2026-10-29); add
  in-message range editing, mode authoring, residency/retention visualization, draft token
  estimates and richer compaction feedback.
- Add selective draft merging, send-time races, abrupt termination during pending saves and the
  full focus/keyboard/screen-reader matrix. Existing tests protect acknowledged snapshots, not
  every unacknowledged last keystroke.

Entry points include `SessionComposer.tsx`, `SessionWorkbench.tsx`, `SessionModelControls.tsx`,
`SessionAgentPlan.tsx`, `PromptRefinement.tsx`, `SessionContextPanel.tsx`, `PromptWorkspace.tsx`,
`PromptJournal.tsx` and their dedicated model/store helpers.

### P2: project intelligence and visual workspaces

| Area / entry points | Remaining work |
| --- | --- |
| SAGE: `ProjectMemory.tsx`, `SageRecordDetails.tsx`, `SageValidityReview.tsx` | Injection-context/live trace inspector; recovery/backfill administration; large-graph exploration; broader applicability/lifecycle concurrency; native coverage of every repair/retirement proposal. Preserve direct counts and real graph relationships independently of vectors. |
| Vector memory | CRUD, reindex/maintenance, provider configuration and actual enabled-store native acceptance. Keep its UI and lifecycle separate from SAGE. |
| Atlas: `CodeAtlas.tsx`, `AtlasViews.tsx`, `AtlasBoundaryMap.tsx` | Inferred communities when explicit groups are absent, richer persona tours, cross-scope paths, AI flow traces, live actor overlays and large-index performance. Do not replace indexed relationships with fabricated visual links. |
| Chronicle: `ProjectChronicle.tsx` and Chronicle views | Prompt-manifest inspection, export, richer cross-domain navigation and long-history performance. Keep confidence-labelled lineage distinct from asserted delegation. |
| Code Assist | Applied-edit diff/review/rollback, cancellation/error coverage and real-model output quality. Edit opt-in and request-owned streaming must remain. |
| TechStack: `ProjectTechStack.tsx`, `TechStackRemediation.tsx` | Real registry/model research, permission-governed package execution, disk-export acceptance, cross-window job discovery, larger inventories and historical comparisons. Current reviewed-target checks do not prove external execution. |
| Project Kit: `ProjectKit.tsx`, `KitParameterForm.tsx` | Richer run diagnostics/source snapshots, real agent verification/run evidence and large-catalog usability. |
| Design Studio: `ProjectDesignStudio.tsx` | Atomic kit/override changes across runtimes, broader supported-stack outputs and quality/scale proof. |
| Dead code: `ProjectDeadCode.tsx`, `DeadCodePlan.tsx` | Atomic preview-to-apply revision binding, long verification/rollback, restart recovery and richer source navigation. The shared scan API is synchronous and has no invented cancel endpoint. |
| Chimera: `ProjectChimera.tsx`, `ChimeraFinding.tsx` | Full host-restart and actual two-WebView stress, concurrent lifecycle cases, advanced plugin policies, pagination and large-history usability. |

### P2: execution, planning and collaboration

| Area / entry points | Remaining work and proof boundary |
| --- | --- |
| Kanban: `ProjectKanban.tsx`, `KanbanTaskInspector.tsx`, `KanbanExecution.tsx`, `KanbanBreakdown.tsx` | Link Goal/SDD run controls and steering; supported tier-aware assignments; decomposition generation/atomic assessment; resource-boundary editing; same-field conflicts. Preserve the visible board list, detailed inspector and canonical five fixed lifecycle columns. |
| Goals/missions: `ProjectGoals.tsx`, `ProjectMission.tsx` | Budgets, richer task/verification detail, conditional mission writes and broader actual start/control/retry/assign coverage. |
| SDD: `ProjectSdd.tsx`, `SddTaskDetails.tsx`, `SddLifecycle.tsx` | Full intake/spec authoring, live graph/board linkage, historical run detail, catalog-backed run/model choices, real split/rollback and broader provider/run coverage. |
| Requirements: `ProjectRequirements.tsx`, `RequirementResources.tsx` | Configured suggestion generation, richer assessment and larger catalogs. Existing metadata/answer/new-form durability should not be rebuilt. |
| Roster/fleet: `ProjectAgentRoster.tsx`, `ProjectMailbox.tsx`, roster/runtime editors | Actual worker execution and routing, knowledge-checklist editing, delegation ancestry/office topology, agent-level controls/council, large catalogs/fleets, restart-durable drafts and atomic cross-window controls. Membership maps and role inheritance do not establish delegation. |
| Mailbox/collaboration: `MailboxComposer.tsx`, `ProjectMailbox.tsx` | Restart-safe compose with multi-window conflict handling, older thread retrieval, richer delivery/read receipts/notifications, retention, annotations/control and broader lifecycle stress. Delivery acknowledgement is not proof that a worker read or executed the message. |
| Session audit: `SessionSideEffects.tsx` | Persisted paging, project-wide aggregation, live outcome changes, more operation-kind native cases and long-history evidence. |
| Skills: `SkillLibrary.tsx` | Native Git install/update/uninstall/export proof, richer document/dependency metadata, invocation progress. `skills.edit` is still an unconditional engine write behind a read-compare preflight. |

### P2: automation, MCP and supporting runtime tools

- Automations already have structured management/environment/evidence/publication interfaces.
  Finish real Docker execution, service/health/cache/credential lifecycle and restart behavior;
  actual PR prepare/publish/update/check/follow-up; signed GitHub delivery; run comparison; event
  sample authoring and durable secondary forms. Successful management requests do not establish
  successful external runs. The current shared management API has no job-delete endpoint.
- MCP still needs OAuth, secret environment/header and advanced policy administration, broader
  task lifecycle stress, binary attachment preview/download, deep catalogs and explicit tool
  invocation UX. Preserve session task identity/isolation/cancellation and question routing.
- Session processes need batch actions, richer exit/history details and stress proof. Browser
  selection, preview controls, watcher and batch-process integration remain incomplete.
- Usage needs project/profile aggregation, persisted historical model/billing attribution,
  auxiliary-worker inclusion, tier/TTL-aware pricing and broader restart/reconnect coverage.
  Last provider request, current context, cumulative usage and estimated pricing remain separate.

Entry points: `AutomationWorkspace.tsx`, `AutomationEnvironmentEditor.tsx`,
`AutomationRunInspector.tsx`, `AutomationPublication.tsx`, `McpConnectionEditor.tsx`,
`McpContentBrowser.tsx`, `McpComposerPicker.tsx`, `SessionMcpTasks.tsx`, `SessionProcesses.tsx`
and `SessionUsage.tsx`.

### P3: application and release completion

- Complete keyboard ownership/focus restoration, all Escape/outside-click paths, screen-reader
  behavior, high contrast, long localized labels and consistent light/dark/theme rendering.
- Exercise actual multiple windows and multiple simultaneous projects/sessions under queue,
  refinement, model-switch, approval, draft and reconnect load. IPC-injected peer writes and
  two controller/SQLite connections do not replace concurrent WebView stress.
- Finish window geometry, migration, older-host compatibility and preview profile isolation/
  DevTools gates. Keep existing live sessions on their original host during updates.
- Measure startup/RAM, large graphs/trees/catalogs, transcript/terminal scrollback and package size.
  The three-terminal proof is not the 3 × 10k lines/s/no-dropped-frames benchmark.
- Complete installer/update migration, signed installer/update artifacts, platform acceptance and
  the full repository release/coverage matrix, then hosted CI and actual asset verification.
- Do not publish, replace the installed app or retire Electron just because focused local tests
  pass. Such delivery actions need their own authorization and proof.

## Commands and tool discipline

The repository pins Bun `1.4.3` in `.bun-version`. Use the actual repository manifests and refresh
registries before proposing/installing dependency changes. Do not switch package managers.

PowerShell may block `bun.ps1`; use `C:\Users\ersin\.bun\bin\bun.exe`. Do not use `bun test`:
the repository uses Vitest through `bun run test`.

### Package checks

Run each command from the stated directory. Do not prepend repository paths again when already
inside a package directory.

```powershell
# From apps/desktop-v2
& C:/Users/ersin/.bun/bin/bun.exe run test
& C:/Users/ersin/.bun/bin/bun.exe run typecheck
& C:/Users/ersin/.bun/bin/bun.exe run test:native

# From packages/webui-server: related profile checks
& C:/Users/ersin/.bun/bin/bun.exe --bun run vitest run --config vitest.config.ts tests/profile-identity.test.ts tests/prefs-handlers.test.ts tests/prefs-per-session-echo.test.ts tests/routes-composition-coverage.test.ts tests/pref-helpers.test.ts tests/config-pref-updates.test.ts tests/provider-read-correlation.test.ts

# From packages/webui-server: isolated open timeout case
$env:WRONGSTACK_VITEST_MAX_WORKERS='1'
& C:/Users/ersin/.bun/bin/bun.exe --bun run vitest run --config vitest.config.ts tests/project-history-search.test.ts

# From packages/webui-server: full package verification, serialized against native UI/builds
$env:WRONGSTACK_VITEST_MAX_WORKERS='2'
& C:/Users/ersin/.bun/bin/bun.exe run test
```

The root `bun run test` is substantially broader and may run shared build/teardown machinery.
Use it deliberately. Never describe focused package checks as full repository certification.
Format/check explicit changed paths with Biome, not a broad root `format --write`.

### Engine, Tauri and portable identity

Serialize engine build, Tauri build and native acceptance. When shared dependencies change, rebuild
them before package tests that resolve compiled outputs; a stale Core build previously made the
new schema test appear broken until the dependency build was refreshed.

```powershell
$desktopRepo='D:\Codebox\PROJECTS\WrongStack'
$desktopApp=Join-Path $desktopRepo 'apps\desktop-v2'
$desktopBun='C:\Users\ersin\.bun\bin\bun.exe'
$env:PATH='C:\Users\ersin\.bun\bin;'+$env:PATH
Set-Location $desktopApp
& $desktopBun run build:engine
if ($LASTEXITCODE -ne 0) { throw 'Desktop engine build failed' }
$env:WRONGSTACK_DESKTOP_ENGINE_ID=(Get-FileHash binaries/wrongstack-engine.exe -Algorithm SHA256).Hash.ToLowerInvariant()
$env:WRONGSTACK_DESKTOP_BUN=$desktopBun
$env:WRONGSTACK_DESKTOP_ENTRY=Join-Path $desktopApp 'engine\main.ts'
$env:WRONGSTACK_DESKTOP_REPO=$desktopRepo
& $desktopBun --bun run tauri build --no-bundle
if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed' }
& $desktopBun scripts/portable.ts
```

The portable script stages and hashes both executables and updates its pointer. An existing
`dist-native/latest.json` may otherwise refer to an older build. Use an explicit verified folder
for acceptance. Building source does not replace an installed application.

```powershell
# From repository root, using the current recorded profile-aware bundle
$env:WRONGSTACK_DESKTOP_TEST_PORTABLE='D:\Codebox\PROJECTS\WrongStack\apps\desktop-v2\dist-native\2f5045c5270f-8d5e009090b5'
& C:/Users/ersin/.bun/bin/bun.exe apps/desktop-v2/tests/native-smoke.mjs --release --bundled --model-profiles
& C:/Users/ersin/.bun/bin/bun.exe apps/desktop-v2/tests/native-smoke.mjs --release --bundled --models
& C:/Users/ersin/.bun/bin/bun.exe apps/desktop-v2/tests/native-smoke.mjs --release --bundled --model-draft-restart
```

Other native scopes are discoverable in `native-smoke.mjs`; useful existing flags include
`--composer`, `--history`, `--recovery`, `--files`, `--sage`, `--atlas`, `--brain-policy`,
`--fleet-policy`, `--execution-policy`, `--refinement-policy`, `--roster`, `--fleet`, `--automation`,
`--mcp`, `--mcp-tasks`, `--processes`, `--goals`, `--sdd`, `--design`, `--deadcode`, `--techstack`,
`--kit` and `--mailbox`. Use only flags actually supported by the current harness.

### Native harness details that save time

- `workspaceRpc` routes project/profile calls through Tauri. Draft get/save APIs are local trusted
  `host_request` IPC; they are not exposed by the authenticated session-host test RPC socket.
  Follow existing `page.evaluate(...window.__TAURI_INTERNALS__.invoke...)` draft tests.
- After a cold host restart, reset profile event offsets. Event streams belong to the new runtime.
- Reacquire the page and locators after a real UI restart. A closed page in fixture teardown must
  not hide the original assertion failure.
- Windows may report `exitCode=null` and `signalCode=SIGTERM` for a terminated UI. Check the actual
  exit/signal and new process identity; do not infer that the old UI is still running.
- Native draft resolution is asynchronous. Wait for acknowledged form replacement before asserting
  its values. Error strings may include `Error:`; target the alert and semantic message.
- Do not raise shared budgets/timeouts, clamp user settings or loosen assertions to force green.
  Independent checks can run together; shared builds, native UI lifecycles and load-sensitive full
  suites should be serialized when their evidence would otherwise be ambiguous.

## Definition of a completed increment

For each next feature, identify its owner, inspect the canonical engine contract, implement a
readable desktop workflow and exercise the real operation. Add useful main/error/race coverage,
run the relevant checks, inspect native screenshots at appropriate widths/themes and record the
exact portable identity. Update the parity inventory and dated validation evidence.

Report implementation, focused tests, native interaction, full local certification, hosted CI and
publication as separate outcomes. Remaining limits belong in the report. A rendered control, a
successful config save or a plausible graph is not proof of worker execution or complete parity.
