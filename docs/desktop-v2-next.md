# Desktop v2: continuation and remaining delivery work

Updated: 2026-11-05. This is the handoff for the next implementation agent.

## 1.5.0 status (2026-11-05)

Desktop v2 is code-complete against the WebUI, TUI and CLI comparison in
[`desktop-v2-vs-webui.md`](desktop-v2-vs-webui.md):

- The project surfaces the WebUI also shows (SAGE memory, Kanban, Code Atlas, agent office,
  Brain council cards, Session Story, context and analytics dashboards, engine diagnostics, plan
  quota and model tests, first-run setup, collaboration bar) render from
  `@wrongstack/project-surfaces`; desktop-only tools ride host slots on Kanban and the Code Atlas.
- Every desktop screen reads the `desktop` catalog in the seven WebUI languages.
- The engine command bridge (`command.list` / `command.run`) runs the TUI's slash commands in the
  composer. Only `/coordinator` and `/shadow` stay TUI-only by design.
- The serious WCAG 2.2 AA findings of the native axe pass are fixed, and performance is recorded
  on the release build.

What remains: one batched native acceptance run for the 2026-11-05 additions (fonts and text
size, Monaco's editable diff, the analytics page, engine commands in the composer), plus the owner
items below, which are unchanged.

## 1.4.0 release status (2026-11-03)

Desktop v2 is feature-complete for its first release. The release build with the bundled engine
ran the full native matrix, the default suite and all 35 scope flags: 33 of 36 passed first, the
three failures led to the fixes recorded in the validation log ("Release-build native matrix
(2026-11-01/02)"), and the full matrix on the final build passed 35 of 36. The one failure is an
intermittent close of the refinement review after "Refine again", recorded there and not yet
explained. The intermittent `files.tree` timeouts are explained and fixed (replies behind a
journal replay), and views of one project now share one journal reader. The full matrix on the
build with that reader passed 36 of 36 (2026-11-02), under unrelated heavy load. The backlog
below is depth work for later releases, not a release blocker.

The Desktop v2 source shipped in WrongStack 1.4.0 (tag `v1.4.0` on `c3e7f9efe`, GitHub Release
2026-11-02 with the eight `wstack` binaries, both installers and `SHA256SUMS`). `release:check`
passed 18 of 19 gates on that commit; coverage failed a different set of four to seven
timing-sensitive tests in each of three runs on a saturated machine (CPU 83 to 99 %), and every
failing test passed three times in isolation. CI's release gate passed on Linux.

What remains, and needs the owner:

- The desktop app is not a release asset yet: it is built locally (`bun run desktop:v2:build`,
  portable under `apps/desktop-v2/dist-native/`). Signed installer and update artifacts and a
  release job that builds them are still to come.
- Manual passes the harness cannot do: a real microphone for dictation, a screen reader, and
  long localized labels.

Known limits shipped with the release:

- Terminal output is bounded by ConPTY and PowerShell console writes (about 14k lines/s across
  three terminals), not by the desktop.
- Each open project runs six Bun project daemons, about 70–100 MB working set each.
- Drawing 20,000 graph nodes in the code atlas's all-nodes mode creates that many DOM elements.

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

1. All product screens and interactions belong inside the Tauri application. Do not open, embed
   or iframe the WebUI frontend. Sharing engine services and protocol contracts is allowed.
   **Owner override (2026-11-03):** the project surfaces the owner rates as the quality bar move
   into `@wrongstack/project-surfaces` and both apps render the same components, each through its
   own `SurfaceHost`: SAGE memory (done), then Kanban, Codebase Atlas and Office topology. The
   desktop must not import WebUI modules outside that package (its CSS imports of the WebUI
   workbench class files and locale catalogs are the exception that serves these surfaces).
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

### Engine actions brought into the desktop (2026-11-01)

- File editor (`editor-language.ts`, the one keystroke entry point for the code editor): block
  comments for CSS/HTML/XML/Markdown on Ctrl+/, Python/YAML colon blocks and Python exit
  dedent on Enter, `/** */` continuation, Ctrl+Shift+K deletes lines, Ctrl+] / Ctrl+[ indent
  and outdent, Home goes to the first non-blank character.
- Plan templates: new `plan.templates` lists the engine's plan skeletons; Session tools → Plan
  templates previews one and adds it with `plan.template_use`.
- Kanban: a card can be merged with other cards on its board (`kanban.task.merge`), and the board
  menu opens a contract map (`kanban.contract.*`: board enforcement, contracts per card with
  state and waiver, relations, and a per-card start check). A card's inspector also edits its
  goal metrics (`kanban.task.metric.add` / `.update`) and builds or shows its chain
  (`kanban.task.chain` / `.chain.get`, optionally making each card wait for the previous one).
  The board menu exports the board as a task graph JSON file (`kanban.taskgraph.export`,
  read-only).
- The file menu has "Show in file manager" (`shell.open`). The engine now opens a file's folder
  instead of handing the file to the file manager, which opened it in its default app, and
  `shell.open` replies carry the asking `requestId`.
- Project session history has "Recorded side effects": `sessions.list` with
  `sideEffectsSummary` reads the `side_effect` events of the newest 200 conversations (at most
  1,000), with counts per risk and tool, an optional risk filter, the newest 200 records and a
  link to each conversation.
- SAGE Memory has "Injection history": new `memory.sage.audit` reads the store's audit window
  (newest 1,000 events, optionally one event type); the desktop lists every `memory.injected`
  event with trigger, conversation and memories, and the most injected memories.
- PDF preview: the window CSP now allows frames from `blob:` only (`frame-src blob:`, user
  decision 2026-11-01; `object-src` stays `'none'`). `PdfFrame.tsx` shows bytes with the PDF
  signature in the window's PDF viewer from a blob URL typed `application/pdf`. PDF attachments
  in messages and MCP PDF content preview in place; saving stays. The native attachment
  scenario checks the preview frame.
- Fallback settings suggest ready-made chains from reachable models (`fallback.suggest`,
  heuristic or re-ranked by the current model) and use one as the default chain or a profile.

Native proof: `tests/native-new-surfaces.mjs` (`--surfaces` scope) passed: plan templates,
card metric and chain, contract map with a per-card check, card merge, the project side-effect
summary, SAGE injection history and fallback suggestions (the fixture profile has one model, so
the engine reports that no chain can be built). It found that worklist replies (`plan.*`,
`tasks.*`, `todos.*`) carried no `requestId`, so desktop status and template commands timed out;
`worklist-routes.ts` now correlates them. `--composer` passed with the PDF preview, whose frame
document loads as `application/pdf`, and `--history` passed (its >1,000-record search step timed
out once under load and passed on the rerun). Not exercised natively: editor keys, task graph
export and "Show in file manager" (unit-tested; the last two hand off to the OS).

Dictation (2026-11-01): `src-tauri/src/speech.rs` uses Windows continuous dictation
(`Windows.Media.SpeechRecognition`, the `windows` 0.62.2 crate already in the graph through
WebView2, with the speech features). Commands `speech_status`, `speech_start` (events through a
channel: `listening`, `hypothesis`, `result`, `ended`, `error`) and `speech_stop`; one session at
a time, each on its own MTA thread that owns the recognizer. The composer's microphone
(`DictationButton.tsx`, beside attach) appears only where the platform can dictate, is disabled
with the reason when Windows has online speech recognition turned off, shows the live guess
while listening, and appends recognized phrases to the draft without replacing it. Native:
`--surfaces` checks the button against `speech_status` (available here, English (United
States)); the test does not open the microphone, so recognition itself needs a manual pass.

Interrupted refinement (2026-11-01): a refinement request is saved as pending before it is sent
(`RefinementDraft.result` null, `pending: true`), so after a restart the composer says it was
interrupted and offers "Refine again" or "Discard". A pending request never replaces a completed
review saved earlier (`useRefinementDraft.save` returns false and the composer does not take
ownership). Native proof in `native-composer.mjs`: the fixture holds a refinement marked
`[native-refine-slow]`, the window reloads while it waits, and the request runs again.

`bun run dev:web` currently fails in this checkout: `scripts/sync-brand.ts` regenerates
`brand-tokens.css` from another session's unfinished `packages/webui/src/index.css`, which does
not parse. The native runs used `bun --bun run vite --host 127.0.0.1` in `apps/desktop-v2`.

### Recorded usage across the profile (2026-11-01)

The recorded-usage disclosure in project session history can count this project or every
project in the profile. The profile scope sends `projects.list` with `usageSummary: true`; the
engine reads each project in the profile's `projects.json` from its own session catalog
(`usage-summary.ts`, up to 5,000 conversations per project) and returns one total, a per-model
table merged across projects and a per-project table. A project without history counts zero and
nothing is created for it; a project whose history cannot be read is listed with its error and
adds nothing. `projects.list` replies now carry the asking `requestId`. Tokens only, as before:
no price is derived. Native `--history` passed with the new step.

### UI tour at two window widths (2026-11-01)

Every top-level screen, all 21 settings sections and all 17 project tools were opened in the
debug Tauri shell at 1440x900 and 900x720, with no horizontal overflow at either width. The tour
was a throwaway script, not a harness scope. Findings fixed in `188f8f131`:

- At 1000px and narrower, the settings section list is replaced by one grouped picker
  (`SettingsSectionSelect.tsx`). Before, the list filled the screen above the section it opened.
- The wide settings list has no per-item chevrons, has tighter rows, and the blank band above it
  is gone.
- The sidebar search stays on one line.
- The file explorer no longer shows "This folder is empty" while the tree is still loading.
- Session, project and model counts use the singular for one.

Left as they are:

- The project navigation appears in the sidebar once a session is selected. This moves the tree
  under a stationary pointer, so the hover can look like a selected item.
- The Changes footer note can run past its pane at 1440px.

Debug-mode orphans: the debug engine is `bun …/engine/main.ts`, and its command line does not
contain the test data directory. Owned-process cleanup that matches only on the command line
therefore misses the engine. The engine then keeps per-project daemons for temporary
`wrongstack-desktop-v2-*` directories alive. To find leftovers, look for bun processes whose
children name such a directory. `native-smoke.mjs` itself does not leak this way: it ends the
host's process tree through `endpoint.pid`. Three `--mcp` runs left no such process. The tour
script, which stopped only the Tauri process, did leak.

### Running an MCP tool in a conversation (2026-11-01)

The composer's "MCP resources & prompts" dialog has a Tools button per connection. It lists the
server's tools through `mcp.tools` (`MCPRegistry.describeTools`: honors `allowedTools`, starts
nothing). The dialog builds a JSON input from the schema's required fields and sends
`mcp.tool.call` with the conversation's session id.

The engine (`packages/webui-server/src/server/mcp-tool-handlers.ts`, wired for the standalone
engine and the CLI-hosted WebUI) runs the call through the conversation agent's own gate,
`ctx.nestedToolCall`. That gate applies validation, hooks, permission policy, the approval card
and the session journal; there is no direct path to the server.

- It refuses while a turn runs, for a tool the conversation cannot reach, and for input that is
  not an object.
- It refreshes the conversation's tool surface first, because the surface is otherwise only
  refreshed when a turn starts.
- In token-saving mode it calls through `mcp_use`.
- The result is added to the conversation as an untrusted, user-side note. The model sees it on
  the next turn and a resumed session keeps it.
- The reply carries the note, so the desktop shows it in the transcript at once. The dialog
  closes before the call starts, so it never covers an approval; the outcome appears as a
  composer notice.

The WebUI has the same calls as `/mcp tools <server>` and `/mcp call <server> <tool> [JSON]`.

Native proof is `tests/native-mcp-tool.mjs` (`--mcp` scope). It checks:

- the input check;
- the approval card: the `--mcp` harness profile runs without YOLO, the call waits at the card
  with no server call, and runs on Allow once (2026-11-01);
- one `tools/call` reaching the fixture server;
- the note in the transcript;
- the next provider request carrying it.

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
| Files: `FileWorkspace.tsx`, `file-draft.ts`, `FileContentSearch.tsx` | Language-aware editor depth beyond indentation, line comments, bracket/quote pairing and line moves (pairing, Backspace over an empty pair, Alt+Up/Down and Shift+Alt+Down exist, 2026-10-31) (bulk move, rename and delete apply all or nothing through `files.batch`, 2026-10-29; bulk copy through `files.copy_many`, 2026-10-30). The directory tree is virtualized and the folder listing pages 200 entries at a time (2026-10-29 validation entry). Saves are now version-bound (`files.write` `expectedSha256`, see the 2026-10-29 validation entry); OS-level exclusion against external writers is not provided. Keep current 2 MiB draft and bounded search/recovery limits visible. | Real external modification and simultaneous-save cases, large trees/files, symlink boundaries, preserved unsaved text and no silent overwrite. |
| Git/review: `GitHunkReview.tsx`, `MergeConflictReview.tsx`, `review-notes-store.ts` | Unsupported partial binary/mode changes (line-level staging, including added, deleted and untracked text files, and rename origins exist, 2026-10-30), larger/symlink/submodule conflicts, worktree timelines and native worktree acceptance (a Worktrees page for managed run worktrees exists, 2026-10-30; history lanes and review discussions with reply editing and resolution exist, 2026-10-29). | Real repository/index operations with stale-index refusal, binary/rename/mode cases and precise file-layer ownership. Worktree features must not cause this agent to create a workspace worktree against the user's instruction. |
| Session history: `ProjectSessionHistory.tsx`, `ProjectHistorySearch.tsx`, `SessionTranscript.tsx` | Compressed and large retained histories, document viewers (retained images, complete tool inputs and blocks past the first 100 load on request, 2026-10-29), atomic rename policy, older-host migration and richer story/navigation. File-store full scans remain explicitly budgeted at 10,000 records. | Real compressed/long journals, exact-ID navigation, full-catalog search consistency, stale revisions, bounded memory and cancellation. |
| Session recovery: `SessionRecovery.tsx`, `session-recovery-model.ts` | Richer recovery administration (redo of the last rewind exists, 2026-10-29; a rewind hands its prompt back for editing and resending, and the newest prompt can be retried in one step, 2026-10-30; rewinds, retries and redos started from the desktop keep durable per-session records, 2026-10-30), recovery operations started outside the desktop and broader partial-error/restart handling. | Real files and journal state after each operation; active-run refusal, preserved conversation/drafts, stale-operation refusal and visible partial failures. |
| Model/profile settings: `ModelCatalogSettings.tsx`, `ProviderOAuth.tsx`, `ProviderHealth.tsx` | Profile rename/move migration, future draft versions, atomic custom-model writes, live OAuth/account refresh, full vault lifecycle and broader external-provider quota/test cases. | Actual profile/account behavior where authorized, exact config/draft ownership, safe failed writes and restart coverage. Metadata-only OAuth fixture tests do not establish external authentication. |
| Runtime policies: Brain/Fleet/Execution/Refinement/Review settings | Cross-runtime policy refresh, advanced fleet lifecycle/dispatch/probe policies, council execution/quality (the Brain decision log and direct questions exist, 2026-10-30), Shadow, advanced security-rule/display policy editing, and session-specific effective routing. | Actual worker/council decisions and effective settings in the owning runtime. Saving configured policy does not prove dispatch or model behavior. |
| Durable secondary forms | Mailbox compose and automation job drafts are restart-durable (2026-10-29 validation entries). Unapplied environment dialog edits are also kept per job (2026-10-29). | Native ownership, bounded versioned envelopes, load/ack/error states, stale-window comparison, explicit discard and cleanup only after successful domain writes. Reuse `DurableFormDraft` (`durable-form-draft.ts`, first used by Project Kit parameters) without putting project forms into profile/session storage. |

### P1 engine follow-up: model fallback outside the standalone engine

- The standalone engine (what the desktop runs) now gives every conversation agent its own
  fallback-model extension, and the desktop answers its gate (2026-10-30, validation entry
  "Model fallback in the desktop engine"). Since then:
  - per-tab agents of the CLI-hosted WebUI get their own fallback extension (2026-10-31,
    `2a289e482`);
  - a tab's model switch or fallback hop now resolves that tab's own context window, in the
    standalone engine and the CLI-hosted WebUI (2026-10-31, `15217f0b1`);
  - a real failing provider through the engine's gate passed (2026-10-31); the picker clicked
    in the native window remains for the native batch.

### Engine messages the desktop still does not send (audit 2026-10-30)

A strict scan of the client protocol (exact literal or template prefix in `apps/desktop-v2/src`)
leaves these user-facing engine operations unused. Session/project lifecycle, terminals and
transport messages (`session.new/resume/save/delete`, `projects.*`, `terminal.*`, `ping`,
`*.subscribe`) are covered by the desktop's native paths and are not gaps.

Landed 2026-10-30: `autonomy.switch` with the next-steps auto-continue, `mode.switch` /
`modes.list`, `connections.service_action`, `provider.update` / `provider.clear_models` /
`provider.undo_clear`, `browser.live.*` and `browser.policy` (see the validation log).
`key.update` is the same upsert as `key.add`; `chronicle.facet` is covered by
`chronicle.facets`.

Both earlier exclusions have since landed: `collab.*` through the shared collaboration panel
(fd998fc6b) and `completion.request` in the desktop's Monaco file editor (1f9f56e83,
d72d698a2). `goal.selectPhase` stays unsent: the WebUI exposes it from a hook that no
component calls.

### P1: finish conversation parity while preserving simplicity

Use the [chat action inventory](desktop-v2-chat-parity.md) for exact existing behavior.

- Complete tool-specific and chronological activity presentation, binary/document viewers,
  complete media handling and large-transcript virtualization.
- Model selection has catalog facts, comparison across providers and recent-model quick
  switching (2026-10-29).
- Session reasoning mode/preserve controls follow the catalog's documented policy (2026-10-30);
  Z.AI GLM-5.3's effort levels and a leader's own override and reset reach the real wire
  (2026-10-31); prove other providers' vocabularies against real models. The engine now has
  the CLI leader's management tools (2026-10-31), and `leader_tier_set` there judges each
  conversation on its own context size, dwell window and catalog prices (2026-10-31,
  `963137eb2`). Do not manufacture
  support when the provider reports unknown.
- Finish active worker assignment/topology and actual execution of session-owned model plans.
  Plan drafts are durable per session and saves are refused when the plan changed since it
  was read (2026-10-29).
- Add richer skill/resource invocation progress and reference-aware durable recall. File,
  line-range and quoted-snippet references, the code-paste hint/undo and the prompt journal
  month filter, export and older-page loading exist (2026-10-29).
- Dictation exists on Windows (2026-11-01, see "Dictation" above). Still open: a manual pass
  with a real microphone (the harness never opens it) and a recognizer on other platforms.
- BTW notes show read/handled receipts that survive restarts per project session (2026-10-29);
  add richer queue presentation and longer restart coverage. Presentation sorting must not change engine FIFO order.
- Steer over a nonempty queue places the instruction first in the engine queue and keeps the
  waiting prompts behind it (2026-10-29); never silently clear or bypass queued work.
- Refinement keeps completed reviews across restart and offers a word-level comparison with
  the original (2026-10-29); it still needs richer provenance, external-model quality and reconnect/cancellation/empty/timeout cases. Countdown or automatic submit is a new
  deliberate UX; current refinement must not acquire hidden auto-send.
- Whole-message context editing is validated and applied through the engine (2026-10-29); text cuts
  inside a message, a draft token estimate, context mode authoring and compaction feedback
  (request tokens, reductions, quality check, digest) exist (2026-10-30). Residency/retention in the context panel are committed (`1b0902159`, 2026-10-29).
- Extend selective merging to the remaining durable forms (file, mailbox and roster document drafts merge change by change, 2026-10-29); send-time races, abrupt termination during pending saves and the
  full focus/keyboard/screen-reader matrix. Existing tests protect acknowledged snapshots, not
  every unacknowledged last keystroke.

Entry points include `SessionComposer.tsx`, `SessionWorkbench.tsx`, `SessionModelControls.tsx`,
`SessionAgentPlan.tsx`, `PromptRefinement.tsx`, `SessionContextPanel.tsx`, `PromptWorkspace.tsx`,
`PromptJournal.tsx` and their dedicated model/store helpers.

### P2: project intelligence and visual workspaces

| Area / entry points | Remaining work |
| --- | --- |
| SAGE: `ProjectMemory.tsx`, `SageRecordDetails.tsx`, `SageValidityReview.tsx` | Project-wide injection trace history (each conversation's context inspector lists the SAGE memories its latest request carried and every injector run with what it injected and rejected, 2026-10-30); recovery/backfill administration; large-graph exploration; broader applicability/lifecycle concurrency; native coverage of every repair/retirement proposal. Preserve direct counts and real graph relationships independently of vectors. |
| Vector memory | Provider configuration and actual enabled-store native acceptance (adding and removing entries, embedding coverage and reindexing exist, 2026-10-30). Keep its UI and lifecycle separate from SAGE. |
| Atlas: `CodeAtlas.tsx`, `AtlasViews.tsx`, `AtlasBoundaryMap.tsx` | Richer persona tours (communities inferred from stored references exist, 2026-10-29), cross-scope paths, AI flow traces, live actor overlays and large-index performance. Do not replace indexed relationships with fabricated visual links. |
| Chronicle: `ProjectChronicle.tsx` and Chronicle views | Richer cross-domain navigation (an event's session opens in conversation history, 2026-10-31) and long-history performance (timeline/lineage export and prompt-manifest inspection exist, 2026-10-29). Keep confidence-labelled lineage distinct from asserted delegation. |
| Code Assist | Changes made through shell/patch/replace (every `write`/`edit` target is captured, compared and restorable per file, 2026-10-29), cancellation/error coverage and real-model output quality. Edit opt-in and request-owned streaming must remain. |
| TechStack: `ProjectTechStack.tsx`, `TechStackRemediation.tsx` | Real registry/model research, permission-governed package execution, disk-export acceptance, cross-window job discovery, larger inventories and historical comparisons. Current reviewed-target checks do not prove external execution. |
| Project Kit: `ProjectKit.tsx`, `KitParameterForm.tsx` | Richer run diagnostics/source snapshots, real agent verification/run evidence and large-catalog usability. |
| Design Studio: `ProjectDesignStudio.tsx` | Broader supported-stack outputs and quality/scale proof (kit pinning, swapping and override writes are checked under the `active.json` lock, 2026-10-29). |
| Dead code: `ProjectDeadCode.tsx`, `DeadCodePlan.tsx` | Long verification/rollback and restart recovery (findings open at their marked line range and apply is bound to the reviewed preview revision, 2026-10-29). The shared scan API is synchronous and has no invented cancel endpoint. |
| Chimera: `ProjectChimera.tsx`, `ChimeraFinding.tsx` | Full host-restart and actual two-WebView stress, concurrent lifecycle cases, advanced plugin policies, pagination and large-history usability. |

### P2: execution, planning and collaboration

| Area / entry points | Remaining work and proof boundary |
| --- | --- |
| Kanban: `ProjectKanban.tsx`, `KanbanTaskInspector.tsx`, `KanbanExecution.tsx`, `KanbanBreakdown.tsx` | Goal/SDD run controls and steering from the board (the standalone engine now mirrors Goal and SDD runs into boards that link back to their goal, and a goal opens its board, 2026-10-30; each board shows its queue health and offers a confirmed audit, 2026-10-30; a board can be launched as a Goal or SDD run from its menu, 2026-10-31, `c81d1c8c9` / `635f05e1b`); supported tier-aware assignments (boards can be duplicated, deleted after typing their title and inspected in the project board history, and cards copied or moved to another board, 2026-10-30); model-generated decomposition/atomic assessment (boards can be created from a pasted task list, 2026-10-30) (task and board resource boundaries are editable, 2026-10-29); same-field conflicts are reviewed and task edits are version-checked atomically (2026-10-29). Preserve the visible board list, detailed inspector and canonical five fixed lifecycle columns. |
| Goals/missions: `ProjectGoals.tsx`, `ProjectMission.tsx` | Richer task detail (each phase shows its recorded verification attempts with the checker's output and its integration state, 2026-10-30) and broader actual start/control/retry/assign coverage (task, run-time and provider-token budgets stop a run cleanly and mission writes are conditional on the reviewed mission, 2026-10-30). Cost budgets are priced from the model catalog: each task response at the context price tier for its request size (2026-10-31) and its cache writes by the 5-minute / 1-hour lifetime the provider reported (2026-11-01). |
| SDD: `ProjectSdd.tsx`, `SddTaskDetails.tsx`, `SddLifecycle.tsx` | Full intake/spec authoring, live graph/board linkage, historical run detail (a run's worker model can be chosen from the profile's providers and their catalog models, 2026-10-31), real split/rollback and broader provider/run coverage. |
| Requirements: `ProjectRequirements.tsx`, `RequirementResources.tsx` | Configured suggestion generation, richer assessment and larger catalogs. Existing metadata/answer/new-form durability should not be rebuilt. |
| Roster/fleet: `ProjectAgentRoster.tsx`, `ProjectMailbox.tsx`, roster/runtime editors | Desktop surfaces for worker routing and per-worker controls (the engine now runs `delegate` workers and wakes the leader with their results, 2026-10-31; knowledge checklists are editable, 2026-10-29), delegation ancestry/office topology, agent-level controls/council, large catalogs/fleets, restart-durable drafts and atomic cross-window controls. Membership maps and role inheritance do not establish delegation. |
| Mailbox/collaboration: `MailboxComposer.tsx`, `ProjectMailbox.tsx` | Restart-safe compose with multi-window conflict handling (older messages load past the recent window, 2026-10-29), richer delivery receipts and system notifications (an unread badge with the newest unread message on the project overview exists, 2026-10-30), retention, annotations/control and broader lifecycle stress. Delivery acknowledgement is not proof that a worker read or executed the message. |
| Session audit: `SessionSideEffects.tsx` | Project-wide aggregation (runtime-window paging and paging of the durable session-journal copy exist, 2026-10-29), live outcome changes, more operation-kind native cases and long-history evidence. |
| Skills: `SkillLibrary.tsx` | Native Git install/update/uninstall/export proof, richer document/dependency metadata, invocation progress. `skills.edit` re-checks the read text right before writing (2026-10-29). |

### P2: automation, MCP and supporting runtime tools

- Automations already have structured management/environment/evidence/publication interfaces.
  Real runs on 2026-10-31 passed: a Docker run with a profile credential through independent
  checks, PR prepare, publish and check to a private repository; CI repair loops that updated the
  same draft PR, ending green against real GitHub Actions jobs; the desktop's publication
  requests over the engine; a run with a healthy service, cache volume and loopback preview port;
  and a worker killed mid-run, recovered as interrupted with its credentialed workspace,
  services and network removed. Still open: cache retention/pruning administration, native
  click-through of `AutomationPublication.tsx`, signed GitHub delivery (two-run comparison from
  recorded results exists, 2026-10-29), event
  sample authoring and durable secondary forms. Successful management requests do not establish
  successful external runs. Jobs can be deleted at their reviewed revision (2026-10-29).
- MCP still needs advanced policy administration and native OAuth acceptance against a real
  authorization server (per-key secret environment and header editing and OAuth sign-in/out
  exist, 2026-10-30), broader
  task lifecycle stress and deep catalogs (raster, audio and PDF previews and binary save exist, 2026-10-29 / 2026-11-01).
  Preserve session task identity/isolation/cancellation and question routing.
  A user can now run a connection's tool as a conversation step (2026-11-01, see "Running an
  MCP tool in a conversation" above), including the native approval card.
- Session processes need stress proof (engine-reported exits, batch termination and
  a recently-ended list exist, 2026-10-29; printed local URLs open as previews). Browser
  selection, preview controls, watcher and batch-process integration remain incomplete.
- Usage needs persisted historical model/billing attribution (recorded tokens by model per project and across the profile exist, 2026-10-29 / 2026-11-01),
  auxiliary-worker inclusion (the usage page lists finished worker delegations with the engine's cost estimates, 2026-10-31; worker tokens are not in the conversation counters, and no project-level total adds them yet), context-tier pricing of aggregate usage (cache writes are priced by their reported lifetime, 2026-11-01; a sum of requests cannot select a context tier) and broader restart/reconnect coverage.
  Last provider request, current context, cumulative usage and estimated pricing remain separate.

Entry points: `AutomationWorkspace.tsx`, `AutomationEnvironmentEditor.tsx`,
`AutomationRunInspector.tsx`, `AutomationPublication.tsx`, `McpConnectionEditor.tsx`,
`McpContentBrowser.tsx`, `McpComposerPicker.tsx`, `SessionMcpTasks.tsx`, `SessionProcesses.tsx`
and `SessionUsage.tsx`.

### P3: application and release completion

- Screen-reader behavior, long localized labels and consistent light/dark/theme rendering.
  Dialogs (Escape, backdrop click, focus return), the file context menu and the composer
  options popover own the keyboard, and a high contrast mode exists (2026-10-29). The full
  native-smoke matrix ran on the release build on 2026-11-01/02 (see "Release status"), but it
  does not exercise screen readers or long localized labels; those still need a manual pass.
- Concurrent WebView stress exists for queue, draft and reconnect load (2026-11-01,
  `tests/native-multi-window.mjs`, `--multi`): two project windows each hold a turn at the
  provider at the same time with two prompts queued behind it and their own unsent draft; one
  window reloads mid-turn and keeps its queue and draft; both queues then drain in order into
  their own conversations and neither transcript shows the other project's prompts. A model
  switch in one project during the held turns reaches only that project's queued turns; both
  windows then ask for approval at once and each answers only its own card (one allowed, one
  denied); and a slow refinement in one window finishes while the other runs its own turn.
- Window placement is remembered per main/project window (2026-10-29). Previews use a private profile
  and open developer tools only on request (2026-10-29). Finish migration and older-host
  compatibility. Keep existing live sessions on their original host during updates.
- Measurements exist (2026-11-01, `tests/native-performance.mjs`, `--perf`; numbers in
  `.temp_files/desktop-v2-native/performance/native-performance.json`). Debug build with the Vite
  dev server, one machine:
  - Startup: first window to engine connected 1.8 s, profile runtime ready 3.9 s later; reopening
    the window against the running host 1.0 s.
  - Turns: a new conversation reaches the provider in 0.24 s, a later turn in 0.14 s. Before the fix
    below, a first turn in a project with 20,000 untracked files waited 46.5 s, and one in a small
    project waited 1.0 s.
  - A 3,000-line (187k character) answer is on screen 1.1 s after send. The longest frame is
    400 ms (re-rendering the whole message's Markdown). Scrolling it never drops a frame
    (longest 23 ms).
  - File tree with 20,000 files: refresh 7.1 s, expanding a 1,000-file folder 0.18 s, 38 rows mounted.
  - Three terminals each printing 30,000 lines at once (about 925 KB each, the text built before
    the clock starts) finish in 6.4 s, 14k lines/s combined; the visible terminal never drops a
    frame (longest 34 ms). Before the fix below it took 15 s (6k lines/s). This is still not the
    3 × 10k lines/s benchmark: with the transcript journal switched off as an experiment it is
    the same 6 s, so the rest is ConPTY and PowerShell's console writes, not the host.
  - Fixed by the measurement: the host journaled each terminal output chunk by serializing JSON
    straight into an unbuffered file, one write call per byte's token (about 70 KB/s per
    terminal). It now serializes the chunk and writes it once (`src-tauri/src/transcript.rs`).
  - Memory at idle with two projects: 1.9 GB working set and 4.8 GB private (commit). The UI process
    uses 34 MB and WebView2 436 MB / 6 processes. The rest is the host's 12 Bun processes (two
    engines, eight `project-server.js`, two mailbox servers; 4.5 GB private). After the
    workloads it is 3.2 GB working set. Each project daemon alone holds 70–100 MB working set at
    idle, of which about 57 MB is the bare Bun process. Its 190–370 MB private commit is Bun runtime
    commit, not JS heap (5–8 MB); `--smol` and mimalloc options do not lower it. Only fewer
    processes would. Merging a project's six daemons into one process was considered and not
    taken (decision 2026-11-01): it rebuilds election, idle shutdown and auth across six packages
    and the CLI/TUI.
  - Package: portable native executable 13 MB, bundled engine 139 MB, frontend assets 2.7 MB.
  - Model picker: opens in 46 ms and lists the profile catalog in 0.7 s. The largest catalog
    offered (OpenRouter, 377 models, of 236 providers) lists in 0.6 s and filters in 20 ms. A
    custom provider shows only its configured models, so no larger catalog is reachable.
  - Graphs draw at most 160 nodes unless the code atlas is switched to all nodes. Placing a full
    map was quadratic: 20,000 nodes took 2.3 s (clusters) and 4.4 s (layers) on the UI thread.
    Fixed by the measurement: it is linear now, 14 ms and 31 ms with identical coordinates
    (`graph-model.ts`, regression test in `tests/graph-model.test.ts`). Drawing 20,000 nodes in
    all-nodes mode is still that many DOM elements.
  - Release build (2026-11-05, validation entry "Performance on the release build"): turns,
    transcript, terminals and picker match the numbers above; the 20,000-file tree refreshes
    in 10.9 s, and the frontend is 22.4 MB with the Monaco editor and its language workers.
- Fixed by the measurement: the workspace checkpoint taken before every prompt (it reads and stores
  every changed and untracked file for rewind and fork) ran on the turn's critical path. It now
  captures in the background. The `checkpoint` marker keeps its place in the journal, the manifest
  follows in a `workspace_checkpoint` event, and the agent loop waits for it before the turn's
  first tool, so no tool changes the workspace before it is captured (core decision 2026-11-01).
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
