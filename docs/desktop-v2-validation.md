# Desktop v2 validation — 2026-10-27

This report describes the current dirty working tree, not a release certification.
The portable build contains the desktop executable and its separate WrongStack engine.
Initial implementation baseline: `38d075a6c8e1d0eacb1c603fcab4a6b204f11bc1`, with existing shared dirty work preserved.
The prompt-resource follow-up was finally built/checked against `75dd9964f7b75c0892e495b8bb78d2139e1ed061`
plus the scoped desktop changes. Other shared-worktree commits advanced HEAD during implementation.

## Experience changes

- Project groups organize the overview; multiple project branches can remain expanded.
- Session labels retain their project identity. Focused work has one context header.
- Chat, files, review and session tools remain immediately accessible. Project Memory, Kanban,
  Code Atlas, Files/Review/History, Chronicle and Automations open independently of conversation sessions.
- System/Light/Dark and all 13 canonical WrongStack paired palettes apply to the shell and live terminals.
  The original five-block mark and native icons are copied unchanged. Build-time synchronization
  keeps labels, paired swatches, mode-specific signals and neutral surfaces aligned with WebUI.
  Preferences persist in native SQLite; the renderer cache is only an initial-paint aid.
- SAGE opens a React Flow map of stored relationships and canonical record totals. The initial
  page sends bounded card previews, counts and metadata, with no full record/evidence bodies.
  Edges come only from persisted SAGE relationships; shared tags do not fabricate graph links.
  Nodes have explicit keyboard-accessible detail actions. Full records load on selection; the
  paged library and explicit edit/create/recover workflows remain available. Vector Memory and
  vector search remain separately mounted, independently requested workspaces.
- Kanban uses a visible project-board list with canonical summary counts/progress and Board/List
  task views. Details add contract dependencies, type, due date, effort, retry/cost limits,
  acceptance checks, notes, assignment, verification/file scope and canonical activity. Saving
  blocks task/board reselection and late responses cannot replace a different selected board.
- Code Atlas indexes real code and drills packages/files/symbols with a source drawer. Its
  Architecture, Subsystems, Dependency matrix and Change impact views use the same canonical
  graph. Impact walks directed incoming/outgoing references with explicit hop limits.
- SAGE and Vector Memory have separate surfaces. SAGE adds proposal review/accept/reject,
  named Doctor checks/repairs, audience eligibility, revision-protected evidence/retention editing,
  retrieval score breakdown and canonical file associations.
- Files adds a tree/folder browser, editable document tabs, acknowledged save/readback,
  external-change handling and file/folder mutations. A resizable bottom panel opens overview,
  structure, activity, anchored SAGE, diff and Code Assist. Review adds staging, commit/discard,
  split/unified line diffs, line notes and commit/branch/tag/file history.
- Atlas adds three layouts, explorer/sort, minimap, tour, centrality/relationship filtering,
  directed dependency paths, grounded SAGE evidence, file history and Code Assist. Relative
  project paths disambiguate repeated basenames in the explorer.
- Chronicle adds a project timeline, canonical filters/cursors/summary, detailed event evidence,
  confidence-labelled lineage graph, file navigation and collector health.
- Skills adds separate project/profile libraries, source ownership, bundled/foreign read-only
  views, create/edit/preview, validation/readback, draft protection and supporting-file navigation.
  Explicit file links can reveal Git-ignored source folders without changing default filtering.
- Files/Review/Skills beside a conversation now use the owning project service. Conversation
  engines receive no file reads; retained older engines can keep running. Relative links respect
  the conversation workdir while file tabs and drafts retain their project identity.
- Provider/model fields hydrate when journal replay arrives after the settings component mounts;
  an operator's edited selection is preserved.
- WrongStack profile settings work before adding any project. Searchable navigation leads to
  ordered fallback chains/named profiles, role/phase model and reasoning overrides, cost tiers
  with worker budgets/leader guards and optional shared-contract resource limits. Drafts survive
  section navigation. Saves read current values first, preserve independent nested changes,
  refuse detected same-field conflicts, and verify the actual result. This is not an atomic
  compare-and-swap transaction; a race after the preflight read is not eliminated. Clearing a
  limit restores inheritance. Zero main-agent iterations is accepted as unlimited.
- Kanban details separate Definition, Execution, Evidence, Breakdown and History. Execution reads
  canonical provider/model/skill/tool/capability catalogs, saves assignment policy and explicitly
  dispatches a real isolated worker. Results read the canonical lastResult field. Verification
  reports, manual splits and proposal approval/rejection have dedicated controls. Definition saves
  send only changed fields, preserving concurrent assignment settings.
- Atlas exposes Smart scope and All nodes. Layout no longer silently truncates at 160 nodes;
  a native 182-file fixture verifies full rendering and selecting a file beyond the smart budget.
- Native project/profile services require the exact bundled-engine build identity before reuse;
  an older human host retains its sessions while a matching service host uses a versioned directory.
- New portable builds use immutable directories and do not overwrite a running engine. A newer
  project-service host can coexist with an older host while sessions stay on their original host.

## Settings management follow-up

The working tree now adds dedicated global instructions, tool availability and model availability
settings. Global instructions use the canonical user document and revision token, support Markdown
preview, retain drafts between settings sections and require explicit discard on reload. Tool
settings show the real registry and its owner/permission/input metadata; mutations verify catalog
readback and persist through the active profile writer. Availability windows expose provider/model
targets, enabled state, weekdays, local times, IANA zones, blackout/allow-only behavior and a weekly
wall-clock preview. The engine remains authoritative for the combined scheduling decision.

Native verification caught tool toggles changing only the in-memory ConfigStore. A new regression
uses the real registry, ConfigStore and profile writer: the profile must retain fresh disk siblings,
and a write refusal must restore registry state and return a correlated error. Both assertions failed
before the persistence fix and passed afterward. The focused six backend suites passed 35 tests.
A native test also clicked the previous file graph before symbols loaded; it now waits for the
actual fixture symbol. An initial follow-up build failed because brand sync still copied icons from
the removed legacy shell; native icons now belong to this application independently. These failures
are retained under `.temp_files/desktop-v2-native/`.

Follow-up checks: 97 desktop tests (26 files), 35 focused backend tests (6 files), 10 Rust tests,
desktop/backend type checks (85/307 files), Biome (148 files), Cargo formatting and documentation
links (1505 local links, zero missing targets) passed. The 1.2.2 portable build
`378a4be7409e-3a47a9811cc1` compiled successfully. Its expanded native run passed the existing
project and settings-policy workflows, then failed on global-instruction revision handling before
reaching the tool/calendar workflows. The follow-up full native gate is INCOMPLETE; no full pass
is claimed for this build. Previous identity-named results do not certify these new workflows.

## Previous chat and composer follow-up

The desktop-owned composer now exposes session model selection/search and reasoning effort,
Message/BTW/Queue/Stop-and-steer modes, actual engine queue controls, stop/edit with draft protection,
and an original/refined/English refinement dialog with editing, retry and explicit approval.
The real profile refine-before-send preference is respected; its pending state blocks sending until
acknowledgement and readback. Default profile refinement was already enabled, so the ordinary-chat
fixture now deliberately disables it before testing direct send, then tests automatic refinement
separately. A clipped dialog was corrected and both dialog and composer are checked at 800 px.

| Check | Observed result |
|---|---|
| Desktop tests | PASS: 106 tests / 27 files |
| Backend focused tests | PASS: 66 tests / 5 files (session prompt queue, conversation operations, model operations, preferences and mailbox) |
| Type checks | PASS: 89 desktop source files and 307 backend source files |
| Biome | PASS: 152 desktop and changed backend files |
| Portable engine, Vite and Tauri build | PASS: 1.2.2, `8313cd4893ba-bb2549870276` |
| Standard-host native composer scope | PASS: `composer/native-result-8313cd4893ba.json`; isolated cleanup completed |
| Companion-host native composer scope | PASS: `composer-companion/native-result-8313cd4893ba.json`; isolated cleanup completed |

The queue correlation tests observed two assertion failures before the backend change and both
passed afterward, alongside the legacy controls. Correlated queue mutations now receive an
acknowledgement or refusal; a generic correlated error rejects the originating desktop operation.
Queue execution remains engine-owned. Drained user turns appear once, foreign-session frames are
ignored and a delayed snapshot cannot restore an already-started prompt.

The native composer cases ran actual portable Tauri/WebView2, native IPC, production engine and an
authenticated loopback provider. They exercised model/effort save/readback and Auto inheritance;
BTW without a second provider turn or abort; persistent queue add/remove/reload/drain; refusal to
steer over pending queue entries without losing the draft; abort/restart steering; stop/edit with
existing-draft protection; bilingual refinement, keep-original, editable English approval and
automatic refinement while preserving Queue mode. Both runs also retained the existing real
clarification submit/cancel/reload and appearance checks. There were no renderer page errors.

This is an explicitly scoped composer PASS, not a new full-native or release certification. The
previous settings-management revision/cleanup failures above remain unresolved by this round;
that workflow is not included in the focused composer mode. The default native suite still runs
all project/settings workflows and now includes the composer exercise as well. External provider
quality, the entire WebUI action inventory and long-running concurrency are not certified.
The [chat action checklist](desktop-v2-chat-parity.md) records the remaining work without counting
buttons or navigation routes as parity. Evidence is retained in `.temp_files/desktop-v2-native/`.

## Prompt resources and context follow-up

This source snapshot adds project-owned prompt resources and session-owned context controls to
purpose-built desktop dialogs. The project header opens the library before any desktop conversation
exists. Composer shortcuts open the same resources without selecting a different project's runtime.
Templates provide categories/search/favorites/recent, Markdown details, required/default/enum/multiline
variables, append-to-draft/copy, verified user-template creation and an unsaved-close guard. Creation
uses a fresh collision preflight, not an atomic same-title compare-and-swap contract.

The journal reads actual original/refined records, exact session/date/category filters and bounded
windows. Its history button stays beside the composer. The standalone bootstrap now installs Core's
canonical recording middleware; original and approved refinement text survive queued persistence.
Host-generated runtime auto-wakes are excluded. Reads use independent project runtimes, not a
conversation engine, and do not create desktop conversation records.

The input adds project file references, canonical skill mentions, keyboard completion/caret ownership,
sticky Up/Down prompt recall and a desktop slash-command registry. Enter/Tab on a mention selects
without submitting, even while the catalog is pending or empty. File chips remain isolated on session
tab switches and survive refinement; stop/edit and queue-copy restore their reference metadata.
The provider receives explicit root-bound references and complete-read instructions, while human
message bubbles show file chips. Unsupported slash commands retain the draft instead of reaching
the model. Literal slash text uses double slash. Reference drafts are not yet durable across restart.

Context inspection shows the engine's calibrated current estimate separately from cumulative billed
usage. Effective instructions require an explicit read. Repair, normal/aggressive compaction and
provider-context clear use correlated acknowledgements. Clear requires confirmation and retains
native/disk session identity. Failed reads show an unavailable state rather than fabricated zero usage.
The full editable context/mode/residency workspace remains acceptance work.

Runnable regressions observed before/after evidence on the real production paths:

- Session context correlation failed its request-ID assertion while the legacy socket control passed;
  both pass after the route wrapper change.
- Core's canonical journal writer control passed while the standalone user-input pipeline wrote no
  journal record. The installed recorder now passes original/refined persistence and runtime exclusion.
- A direct human request did not receive its correlated acceptance; legacy controls passed. Direct
  submissions now acknowledge acceptance/refusal while retaining the real human user-turn origin.
- A native session-tab replay exposed stale running state and misrouted normal input as BTW. Delivery
  now waits until journal replay catches up. A Rust boundary test also proved the byte-bounded page
  could contain fewer than 200 events with more still pending. The host now reports an explicit
  continuation flag for both count and byte limits; the unchanged assertion is green.

Source checks for this follow-up: 114 desktop tests / 28 files, 82 focused backend tests / 6 files,
259 protocol tests / 15 files, 11 Rust tests, 96-file desktop typecheck and Biome over 180 files passed.
The backend typecheck passed over 308 source files. Cargo formatting and 1526 maintained local
documentation links also passed with zero missing targets.

The final portable build is `0cfbeb6a1c35-0d0505db8780` (1.2.2):

| Artifact | SHA-256 |
|---|---|
| Desktop executable | `0cfbeb6a1c3542ecf1c33d1184cdc134f8cb1a83c9edb805a2f28367399f88c5` |
| Bundled engine | `0d0505db8780bbe3477661bf037e80d5bff6db1df00236b37e334c462c58597e` |

Its standard-host and companion-host extended composer scopes passed all assertions and isolated
cleanup. Results are `composer/native-result-0cfbeb6a1c35.json` and
`composer-companion/native-result-0cfbeb6a1c35.json`. The native runs use copied portable binaries, actual
Tauri/WebView2/native IPC and the production backend with an authenticated loopback model fixture.
No external provider call or WebUI frontend was used. Earlier extended resource runs passed standard
and companion scopes on `d7bb03be2229-a5a8f20ae589`; those are historical identities.

The current run verifies project resources with zero conversations, template creation/variables/
favorite/recent/append/draft protection, journal originals/refinements/reuse/project isolation, @/$
keyboard selection without submit, references/tab retention/actual provider input, input recall,
native slash routing, effective instructions/repair/clear with native session count unchanged and
compact layout. The earlier model/effort/BTW/queue/steer/refinement/question/appearance flows remain
in the same scope. Renderer page errors were empty. Screenshots confirm the wide library toolbar
and settled context estimates after repair.

A scoped 205-file commit attempt passed corruption, logging and staged-import guards, then the
Core API snapshot hook refused regeneration because other snapshot inputs were dirty. No commit
was created and no hook was bypassed. The alternate index excludes unrelated shared work; its
reviewed diff and refusal log remain under `.temp_files/desktop-v2-commit/`.

The earlier full-native settings-management revision/cleanup failures remain unresolved by this
composer scope. Full WebUI parity, full coverage/release gates and external-provider quality are
not certified. Failure evidence is retained under the owned native evidence directory.

## Image and PDF attachment follow-up

Desktop-owned attachment processing now supports file selection, clipboard files and HTML file
drop events. Images are decoded locally, classified from their byte signature, normalized when
needed and capped at a 2048 px long edge / 4 MB processed size. PDFs retain their original bytes
and have an 8 MB per-file cap. Image/PDF counts are separate (8/4); whole-message and persisted
queue payloads have explicit, tighter frontend budgets. The canonical engine independently checks
MIME, bytes, PDF structure and model/fallback support. No WebUI component is imported.

The composer shows removable image thumbnails and named PDF cards without adding a permanent
panel to empty chat. Drafts are owned per session and survive tab navigation within the current
UI process. Files stay attached through refinement cancel/apply/approval; refinement operates on
the text only. Direct submissions require actual engine acceptance before clearing the draft.
Running Message/BTW with files visibly queues a new turn instead of sending a text-only mailbox
message. Stop-and-steer retains the files, and stop/edit restores the previous turn's media.
Queue copy explicitly says Copy text only when binary files remain in the engine queue. Persisted
PDF blocks now retain their filename and data in the drained conversation frame, with a regression
using the real QueueStore load/drain path. Conversation images open an explicit local preview;
PDFs use readable file cards. Remote or arbitrary data URLs are never fetched for these previews.

Native requests were previously capped at 1 MB and replies at 4 MB. A valid short-frame control
passed while a greater-than-1-MB attachment failed the real frame reader. The same assertion passes
after bounded 20 MB requests / 24 MB replies; incomplete and oversized frames still fail. Large
requests first query the host's supported request size, so retained older human hosts are refused
before transfer rather than being restarted. Older engines without direct user acknowledgement
cannot silently accept-and-discard file drafts. Existing user processes were not restarted.

Windows shell and project windows opt into HTML drag/drop using the installed Tauri API; file
drops outside an explicit workspace cannot navigate the shell away. Synthetic clipboard/drop events
exercise the actual WebView renderer path; they are not evidence of a physical OS file drag gesture.

The first native attempt used an unknown custom model without image-input capability. The engine
refused its vision fallback (present_artifact containment), kept both files and text in the draft,
and issued no provider turn. That is not a successful image-delivery result. Custom endpoint setup
now includes an explicit image-input capability checkbox, defaulting off; the isolated fixture uses
it rather than forcing all custom endpoints to advertise vision. The fallback's containment refusal
is not changed or certified by this round. The actual PDF processor successfully reached that
later image-routing refusal, so this failure was not a missing PDF runtime asset.

One intermediate dependency build reported missing contracts declarations after that package had
already built, causing module-resolution cascades. A later read found those declarations restored.
Concurrent shared output changes are a possible explanation, not an established cause. No unrelated
source was edited for those diagnostics. The complete retry built successfully.

Source verification: 125 desktop tests / 29 files, 83 focused backend tests / 6 files, 12 Rust tests,
and desktop/backend type checks over 98/308 source files passed. The current native identity and complete run results follow below.

The attachment-only build 6bebcd781651-afd3265efe3c passed standard and companion extended composer
scopes with isolated cleanup. Its retained reports are composer/native-result-6bebcd781651.json and
composer-companion/native-result-6bebcd781651.json. Two intermediate failures were harness defects:
the local provider's unanchored hold matcher interpreted an older quoted prompt as a current hold;
a PDF filename selector incorrectly required the combined name/size element's text to be exact.
The model-input, file-retention and queue assertions were not removed. These reports predate the
additional reply-boundary fix below and do not certify it.

Visual review of the real native transcript exposed a separate renderer defect: repeated backend
stream ID current appended a later answer to a historical bubble. A regression failed with one
merged answer while eight projection controls passed. The renderer now appends only to the active
trailing assistant stream; a completed or intervening user turn creates a distinct reply identity.
The same regression and the full 125-test desktop suite pass. Native assertions require the current
answer's Markdown heading in the assistant article immediately after the current user turn.

The final portable identity is 83a655728f00-22c9ed087701 (1.2.2). Both standard-host and
companion-host extended composer scopes passed with this exact pair of binaries, zero renderer
page errors and completed isolated cleanup:

| Artifact | SHA-256 |
|---|---|
| Desktop executable | 83a655728f00c662055435eada3553520bb22c27387e83a9799785054474730b |
| Bundled engine | 22c9ed08770180abeae0e63609572658fc57a8b615ae0a1e5c408778c6328629 |

Reports are composer/native-result-83a655728f00.json and
composer-companion/native-result-83a655728f00.json. They cover the greater-than-1-MB native request,
actual image bytes / extracted PDF text reaching the provider, local preview decoding, the new
reply-after-user assertion, invalid PDF refusal without a phantom user turn or discarded draft,
image decode refusal, session-tab draft retention, renderer paste/drop, refinement cancel/approval,
engine queue reload/drain and stop/edit media restoration. Compact and full-size native screenshots
were inspected. Physical OS drag gestures and external provider quality remain outside this scope.

Scoped Biome passed over 176 files; Cargo formatting and 1526 local documentation links passed
with zero missing targets. The 212-file alternate commit index was regenerated and reviewed. A
read-only evaluation of the actual snapshot hook still reports fail because unrelated snapshot
inputs are dirty; no new commit or hook bypass was attempted for that unchanged blocking condition.

Durable unsent media recovery across app restart, a full document viewer, physical OS clipboard/drop
QA and external-provider image/PDF quality remain acceptance work. This scoped composer run does
not replace the unresolved default-full-native settings-management gate or certify WebUI parity.

## Previous certified snapshot checks

| Check | Result |
|---|---|
| Desktop Vitest | PASS: 94 tests, 25 files, including nested settings merge/conflict/deletion, persisted-only SAGE graph edges, canonical branding and existing knowledge/files/skills contracts |
| Native Rust tests | PASS: 10 tests, including exact engine-build service compatibility, project/service ownership and bounded request-pool concurrency/queue/drain |
| Backend focused suites | PASS: 77 tests / 3 files in the final focused memory-handler/memory-route/preferences run, including summary-only payloads, bounded graph roots and the unchanged full-record contract. Prior focused Kanban/provider sets are historical evidence; this is not the entire backend suite |
| Desktop and backend typecheck | PASS: 81 desktop files and 307 backend files in the final source check |
| Biome and Cargo formatting | PASS on the changed desktop/backend files |
| Backend dependency closure, standalone engine, Vite and native release build | PASS |
| Documentation links | PASS: 1509 local links, zero missing targets |
| Two standalone engines in one project | `5c016c9c96b7` engine PASS; latest standalone-only probe NOT RETESTED. The current native UI run separately exercises two live agent processes and their local-provider turns |
| Full portable native UI smoke with companion host | PASS: current 83c5a7ce1d39-41e0fb0c9513; full functional flow, settings policy persistence/concurrent edits, summary-first SAGE React Flow, all 26 palette/mode combinations and isolated cleanup; companion/native-result-83c5a7ce1d39.json |
| Standard-host full native smoke | PASS: current 83c5a7ce1d39-41e0fb0c9513; full functional flow, all 26 palette/mode combinations and isolated cleanup; native-result-83c5a7ce1d39.json |

Previous verified portable identity: `83c5a7ce1d39-41e0fb0c9513`, retained in the identity-named
`apps/desktop-v2/dist-native/` directory. `latest.json` can advance before native certification. Standard completion:
`2026-10-26T18:37:55.869Z`; companion completion: `2026-10-26T18:42:01.699Z`.
Both runs finished all assertions, recorded no renderer page errors and completed isolated cleanup
before writing PASS. The existing primary host and human engine were left running.
Earlier identity-named results are historical evidence; a functional PASS does not certify
long-running startup or renderer stability.

The native runs checked the original rendered logo and all 13 pairs in both modes against the
canonical primary, paired accent and neutral surface values. Primary-button and body text met
4.5:1; saved appearance, legacy preference migration, OS mode changes, an 800 px layout and
live terminal theme updates passed. The largest emitted JavaScript chunk is 352.52 kB,
below Vite's 500 kB advisory threshold.

Native verification exposed and corrected stale Memory filter results, a write/filter race,
an invalid form minimum for the engine's valid zero continuation budget, and Atlas selection
loss during an index refresh. Backend tests caught and verified the fix for an MCP socket
identity regression introduced by reply correlation. The local provider fixture now tolerates
engine-generated context notes after tool results, and the restart test waits for the entire
saved navigation state before closing the UI.

The standard-host run reached its first chat request and the bundled engine crashed with:
`Failed to start HTTP Client thread: The paging file is too small for this operation to complete. (os error 1455)`.
Evidence is retained in `89433510-6b2c-4869-8a5b-80735cb726ff.log`. This is an observed failure,
not a passing standard-host certification. No Windows paging settings or unrelated processes
were changed. Failure screenshots/CDP shutdown are now bounded so a stalled WebView cannot
prevent isolated test cleanup. Startup waits use the native runtime's 90-second startup budget
rather than the ordinary 20-second control timeout.

The current passing standard-host run verified these portable artifacts:

| Artifact | SHA-256 |
|---|---|
| `wrongstack-desktop-native.exe` | `83c5a7ce1d39d28e19e0bb0820f02faa68a68a9a934573aaafc9c6cf6494f8f1` |
| `wrongstack-engine.exe` | `41e0fb0c9513c25a2964db8acdb4838a02c17d403e53c86e9bcd4e3dc793ae69` |

The expanded standard-host run verified, in the actual Tauri/WebView2 application:

- SAGE proposal accept/reject, Doctor repair, audience selection, protected retention/evidence
  edits, score breakdown and separate vector status, without desktop sessions.
- File tree/evidence panel/resize, canonical anchored SAGE, structure/activity, create/edit/save,
  external-change reload, rename/move/delete, unified/split diff, line notes and stage/unstage.
- Atlas layouts/minimap/tour, directed dependency highlighting, SAGE provenance, source/history
  and working-file navigation. Commit history/ref selection and committed file diff also passed.
- Chronicle query filtering, 105-event cursor pagination, real three-event/eight-relationship
  lineage and file navigation. Fixture events were appended through the canonical project owner.
- An authenticated local-provider Code Assist run, with no new desktop conversation record.
- Project/profile skill discovery/create/edit/readback, invalid-document refusal, draft-leave
  protection, ignored supporting-directory reveal and canonical file selection, with zero sessions.
- Conversation-side file access through project services, project Code Assist after profile setup,
  and saved provider/model hydration after remounting settings.
- Existing provider setup/encrypted-vault/stream/error, real clarification/Markdown, theme,
  three PTYs, UI reload/restart and saved-provider use in a new engine process.

Renderer errors were empty, both portable checksums matched, and cleanup completed before the
PASS record was written. This is native workflow evidence, not full WebUI or release certification.

The final native flow additionally verified read-only SAGE record navigation before explicit
editing, the richer task inspector and its persisted assignment/report/split data, provider
catalogs with request correlation, and real pinned-route task dispatch without creating desktop
conversation records. The isolated local model returned a result visible through the canonical
assignment `lastResult` field. Atlas rendered the complete 182-file fixture as well as the explicit
160-node smart scope.

## Existing-workspace visual check

The final executable was opened against the retained primary host. The original mark and
persisted appearance rendered correctly. A subsequent navigation attempt was interrupted by
detected user input, so no successful live-project graph inspection is claimed for this build.
The isolated native runs separately verified the graph, record-detail action, real relationship
labels and the new settings editors at desktop and compact widths.

The previous branding build was also visually checked against the retained workspace: Appearance
showed all 13 pairs and migrated the saved dark/Copper choice to Rose & Copper. No existing task,
memory or conversation was edited during these visual checks.

The retained human conversation reported `Engine is disconnected` when the new UI restored it.
Its original host and engine processes remained alive. They were not restarted or replaced.
The isolated current-build session/restart tests passed; this observation does not establish
working reconnection for that retained historical session. The earlier visual pass separately
showed nine Kanban tasks and 87 SAGE records in an existing registered project.

## Current settings and SAGE interaction evidence

Both final runs verified, with zero desktop conversation records:

- Ordered fallback-chain editing/reordering and named profile creation with canonical readback.
- Role-specific provider/model, fallback-profile and reasoning-mode/effort/preservation overrides.
- Cost tiers, spend/count/token budgets, role-to-tier routing and leader switching guards.
- Shared engine limit bounds, an invalid lower-bound input, clearing a limit back to inheritance,
  saved zero main-agent iterations and drafts retained across section navigation/discard.
- A real out-of-band preference write: independent nested profile edits survived; an edit to the
  same chain was refused before writing, retained its local draft and offered explicit reload.
- React Flow default navigation, bounded summary-only SAGE payloads, stored directed relation labels,
  zoom and a keyboard-triggered full-record detail fetch. The optional library and lifecycle
  deletion/recovery assertions continued to pass. The SAGE map does not request the vector store.

The first expanded native attempt reached a visible graph but exposed a missing explicit record
action: React Flow nodes were groups. Cards now provide keyboard-accessible detail buttons.
The next attempt saved fallback profiles but found ambiguous select labels; explicit accessible
names now identify each profile/tier/reasoning selector. Both unchanged workflow assertions passed
in the final runs. Failure logs are retained as `failure-sage-node-open-e944.log` and
`failure-settings-select-label-0a516.log`.

Two intermediate engine builds failed during declaration emission: one could not resolve contract
declarations from vector-memory; the next saw an overload mismatch in a concurrently changing
connection-lifecycle file. Focused builds and the final complete dependency/native build passed.
No unrelated lifecycle source hunk was edited for this work.

## Current interaction regression evidence

The first new native run (`73471ec3e87b-20a09cee36c2`) exposed task reselection while a
definition save was still awaiting acknowledgement: the old save then closed the inspector
and discarded the next acceptance-check draft. The final build disables task/board reselection
during the write and rejects stale board responses. The same native save/reopen/check flow
passed with the final build, including persisted due date, effort, checks, notes and assignment.

Two intermediate harness failures were test expectations: a capture still expected graph nodes
on SAGE open after the deliberate library-default change; an Atlas label selector matched both
a node title and its subsystem name. The final test targets the library and the impact node title.
No assertion was removed from the affected user workflows.

## Current native QA environment

The final full runs used an owned, bounded 12 GiB Windows job with kill-on-close cleanup for only
their newly spawned test process trees. The parent explicitly allowed breakaway. The standard
run peaked at 8,049,729,536 bytes; companion peaked at 8,050,286,592 bytes. No existing user process
was assigned to that job and no parent job, paging or Windows setting was changed. Earlier
read-only probes inside the test parent reported an 8 GiB job limit; this does not prove the cause
of earlier WebView/engine exits. Runner scripts and logs remain under
`.temp_files/desktop-v2-native/` for evidence.

## Observed stability limits

The `f9ff51867bf9-20a09cee36c2` and first `c20fbe62bebe-20a09cee36c2` standard attempts each lost
an additional engine at startup with Windows exit code `0xC0000409`. The latter passed when rerun
without changing its binary or assertions. Records include `failed-state-f9-startup.json`,
`failed-state-c20-startup.json` and the corresponding engine transcripts. The cause remains unresolved.

A read-only diagnostic caller reported no enabled process/job committed-memory cap. The detached
test runner's own job query returned access denied, so its limits are **unknown**. A later system
snapshot reported 163,145,039,872 committed bytes out of a 272,364,335,104-byte limit (59%); this was
not a measurement inside the failing engine. These observations do not establish crash causality.
The diagnostic uses [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
and the documented [extended limit structure](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information).
Those earlier diagnostic probes changed no job limits, Windows paging settings or unrelated processes.

The first expanded native run (`f59de3621836-f06b89d4d2da`) passed SAGE proposal accept/reject,
Doctor repair, audience/retention/evidence/retrieval, the file evidence drawer, file mutations,
save conflicts, Git diff/review/stage/unstage and three-PTY UI reattach. Its subsequent agent
engine exited with Windows code `0xC0000409` after configuration loading began. No cause is
inferred from that code alone. `failed-state-f59.json` and its engine log retain the failure.
An expanded Atlas test initially stopped because its selector matched two `index.ts` files;
the test now selects the source directory explicitly, and the UI displays relative directories.

## Earlier baseline proof

The earlier native runs exercised the previous eight mode/palette combinations; primary-button and body text
contrast met 4.5:1. System changes, saved appearance, live terminal colors, 800 px layouts,
three PTYs, UI reload/restart, native provider setup, encrypted credentials, Markdown/copy,
project-file links, and the real clarification tool passed their individual checks.
Memory create/edit/refused deletion/explicitly authorized deletion/recovery and Automation
preview/save/enable/queue/cancel/disable also passed in the native UI.

Earlier complete runs failed at the additional agent session: a native engine exited with
Windows code `0xC0000409`, one WebView target crashed, and one host log recorded an OS-thread
creation panic. The host now reuses eight request workers with a bounded 24-request queue;
worker creation errors are returned during startup instead of panicking per renderer poll.
The test closes old CDP connections and uses normal daemon idle settings. The standalone
two-engine control passed, but it does not by itself certify native UI lifecycle stability.

The final smoke writes `.temp_files/desktop-v2-native/native-result.json` only after all behavior
checks and cleanup succeed. Screenshots and failure logs remain beside it for review.
The first passing request-pool run is retained as `native-result-after-request-pool-1.json`.
Those earlier successful runs verified these portable SHA-256 identities, not the current build:

| Artifact | SHA-256 |
|---|---|
| `wrongstack-desktop-native.exe` | `5003b384ef6b2ca33d449561c58b85018f16c0479bde8118fd2c27dcf1c9f640` |
| `wrongstack-engine.exe` | `3093aa7637d4d156b6ea6a79c213b560d9acfd5b7cd5e16fa6fcbf8b872976f6` |

## Cleanup limitations

Automatic approval review rejected cleanup with the reason `blocked by policy` for these owned
test directories. They were left untouched after rejection:

- `C:\Users\ersin\AppData\Local\Temp\wrongstack-desktop-v2-sPgQxN` (earlier run).
- `C:\Users\ersin\AppData\Local\Temp\wrongstack-desktop-v2-4WsGq5`.
- `C:\Users\ersin\AppData\Local\Temp\wrongstack-desktop-v2-urDACb`.

Windows cleanup also returned `EPERM` for these failed-run directories:

- `C:\Users\ersin\AppData\Local\Temp\wrongstack-desktop-v2-RUfbcC`.
- `C:\Users\ersin\AppData\Local\Temp\wrongstack-desktop-v2-HlNL1c`.

New test cleanup targets only processes whose command lines contain that run's unique directory,
including the private session-host copy, engine daemons, and WebView profiles.

## Uncertified

Full WebUI functional parity, long-running multi-agent stress, the complete coverage/release
matrix, hosted CI, signed installers/updates, macOS/Linux, external provider authentication,
live model quality, Docker worker execution, and GitHub publication are not certified.

## Approval, activity and next-step source checks

The current desktop source passes 135 tests in 32 files and its typecheck covers 102 files.
Approval cards now display structured arguments, edit previews and policy choices; session activity
groups engine events by run and agent; completed-turn suggestions can be added to a draft. These
checks do not establish complete WebUI parity or certify every native policy path.

A full current-source desktop build was blocked by type errors in the concurrently modified Goal
package (`checkpoint.ts`, `goal-runner.ts` and `phase-graph-builder.ts`). Those unrelated changes
were left intact. A UI-only native build reuses the previously built engine with SHA-256
`22c9ed08770180abeae0e63609572658fc57a8b615ae0a1e5c408778c6328629`; it is not a full build of
the current source tree. The initial UI executable SHA-256 is
`fdaae63766ea2bd857a64efea80a0d623d110fae8fef53e6203b17eeb673fa37`.
An isolated native trial reached a real `exec` approval, received the
engine's resolution and executed the command successfully; its later timeout was caused by the
fixture repeating an earlier held prompt, so that trial is not an end-to-end pass.

After correcting the fixture, both standard and companion-host native composer scopes passed with
identity `fdaae63766ea-22c9ed087701`, verified portable checksums, exit code 0 and isolated cleanup.
It exercised actual exec allow, deny and remembered exact policy, engine acknowledgement,
structured run activity, completed next-step selection and explicit queue submission, alongside
the existing composer, resource and attachment checks. This used the reused engine described
above and an isolated local provider; it does not replace a full current-source build or the
unresolved full-native settings-management gate.

A subsequent UI-only build `9b039768dba9-22c9ed087701` includes the approval auto-follow fix.
Its UI SHA-256 is `9b039768dba9b0f3da3e6cdc42f51edc10d54fe16197320113374fd833f447c4`;
the engine is the same reused binary. Source tests, typecheck and the standard native composer
scope passed again, including a viewport assertion for the new approval actions. The companion
host was tested on the preceding UI build, not this subsequent one.

## Chronicle project insights (in progress)

Desktop requests project-wide provider, task and file metrics directly from Chronicle; timeline
filters do not apply. Earlier native runs displayed the provider but returned empty task and file
views. The project transport was attaching its internal engine session ID to every outgoing
message, inadvertently filtering project metrics. A regression test failed with that behavior and
passed after separating project/profile requests from session-bound requests. All 13 native Rust
tests passed. Native scope `chronicle` passed without any desktop sessions using isolated portable
build `e3f4d3a22359-a566141c2989`; real fixture provider, task and file records were displayed and
portable checksums verified. The standard composer scope also passed with the same build, including
session model/effort, queue, BTW, steer, media, approvals and next steps. The engine was compiled
from already-built workspace packages, not from a successful full current-source dependency build.
The earlier empty metrics results were caused by the transport scope, not an old-engine defect.
The full profile/settings native scope was not rerun after the transport change.

## Conversation draft text recovery

The session text draft is stored in the native SQLite registry and loaded on demand for its agent
session. Saves are serialized per session; empty drafts delete their row and write failures are
reported. Registry tests cover independent sessions, restart, clearing and rejection of unknown
or terminal sessions. The desktop suite passed 137 tests, typecheck passed 104 files, and all 13
native Rust tests passed. Native composer scope `623c9d698194-a566141c2989` passed, including
renderer reload, actual UI process restart, saved-text readback and clearing. Its engine was built
from existing package outputs, not a successful complete current-source dependency build. Draft
delivery mode was not persisted, and concurrent editing of the same session across windows and
abrupt termination during a pending save were not certified.

The subsequent native composer run `7789abec58b7-a566141c2989` also passed after adding durable
attachment and reference storage. It restored an image, a PDF whose encoded payload exceeded
1 MB, and a project file reference after UI process restart; the actual engine received the image,
extracted PDF text and reference, and their stored draft entries cleared after submission. Native
checks used existing prebuilt engine package outputs, not a full current-source dependency build.
Concurrent same-session window editing remains outside this proof.

The later composer scope `1926a6bb7d2d-a566141c2989` passed with persisted delivery mode. A
Queue selection, text, image, PDF and project reference were restored after UI restart, and the
queued attachment was confirmed removed from the saved draft before a further reload. Cleanup
failures after engine acceptance are reported as such rather than presenting the message as unsent.
The engine again came from existing package outputs. Abrupt termination during an in-flight save
and concurrent edits from separate windows remain unverified.

Draft writes now compare per-part SQLite revisions in an immediate transaction. When another
window has changed a part, this window retains its local edits, blocks sending, offers copy and
requires explicit confirmation to load the stored draft. The same application build was exercised
in two real native windows with conflicting text edits, explicit reload, and a stale send refused
before contacting the local provider. Native composer scope `ced6e0a613a8-a566141c2989` passed
with portable checksums verified and cleanup completed, including the existing media, queue and
approval scenarios. The engine used existing package outputs. The SQLite tests also cover old-style unversioned writes:
database triggers advance the revision so a new client detects those writes. An old client itself
can still overwrite without checking; mixed-version concurrent editing has not been certified.
The send-time revision check and engine delivery are separate operations, so a change arriving
between them remains a race; abrupt termination during an in-flight save is not certified.

The conflict UI now compares both versions and can keep either, including references, attachment
data and delivery mode. Replacing the stored version checks all reviewed revisions in one SQLite
transaction. Native composer scope `fe7be0cc3c60-a566141c2989` passed with two real windows:
both choices worked, a change made after comparison caused replacement to be refused, and an
explicit retry preserved the local image bytes. The portable checksum was verified and isolated
cleanup completed. Its engine used existing package outputs; this is not a full current-source build.

Automatic approval review rejected deletion of the isolated control directories below with
`blocked by policy`; they remain untouched:
`wstack-metrics-control-nY1dGT`, `wstack-metrics-control-2SqpJp`,
`wstack-metrics-control-diLirw`, `wstack-metrics-control-GOKN5S`,
`wstack-metrics-sqlite-control-HrW7ph`, `wstack-metrics-sqlite-control-H9l418` and
`wstack-metrics-sqlite-control-9gz18V`, all under `C:\Users\ersin\AppData\Local\Temp`.
# Project Goals native validation — 2026-10-27

The project-owned Goals workspace was exercised in the Tauri/WebView2 shell using portable
identity `e12d3dbef7da-a566141c2989`. An isolated project with no desktop sessions loaded a
persisted goal from the engine catalog, opened its phase and task details, and changed the task
to `review`; both the persisted graph and the selected UI value were read back. The compact
800 × 640 viewport had no document-level horizontal overflow, portable checksums matched, and
the renderer error list was empty. The native harness exited successfully after cleanup.

The native engine in that package was the existing compiled engine probe, built from previously
available package outputs; this is not a full current-source engine build or a proof of goal
planning, pause/resume/stop, retry, multi-project isolation, or live provider execution. Earlier
fixture-path and hidden-option assertion failures were corrected before the successful run. Three
fixture files accidentally written under the user's WrongStack project directory were identified
by their exact IDs and contents and removed; their parent directories were retained.

Desktop typecheck passed (105 files), and the desktop Vitest suite passed with one worker
(34 files, 140 tests). A prior default-parallel test attempt failed with memory allocation errors.

The follow-up native Goals run used portable identity `51d83e67cd2d-a566141c2989` and the
same prebuilt engine limitation. With no configured provider, a real assessment returned an
unusable result; the form showed the failure and retained the goal text. A stopped goal did not
offer live-only assignment, and catalog, task status persistence, compact viewport, checksum,
and renderer-error checks passed again. Active-run assignment and phase movement, a successful
provider assessment, and cross-window assessment contention were not exercised natively.
Desktop typecheck passed (106 files); the one-worker desktop suite passed 34 files and 141 tests.

Persistent project mission follow-up: portable identity `f4a4cfc0af79-a566141c2989` passed the
native Goals scenario with no desktop conversation. The UI created a mission, held a replacement
until confirmation, persisted the replacement, paused and resumed it, and cleared it while the
separate execution graph remained in its store. Filled mission and goal text areas retained their
accessible labels. The same run passed the existing goal catalog, task status, assessment-error,
compact viewport, checksum and renderer-error checks. The engine was still the existing compiled
probe, not a full current-source engine build. Refinement with a live provider and concurrent
mission writers were not verified. The editor checks the last observed mission identity, but the
backend mutation has no conditional-write token, so a change between observation and write can
still race. Desktop typecheck passed (107 files); the one-worker suite passed 34 files, 142 tests.

Project SDD follow-up: portable identity `9aa713d6c5d7-a566141c2989` passed native catalog and
dependency-graph checks with no desktop conversation. The fixture used the canonical SpecStore
and TaskGraphStore inside the isolated test root; the engine discovered the specification, its
task descriptions and the reported dependency. Both task-list details and the React Flow edge
were observed, worktree isolation defaulted off, the empty run catalog rendered, the 800 × 640
viewport had no document overflow, checksums matched, and renderer errors were empty. An earlier
graph assertion ran before React Flow had measured its nodes; the final test waits for the actual
edge. The native job exited successfully after cleanup. The engine remained the existing compiled
probe, not a full build of the current engine source.

The interview, approval/rewind/discard, run-start and live task control paths are wired to canonical
project messages, but were not exercised with a live provider or active worker in this native
scenario. Historical run detail, task splitting, lifecycle/rollback and complete model catalogs
remain pending. Live control requests are queued by the engine; the desktop does not synthesize
an applied result. Typecheck passed (110 files), the one-worker desktop suite passed 35 files and
146 tests, and the targeted Biome check passed.

SDD maintenance follow-up: portable identity `8e9e597e2ded-a566141c2989` passed the native SDD
scenario with the same prebuilt-engine limitation. The isolated fixture had no managed worktrees;
the cleanup returned a real zero-removed result. Project-wide SDD clear retained the specification
before confirmation, removed it through the engine after confirmation, and refreshed the empty
specification catalog. The UI displayed the structured lifecycle outcome. This proves empty
worktree cleanup and isolated artifact removal, not removal of real worktrees or Git rollback.
Task splitting is wired to the live-run command and explains the completed-container/dependency
semantics; active-worker consumption of that command remains unverified. The desktop suite passed
35 files and 148 tests; typecheck passed 112 files. Maintenance gating also has coverage for a
different active run in the project. Lifecycle replies have no request correlation token, so the
UI matches the pending operation within its project connection.

Requirements intake follow-up: portable identity `911041c70331-a566141c2989` passed the extended
native SDD scenario. The desktop created an intake draft through the real project API and read
back its original request with leading whitespace and trailing newline unchanged. It saved edited
information, recorded a question answer, prepared an SDD interview draft without starting a run,
submitted the intake and archived it. A concurrent API update advanced the stored version; the
desktop's stale save was refused with the engine's readable conflict message, retained the local
edit, and preserved the concurrent writer's value. No desktop conversation was created.

The native package used the existing compiled engine probe, not a full current-source engine
build. Intake cancellation, transport-failure idempotency, cross-project isolation, attachments
and suggestion generation were not included in this scenario. Desktop typecheck passed 113 files;
the one-worker suite passed 36 files and 151 tests. The first new HTTP test attempt was blocked by
an uninitialized browser global; isolating the native-request boundary fixed the test setup.

Requirement resources follow-up: portable identity `322b5abdba90-a566141c2989` passed the same
native scenario with a file-path attachment reference and related issue authored in the new
intake form. The real API returned those references from the persisted record and the desktop
rendered them as named evidence, alongside the original request. Existing edit/conflict/answer/
SDD-transfer/submit/archive checks passed again; the native job completed cleanup successfully.
The package still uses the prebuilt engine probe and is not a full current-source engine build.

Recorded suggestion previews and field provenance have focused rendering coverage. No live
suggestion generation or decision was performed: the project intake service factory currently
does not configure a generator, and the HTTP router has no accept/reject or append-resource
endpoints. Resource authoring therefore applies to draft creation; file contents are not uploaded.
Desktop typecheck passed 114 files and the one-worker suite passed 36 files, 153 tests.

Versioned intake resource/decision APIs follow-up: source HTTP tests initially returned 404 for
the new resource and suggestion-decision requests. The authenticated router now forwards
`POST /api/requirement-intakes/:id/resources` and
`POST /api/requirement-intakes/:id/suggestions/:suggestionId/accept|reject` to the canonical
service. Each requires a non-negative integer `expectedVersion`. The HTTP suites passed
103 tests in three files, including stale-write refusal, missing-version refusal, authentication,
submitted-record locking and original-request preservation through suggestion decisions.
Server typecheck passed 308 files and its package build passed; desktop typecheck passed
114 files and the one-worker desktop suite passed 36 files, 153 tests.

Portable identity `d5f7c45b084e-0b6c6576bb09` then passed the extended native SDD scenario:
the UI appended a second file reference to an existing intake, accepted a title proposal, rejected
an outcome proposal and read all results back through the real API. The original request stayed
unchanged and the existing edit/conflict/answer/SDD-transfer/submit/archive checks passed.
Proposals were produced by a deterministic test generator through the canonical domain service;
this was not live provider generation. The native job completed cleanup successfully.

This native engine includes the freshly built webui-server package; other workspace dependencies
were reused from available compiled outputs with `build-engine --skip-build`. It supersedes the
older prebuilt-engine-only limitation for these new HTTP routes, but remains distinct from a full
current-source workspace/release build. Configured live suggestion generation and durable form
drafts remain pending.

Native new-requirement draft follow-up: portable identity `6625ce086351-0b6c6576bb09` passed the
extended SDD scenario with two real native UI restarts and a second project window. SQLite stored
the original text, structured fields, added attachment/resource references and create-retry identity
under the registered project's identity. A different project had no draft. A stale window could not
overwrite the saved version or submit its stale form, and a saved version changed after comparison
was refused until compared again. Confirmed use of the saved draft restored the full form.

The test also simulated a server-accepted create whose reply had not reached the form: it retained
the prepared identity, restarted the UI and retried through the desktop. The API returned the same
record, the catalog contained one intake and the persisted draft cleared with a revision tombstone.
An initial regression test failed because JSON field reordering changed the submission fingerprint;
canonical object-key ordering fixed it. No live provider was called. Existing resource/decision,
edit/conflict/answer/SDD-transfer/submit/archive checks passed again, and cleanup completed.

The desktop suite passed 36 files, 156 tests; typecheck passed 116 files. All 14 native Rust tests
passed, including project isolation, reopening, stale clears and tombstone revision behavior.
The engine is the prior freshly compiled server probe with other available dependency outputs,
not a full current-source workspace/release build. At that checkpoint, persistence covered new-request text,
information and explicitly added references, rather than existing-record edits, answer text or
reference fields not yet added. An abrupt exit while the UI still reports saving can lose pending
input; the tested restarts wait for native save acknowledgement.

## Existing requirement edit and answer recovery

Portable identity `e9dc8dd1d5b6-a6cd0208de38` passed the extended native SDD scenario. Existing
requirements now retain metadata edits and per-question answer drafts in the native SQLite
registry, under separate project/requirement slots. Hydration preserves the original server
version used to start the edit or answer; restarting does not silently rebase a write. Local
draft writes are ordered and revision-checked. Conflicting windows retain their local text and
offer readable comparisons with confirmed saved/local choices; a changed comparison is refused.

The real Tauri test restarted the UI with unsaved metadata, restored the fields, advanced the
record through a separate API writer and verified that saving refused the stale version while
preserving the draft. It then restarted with an unsent answer, restored the text, advanced the
record again and verified the same refusal. Reloading the record retained the answer, and the
explicit **Use current record version** action allowed a reviewed submission. The acknowledged
answer cleared its native draft while retaining a revision tombstone. The screenshot
`.temp_files/desktop-v2-native/sdd/native-requirement-answer-restored.png` was visually inspected.
The complete scenario also passed the earlier create/retry, multi-window draft review,
resources/suggestion decisions, edit/conflict, SDD transfer, submit/archive and spec dependency
checks, with zero desktop conversations, no renderer errors and no horizontal overflow at the
tested compact width. Owned test processes and temporary data were cleaned up successfully.

The HTTP answer endpoint now accepts an optional validated `expectedVersion` and passes it to
the canonical service. The regression failed before this change (stale answer returned 200
instead of 409), then passed with the same assertion. Clients omitting the version retain their
existing behavior. Focused server verification passed 104 tests across three files; server
typecheck passed 308 files and its build completed. Desktop verification passed 160 tests across
37 files, typecheck passed 119 files, and all 14 native Rust tests passed. Targeted Biome checks,
documentation links and `git diff --check` passed.

The engine was rebuilt with the current server output and other available dependency outputs;
this is not full current-source workspace certification or a release build. No live model was
called. Reference inputs not yet added to a resource list, cancellation-reason drafts, configured
suggestion generation and broader desktop parity remain open. The tested restart boundary is
after native save acknowledgement; an abrupt exit during a pending save remains outside this proof.

## Provider model catalog, credentials and health

Portable identity `3d59b9326922-82e4e745f023` passed the focused `--models` native scope with no
desktop conversations. This scope uses the Tauri-owned settings UI and canonical backend services.
It exercised model search against the bundled registry, an empty search, review without saving,
custom definition creation/edit/removal, persisted config readback, stale-editor refusal and
explicit draft-close choices. Explicit false capabilities and free input prices survived;
unexposed reasoning options and pricing tiers were retained during edits. Removing a definition
also removed its saved model-list entry. Refresh rediscovered connections after an empty catalog.

The same run changed the active saved key, cancelled and confirmed deletion, observed the engine
selecting the remaining key, and cancelled/confirmed provider removal. Fixture keys remained
encrypted on disk and absent from renderer markup. These checks do not establish OAuth, vault
lock/rotation/export or external-provider access parity.

Quota verification used an authenticated local account endpoint through the real configured
provider quota reader. It displayed 30% usage, the reset clock and a $12.50 balance; a separate
reader failed visibly. Repeated refreshes used the canonical throttle without another HTTP call.
After that interval, a failed refresh of the previously successful reader retained its recorded
usage. No model prompt or external provider was invoked.

The standalone route previously omitted its runtime provider status tracker. The native waiting-room
case failed before that connection was made. Routes now expose the existing tracker and lazily
restore recorded profile entries; manual release/clear updates the profile status file and writes
readable audit events. The native test restored a blocked fixture, released it for the next probe,
cancelled and confirmed clearing, then read the actual tracker. A permanent real-tracker/filesystem
test also verified reopening after clear, preservation of another provider's row, audit readback
and retry after a malformed status document is repaired. This does not certify automatic failure
persistence and synchronization across every independent engine runtime.

Model registry, quota, status and audit replies now retain request IDs. Correlation regressions
were observed failing first and then passing; unrelated frames and legacy calls remain unmodified.
Focused server verification passed 83 tests across five files, typecheck passed 309 files and the
server build completed. Desktop verification passed 177 tests across 39 files and typecheck passed
123 source files. The native screenshots were inspected, the compact 800px checks found no
horizontal overflow, no renderer errors were recorded, and owned test cleanup completed.

The engine includes the freshly built server and other available dependency outputs. This is
focused native evidence, not full current-source workspace certification, signed packaging or a
release. Model writes use a stale-edit preflight and saved readback; the protocol does not expose
an atomic model-definition revision. Advanced schema authoring and restart-safe model-editor
drafts remain open. Evidence is retained under `.temp_files/desktop-v2-native/models/`.

## Project mailbox

Portable identity `41a0ebf2c931-baecef10dcbc` passed the focused `--mailbox` native scenario.
The mailbox is a project workspace, accessible with zero desktop conversations. The actual
project engine supplied its canonical root for fixture setup; the first fixture incorrectly
used the Windows registry's extended namespace path and reached a different mailbox. That test
setup was corrected without changing the project's path identity implementation. Its owned
temporary directory was removed after absolute-path and process checks.

The native UI grouped a real root/reply pair, rendered Markdown, required an explicit actor
for receipt mutations, marked a message read, completed and reopened it, and sent a reply with
the actual parent reference. A rejected wildcard assignment retained its draft and created no
message. Switching projects showed neither the first project's messages nor its compose draft;
returning restored the draft, which was corrected and recorded through the real send handler.
The test inspected registered agents, cancelled/confirmed a soft-delete, ran purge and compaction
through their canonical result contracts, and cancelled/confirmed a project-wide clear. The
final store query was empty and no desktop conversation was created. Compact layout had no
horizontal overflow and no renderer errors were recorded; owned cleanup completed.

Mailbox read/maintenance replies now retain request IDs. Five correlation assertions failed
before the route wrapper and passed afterward, without claiming unrelated frames. The focused
mailbox server suites passed 25 tests across four files. Desktop verification passed 186 tests
across 40 files and typecheck passed 127 source files. Model tests cover cyclic/missing-parent
threads, canonical aggregate unread semantics, invalid retention thresholds, duplicate pending
sends, acknowledgement/refusal state and project draft ownership. Draft retention here is
in-process; application restart and independent-window compose conflicts are still pending.
Sending is not claimed to be exactly once after an unacknowledged transport failure. The UI
keeps the text and directs the user to inspect recorded messages before retrying.

The engine uses the freshly built server with other available dependency outputs. This is a
focused native scope, not full workspace/release certification. Evidence is retained under
`.temp_files/desktop-v2-native/mailbox/`. The provider/settings build above also re-passed its
SDD/requirements scope after the standalone health changes.

## Project Kit and TechStack native workflows (2026-10-27)

Project Kit passed the real portable Tauri/WebView2 workflow on
`55b51cc81379-baecef10dcbc`. Its project catalog reads manifests, guides, typed schemas,
tests and source listings without importing executable kit modules or creating conversations.
The fixture module throws on import, making accidental execution observable. Native checks
covered optional nested fields, arrays, Boolean and integer controls, constraints, recorded
revision-verification gating, changed-source refusal, project isolation and an explicit draft
handoff into a previously unopened conversation. Existing text, references and queue delivery
mode survived the append. Verification-history entries were explicit recorded fixtures; this
does not claim an executed kit verification or run. Native cleanup exited successfully.

TechStack passed its focused native workflow on `502e32a54444-5ff5072f28f7` with no
conversation sessions. The test performed a real local inventory and checked its persisted
job/snapshot, then used the same isolated canonical SQLite store for explicitly labelled
registry/advisory/model display fixtures. It exercised dependency details and filters, workspace
navigation, distinction between observed evidence and model interpretation, historical trends,
selected remediation review/cancellation and project isolation. Markdown, JSON, SPDX and
CycloneDX reports crossed the native HTTP bridge. Compact layout and screenshots were checked;
the workflow and cleanup exited successfully. Report generation and controls are proven here;
successful disk downloads, live registry enrichment, real model research and package installation
are not claimed by this scope.

The native check exposed setup-mode onboarding being advertised as an available research model.
A regression test using the actual setup provider reproduced that mismatch before the fix.
TechStack now excludes setup and unconfigured providers from both advertised research models
and the research-stage accessor. The same regression passed afterward; the combined TechStack
HTTP suites passed 38 tests. The native fixture also observed the unavailable-model response
and research refusal. Its option-state assertion reads the DOM `disabled` property: the earlier
generic disabled matcher returned false even when that property was true.

Reviewed remediation targets now carry their snapshot identity and selected item details to the
execution endpoint. The server refuses changed targets, rationale, risk or snapshot identity
before calling the package executor. Focused tests cover accepted and rejected requests; they
do not claim native permission prompts or a real package mutation. Existing clients that omit
this optional reviewed-plan contract retain their prior behavior.

The HTTP bridge accepts bounded UTF-8 Markdown only for the TechStack report API and still
requires JSON elsewhere. It preserves the research endpoint's 60-second server deadline with
a 75-second transport deadline. Rust verification passed 15 tests, including real loopback
Markdown/JSON, authentication, scope, redirect and response-size cases. Kit and TechStack load
as independent UI chunks; the project workspace chunk returned below the build warning limit.
Desktop verification passed 200 tests across 42 files and typecheck passed 137 source files.

Mailbox live event refresh separately passed on `0c80e78551ef-baecef10dcbc`: the new thread
appeared before the test clicked Refresh. Its receipt, completion/reopen, reply, refusal/draft,
soft-delete, retention and project-isolation checks also passed with successful cleanup.

These packages rebuild the server and standalone engine while reusing other available workspace
dependency outputs. They are focused native evidence, not full current-source release certification.
Kit parameter drafts across restart, full execution diagnostics, larger dependency inventories,
cross-window job discovery and the remaining external-service workflows stay open.

## Native dead-code cleanup and shared-package follow-up (2026-10-27)

Portable package `120c1486fe53-5ff5072f28f7` passed the focused Project Kit, TechStack and
dead-code workflows with successful isolated cleanup. The dead-code case scanned actual
TypeScript files, selected an unused declaration, inspected its exact diff, cancelled the
execution confirmation without writing, then explicitly applied it with verification disabled.
The remaining referenced declaration survived. Result and scan scope remained project-owned
after navigation; another project did not inherit them. The test exercised backup review,
cancelled restoration, a newer-file conflict refusal and an explicitly confirmed overwrite that
restored the original bytes. It created no conversation sessions.

The first native restoration attempt exposed a UI result interpretation defect. The engine
returns the pre-restore conflict list even when force restoration succeeds. The desktop initially
treated that list as unresolved and kept the conflict prompt open after restoring the file. The
UI now excludes successfully restored paths from unresolved conflicts. A permanent regression
test covers ordinary refusal, successful overwrite and partial restoration. The same native
workflow passed afterward. No shared dead-code engine change was required.

The desktop suite passed 207 tests across 43 files; the updated dead-code subset then passed
all seven tests. Desktop typecheck passed 141 source files. Three focused existing engine suites
passed 36 tests for dead-code analysis, backup identity and non-UTF-8 fix handling. Rust's 15
tests and formatting checks passed. The native bridge now gives synchronous scan/preview up to
five minutes and apply/verification up to one hour, rather than abandoning them after 30 seconds.
These transport bounds do not create a cancellation API; the canonical dead-code HTTP surface
has no scan-cancel command.

This native apply case deliberately did not run typecheck. Long-running verification, native
rollback, atomic preview-to-apply revision binding, abrupt restart during a write and every
backup lifecycle remain separate acceptance work. In-process operation ownership prevents a
second action from starting merely because its workspace component was replaced; it is not a
durable transaction log across application restart. The package still reuses other available
workspace dependency outputs and is not a full release certification.

## Native Design Studio and complete backend build (2026-10-27)

Portable `024d66601f12-fb834681ae87` passed the focused Design Studio flow with successful owned
cleanup. It activated a real curated kit without conversations, saved scoped light/dark colors,
rejected invalid colors, adjusted semantic radius/density/font/motion controls, checked every
returned token against the canonical resolver, and exercised project isolation and reset.
Output cancellation left no file; an outside-project path was refused. Confirmed CSS output was
written and read back through the real native file bridge. Design verification displayed actual
file results and the count of files with no signal; absence of signal was not counted as a pass.

The native output test exposed an incorrect `files.read` payload in the new desktop workflow.
The shared route requires `filePath`; the desktop sent `path`. The production action now uses
the canonical field, and an integration test exercises materialization followed by file readback
through the actual server handlers and desktop operation dispatcher.

An earlier tuning assertion hardcoded a radius value incorrectly. It was corrected to compare
the requested semantic knobs against the canonical resolver; this was a test expectation error,
not evidence of a stale compiled resolver. A complete backend dependency-closure build and
standalone engine build subsequently passed. These builds do not certify full repository tests,
coverage, hosted CI or a signed release.

## Native project tools and Chimera review tracking (2026-10-27)

Portable `5b5a6df7b677-488fe7d2d8b6` passed focused Project Kit, TechStack, Dead Code and Chimera
flows through the compact Project tools menu, each with final `native-result.json` and successful
owned cleanup. The menu keeps Memory, Kanban and Atlas prominent and provides a keyboard-native
expandable list for the secondary project tools. The engine includes the complete freshly built
backend dependency closure.

Chimera used explicit recorded fixtures from two different core sessions. It listed both without
an open conversation, preserved report-specific notes through project changes, appended a note
exactly once, filtered reports/findings, and recorded triage, work, false-positive resolution and
reopening through actual stores. Parent report completion/reopening was observed on disk.
Report decision cancellation left its lifecycle unchanged. Full Markdown reports and claimed vs
observed checks were readable; citation verification was labelled separately from defect confidence.
The 800 px screen/document checks passed. Follow-up preparation preserved an existing native
conversation draft and did not send it or mark the report actioned. This is recorded-data UI and
lifecycle evidence, not a live LLM review.

The route now correlates all Chimera replies and accepts explicit `projectWide` catalog scope
independently of an incidental carrier session. Legacy explicit session filtering remains intact.
A native test control initially omitted the carrier identity while assuming it was injected by
the raw test RPC; it now supplies the explicit identity. The production route tests cover both
scopes and read errors. Focused Chimera suites plus the design output integration passed 22 tests
across four files. After adding review-policy source, the full desktop suite passed 220 tests in
46 files and desktop typecheck passed 152 source files. Native review-policy acceptance remains
separate until its focused run completes.

Portable `8e3d18db0454-488fe7d2d8b6` subsequently passed the combined focused review-policy and
Chimera flow with successful cleanup. The profile test saved every exposed review-policy field,
checked canonical preferences and extension configuration on disk, retained an unrelated
concurrent iteration-budget change, rejected an invalid delay and restored the values after
UI reload. Named profile selection cleared explicit reviewer overrides, and editing the model
cleared the profile. File limits above 50 and concurrency above 10 were accepted by the actual
backend; those are not engine caps. The effective fallback chain remains observed read-only
evidence and is marked stale while routing edits are unsaved. No LLM review was launched.

The final review package `00cc779eeee5-488fe7d2d8b6` passed the same native flow again, including
the additional guard that prevents deleting a named fallback profile still selected by continuous
review. The final native result was written after owned cleanup completed. Desktop and server
typechecks passed 152 and 309 source files respectively; targeted formatting/lint checks passed
without warnings, and the documentation check found no missing local links.

The focused Design Studio scope also passed on `00cc779eeee5-488fe7d2d8b6` through the new
Project tools menu, including theme editing, output/readback and project isolation; its final
result was written after successful cleanup. These focused scopes do not replace the standard
and companion full-native matrix, external-provider acceptance, full coverage or release gates.

## Native session inspection and reviewed checkpoint recovery (2026-10-27)

Portable `4ff8fd9135af-aba56b267e17` passed the focused `--recovery` flow, with both portable
checksums verified and a final result written after successful owned cleanup. The backend dependency
closure and standalone engine were rebuilt before packaging. The session workbench exposes History
& recovery through its contextual Tools menu, without adding controls to the resting composer.

Two real engine turns used the authenticated isolated loopback model fixture. The second response
was deliberately held: the desktop disabled checkpoint review and the server refused a raw rewind
request while the run was active. After completion, the workspace inspected the actual journal,
searched recorded event previews, showed prompt checkpoints and verified four retained messages
and 210 journal usage tokens. These differ from raw message-event counts and cached session-summary
counters; the desktop now requests the actual retained transcript length and loaded journal usage.

Explicit file-snapshot fixtures were seeded only after both turns stopped writing their journal.
The fixture model did not edit project files. Cancelling rewind retained the actual file bytes.
A later journal append invalidated the reviewed checkpoint; the confirmation was refused and
preserved the file. After refresh, confirmed rewind restored both recorded edits of the same file
to their original bytes, truncated later journal events, replaced the displayed/live conversation
and kept the separately saved composer draft. Retained-message and journal-token counters both
became zero. A second recorded snapshot outside the project was refused by the real rewinder;
the outside file remained unchanged, and the desktop explicitly showed that the conversation
had been rewound while a file restoration error still required attention.

The first native harness attempted a backend session-resume command; the native host correctly
refused it because desktop owns session lifecycle. That guard remains intact. Another fixture
attempt appended snapshots between turns; the live writer's later writes displaced the injected
records. The harness now seeds historical file evidence only after model activity ends, and
asserts actual restored bytes without weakening its original restoration requirement.

The route correlates inspect/checkpoint/rewind replies, reports checkpoint read failures and
provides an optional SHA-256 journal revision. Desktop confirmation checks a fresh checkpoint
snapshot and sends the expected revision; the server checks it again under the runtime session
transition gate. Existing clients may omit this optional revision. Rewind responses include actual
restored paths, file errors, removed events and retained-message count. A replacement replay is
sent even for an empty conversation. Before the fix, the desktop projection retained discarded
answers; its regression test failed on that assertion and now passes for empty/nonempty replacement
replays, while foreign-session frames and resets without a replay retain their existing isolation.

Repeated checkpoint indices use the engine's first recorded boundary, with snapshot counts
deduplicated by index for presentation. Counts remain snapshot entries rather than a unique-file
preview. The 800 px screen/document checks passed, no renderer errors were recorded, and the
history, successful recovery and partial-restoration states were captured for visual inspection.
The complete desktop suite passed 224 tests across 47 files; six focused backend suites passed
89 tests. Desktop/server typechecks passed 154/309 files, targeted Biome checks passed without
warnings, and the documentation link check passed.

This proof does not establish complete transcript search, project history/fork/resume/story,
redo, crash-durable recovery-operation state, full native standard/companion certification,
external-model quality or the release matrix. Journal revision checks and the runtime gate do
not make project-file restoration atomic against independent filesystem writers. Rewind follows
the engine's recorded snapshot semantics and can overwrite later manual edits; it is not a full
project backup or a Git checkout.

## Project conversation library and retained transcript (2026-10-27)

Portable `ff21d03a8ad8-920113da43c7` passed the focused `--history` and
`--history --companion` native scopes. Both verified the bundled checksums and wrote their final
PASS results after successful owned cleanup. The backend dependency closure, standalone engine,
Vite assets and Tauri release executable were rebuilt before these checks. This probe package
does not replace the installed application or the portable latest pointer.

The project-owned Session history workspace opens with no desktop conversation. It offers recent
100/200/500-entry catalog windows, summary/provider/outcome filters, recorded-name editing and
read-only transcript inspection. `/sessions` opens this workspace; `/history` remains the prompt
journal. Existing native conversations can be reopened by matching their actual engine identity
within the owning project. Reading an archive never resumes the agent or acquires another writer.

The native fixture used the canonical project session store and catalog registration, with 24
retained messages covering long text, reasoning, tool input/results and attachment metadata.
An early fixture omitted projectRoot and bypassed the catalog daemon; correcting the fixture
restored production-equivalent registration. A separate product defect hid populated journals
whose legacy summary counter was zero. The catalog now optionally supplies canonical emptiness
state; the desktop hides only confirmed empty journals and keeps unknown states visible.

Both hosts verified message paging, complete retained-text search within the selected transcript,
long-text continuation, role filters, no-match controls and revision-based stale-page refusal.
The proof deliberately appended one owned historical message, then required refresh before
continuing. Read and rename operations preserved the journal bytes, apart from that deliberate
append. A peer name change refused a stale local rename; a refreshed edit saved with readback.
Another project could not inspect the same journal. Reads kept the desktop conversation count at
zero. Only the final reuse scenario explicitly created a destination conversation, preserved its
existing draft, appended visible historical text without sending, and returned to that same native
conversation without creating a second writer. Screenshots and 800 px overflow checks passed.

The shared inspect route supports optional transcript-only pages and revision-checked text-block
reads. Pages contain at most 25 messages, 100 blocks per message and 60,000 text characters;
individual text chunks contain at most 16,000 characters and preserve surrogate pairs. Structured
tool input has bounded depth, fields and text. Image/PDF binary data and reasoning signatures are
excluded; PDF extracted text remains readable. The native project service boundary permits only
catalog listing, inspection and recorded-name editing from this family; conversation lifecycle
mutations remain desktop-session-owned and profile services refuse these project operations.

The complete desktop suite passed 228 tests across 48 files. Eight focused backend suites passed
94 tests, and all 15 Rust tests passed. Desktop/server typechecks passed 157/311 source files;
targeted Biome checks and Rust formatting passed. Regression evidence included the initially
refused native read boundary, transcript projection and canonical emptiness behavior.

Remaining work includes new-runtime resume/fork, cross-session full-content search, deeper catalog
pagination, persisted history selection/filters, richer story views, binary attachment viewers,
access beyond 100 blocks per message and full structured tool-input expansion. Compressed and
large-history acceptance were not run. Rename preflight is not an atomic compare-and-swap. These
focused native scopes do not establish the full standard/companion matrix, full coverage, hosted CI
or release certification.

## Reviewed native history resume and fork (2026-10-27)

Portable `d0a7e7e17119-5fa578243a82` extends the project-history scope with explicit Resume and
Continue a copy actions. Both use a separate native `session.restore` command. Missing sources,
alternate workdirs, invalid identity paths and unsupported modes are refused before tab creation.
The registered project root determines storage ownership. An older bundled-engine session host is
refused before dispatch, rather than accepting optional arguments and opening an empty conversation.
Existing conversations remain running; transferring them to the newer host is not implemented.

The desktop engine adapter explicitly handles the history boot arguments. Fork uses the canonical
session-store implementation, closes its temporary catalog client, and then reopens the child
through the shared backend's ownership-controlled resume handler. Resume uses the same handler for
the original identity. A private, authenticated loopback connection performs only that one request.
The native host waits for verified replay and operation acknowledgement before exposing its engine
transport. Startup errors become session errors; no blank-conversation fallback is used. Legacy
resume acknowledgements omit requestId, so they are accepted only on this dedicated single-request
connection. Explicitly foreign request IDs are ignored. Binary credentials stay in the native host.

The focused standard and companion native flows passed on this package, with checksum verification
and final results after owned cleanup. Each exercised cancellation without creating a tab, fork
with a different actual engine identity and an unchanged parent journal, and resume with the exact
original identity and retained messages visible in chat. A second resume was refused without an
engine transport or changes to the source journal. Engine event journals contained no new desktop
user-message frames from opening either conversation. Both operations use current project files;
they do not materialize historical workspace snapshots.

The first native attempt exposed a missing compatibility path for uncorrelated resume replies and
timed out waiting for readiness; the adapter now handles that legacy response shape. A subsequent
attempt reached the restored chat but the test expected only the first sentence of a longer linked
message as an exact text match. The locator was corrected while retaining the transcript assertion.
The complete desktop suite passed 231 tests across 49 files, including private-connection controls
for foreign replies, missing replay and ownership failure. All 17 Rust tests passed, desktop
typechecking passed 158 source files, and targeted Biome/Rust formatting checks passed. The backend
dependency closure, standalone engine and Tauri release executable were rebuilt.

This fixture has no configured model provider: restored agent identity, history, draft separation
and writer exclusion are verified, but a newly submitted model turn after resume/fork was not run.
The forced companion scope uses the current bundled engine; real older-host rejection is covered
by the version-boundary test rather than an installed-old-binary native scenario. Full native
certification, coverage, hosted CI and release publication were not run. The immutable probe package
does not update the installed application or the portable latest pointer.

## Cross-session retained-text search (2026-10-27)

Portable `4cd69245f32e-67fc1959e29e` adds a collapsed Search across conversations workspace to
project Session history. Searching is explicit and reads the selected latest 100/200/500-record
window independently of summary/provider/outcome filters. It reports progress, matching conversation
and message counts, and unreadable records. Results contain at most three plain-text excerpts per
conversation. Each selected result opens the matching retained message with the same query and
role filter, after verifying the transcript revision. Normal summary selection clears that search.

The shared `sessions.list` read path accepts an optional contentSearch payload. Each request reads
at most five project-owned journals sequentially. Continuation requires a revision of the candidate
identities, query, role and window; catalog changes refuse a mixed continuation. Stop invalidates
pending UI results and prevents further batches, while the current server read batch may finish.
No model turn, resume, writer acquisition or binary-attachment transfer is involved. Search uses
the canonical retained-message projection, rather than matching superseded raw journal events.
Different journals can change between batches: this is not a project-wide transactional snapshot.

The standard and companion native history scopes exercised six additional persisted conversations
and the original multimodal/long-text fixture across multiple read batches. Search stopped cleanly
without a late response replacing its stopped state. A shared term found all six archives; an image
base64 term found none, and the user-role filter excluded an assistant-only match beyond the normal
text excerpt. Selecting that result opened the correct message. A deliberate journal append then
made the same saved result stale: reopening refused it, and explicit refresh read the current
transcript. Another project returned no matching archives. Reading retained the zero-conversation
desktop registry until the later explicit draft/resume/fork scenarios. The companion scope also
checked the expanded search at 800 px without screen or document overflow. Screenshots were
captured for visual inspection. Existing history, rename, draft reuse, resume/fork and duplicate
writer refusal checks remained in the native scope.

Disk-backed backend tests cover stable continuation, changed query/catalog refusal, unreadable
records, role controls, deep-text excerpts, excluded image bytes and replaced history, exact match
counts and the three-excerpt cap. The complete desktop suite passed 231 tests across 49 files;
nine focused backend suites passed 98 tests. Desktop/server typechecks passed 159/312 source files,
and targeted Biome checks passed without warnings. The backend dependency closure, standalone
engine and Tauri release executable were rebuilt. Rust product source was unchanged in this round.

Search beyond the latest 500 records, full-text indexing, deeper catalog paging and durable search
preferences remain open. Loading an individual very large journal is not interruptible through
this API, and compressed/large-history acceptance was not added. These focused scopes do not
replace full native certification, coverage, hosted CI, external-provider acceptance or release
publication. The immutable probe package leaves the installed application and latest pointer alone.

## Profile model visibility and favorites (2026-10-27)

Portable `b767f08989ba-67fc1959e29e` passed the focused native `--models` scope, including the new
profile Model visibility workspace and the existing model-definition/key lifecycle scenarios.
The Tauri release executable and frontend were rebuilt; the unchanged bundled engine from the
previous round was reused. No dependency or installed-application update was performed.

The workspace opens without a conversation and lists saved-provider catalogs with disabled entries
included. Search and enabled/disabled/favorite filters leave model definitions intact. Exclusion
changes use the parent profile draft and explicit Save settings flow. A review lists affected
favorite, default fallback and named fallback-profile references before disabling a model. Bare
routing references are removed only for their default provider; other provider references and
explicit role overrides remain. Enabling reviews matching exclusion rules and explains the wider
effect of removing a bare model rule. Removed favorites/fallback references are not automatically
recreated. Persisted exclusion rules remain editable when their models are absent from the catalog.

The real native flow cancelled an exclusion, applied another only to the draft, and verified that
the engine catalog stayed unchanged until Save. After saving, ordinary provider.models reads
excluded the model while includeDisabled retained it for administration. Disk configuration and a
fresh settings mount retained the exclusion. A concurrent peer edit refused a stale enable write
without losing the peer's rule. Reload/review then enabled the model while preserving unrelated
rules. Favorite persistence and discarded orphan-rule removal passed. Settings and catalog reads
kept the desktop conversation count at zero. The 800 px document overflow check passed and
screenshots were inspected; input/select styling was aligned with the desktop theme before the
final package rerun. Final native results were written after successful owned cleanup.

Session model controls filter disabled providers/models and rank favorites from their own runtime
preferences. The browser-only reference matcher is tested against the engine's canonical grammar,
including bare, qualified, spaced and slash-containing model IDs. Exclusion wins over favorite
ranking, and source catalog order is preserved. The complete desktop suite passed 235 tests across
50 files; all 17 Rust tests passed, desktop typechecking passed 161 source files and targeted Biome
checks passed without warnings. Rust and backend product source were unchanged in this round.

Separate running engines do not yet receive automatic policy synchronization; this workspace
changes profile defaults and does not switch an existing session's model. Composer ranking and
exclusion were covered by focused logic tests, not a new native chat-picker interaction in this
round. Provider-wide visibility editing, bulk model actions, external-provider policy acceptance,
atomic compare-and-swap saves and complete settings parity remain open. The native flow verifies
read-before-write conflict refusal and readback, not an atomic cross-process transaction. Full
native/companion certification, coverage, hosted CI and release publication were not run.

## Subscription authentication UI and attempt ownership (2026-10-27)

Portable `0c1554b5f6ad-e968137cc424` adds a registry-driven subscription authentication workspace
to provider settings. It supports reviewed default/new named connection targets, reconnecting
saved subscription accounts, browser and device-code presentation, explicit external-browser
opening, transient password-style callback/code paste, cancellation and saved-credential readback.
OAuth credential entries show their authentication method and optional expiry and use the existing
verified local key-removal workflow. Local removal does not revoke provider-side browser sessions
or tokens. Existing sessions are not switched automatically after authentication.

The provider route now correlates OAuth list/status responses. Optional attempt identities bind
desktop start/code/cancel requests to one login, including background completion statuses. Stale
code and cancellation requests cannot complete or close a replacement attempt. Legacy clients
without these fields retain their prior protocol behavior. The desktop ignores foreign/old
same-service attempts, freezes terminal states, fences overlapping action completions, cancels its
owned attempt when the panel detaches, and clears manual input on submission/cancellation. The
opaque attempt-id validator was tightened after a test showed that the generic config-key grammar
accepted a path-shaped identity. Saved-provider projections expose only method/expiry metadata in
addition to their existing masked keys; access and refresh tokens remain excluded.

The focused native models scope passed with the rebuilt dependency closure, standalone engine and
Tauri release frontend. It used the real built-in ChatGPT authorization flow only to create a local
PKCE/loopback interaction: no sign-in website was opened, callback code submitted, token exchange
performed or live account authenticated. Registry discovery, alias collision refusal, review/cancel,
browser-ready state, stale cancellation refusal, manual-input clearing and panel-detach listener
cancellation passed without creating a conversation or saved test account. Existing model
visibility, custom definitions, key lifecycle and diagnostics checks remained in the scope.
Screenshots were captured for visual review, including the expanded sign-in view at 800 px.

Production-route backend tests inject a controlled authentication strategy at the external-auth
boundary. They verify successful manual completion into the selected named account, request/attempt
correlation, stale code/cancel refusal, owned cancellation, malformed-id refusal and token-free
credential metadata. The existing cancellation/persistence and provider-route/projection suites
also pass. The complete desktop suite passed 237 tests across 51 files; four focused backend suites
passed 78 tests. Desktop/server typechecks passed 163/312 source files and targeted Biome checks
passed without warnings. Rust product source was unchanged.

Live browser/device authentication, automatic refresh, successful native account readback and
OAuth refresh-token encryption acceptance still need real-account or dedicated local-provider
fixtures. Device-code rendering and remote authentication were not exercised by the native browser
startup scenario. Pending authentication is not restored after a renderer/process crash; cancellation
does not roll back a credential write already committed. The protocol has no provider-side revoke
operation. Full vault lifecycle, companion/full-native certification, full coverage, hosted CI and
release gates remain open. This immutable probe does not replace the installed application or
portable latest pointer.

## Provider-wide visibility and hosted catalog filtering (2026-10-27)

Portable `706943207f19-1c2f4c54a480` passed the focused native models scope with a dedicated
provider-level control inside Model visibility. The reviewed action changes only disabledProviders
in the profile draft. It retains credentials, definitions, favorites, fallback chains and individual
model exclusions. Enabling removes every case/whitespace-equivalent exclusion for that provider;
existing model rules still apply. Unavailable/deleted provider rules remain explicitly editable.
Enabled/disabled catalog filters now account for both provider-wide and individual exclusions.

The native proof cancelled a provider review, applied a draft without changing saved preferences,
then saved and verified ordinary catalog exclusion, complete administrative reads, disk persistence
and a fresh settings mount. The saved connection, favorites and both default/named fallback chains
remained identical. A concurrent provider-rule edit refused an old local enable operation and kept
the peer rule. After reload/review, enabling preserved that unrelated rule. Repeated provider
disable/enable retained a separately configured model exclusion; clearing that model rule restored
its catalog entry. An orphaned provider rule was removed through the UI and saved. The existing
model visibility, OAuth startup/cancel, custom-definition, key-management and diagnostics flows
also passed without conversation creation. Final results were written after successful owned cleanup.

A backend regression was reproduced before patching: hosted ACP catalogs returned their models
even when disabledProviders excluded ACP. The enabled control passed, but the exclusion assertion
failed with the actual hosted descriptor instead of an empty list. The hosted early-return branch
now applies the same provider/model exclusion predicate as saved catalogs, while includeDisabled
retains the complete administrative view. The unchanged assertions then passed for provider and
model exclusions, alongside saved-provider precedence controls.

Three focused backend suites passed 76 tests. The complete desktop suite passed 239 tests across
51 files; desktop/server typechecks passed 164/312 source files and targeted Biome checks passed
without warnings. The backend dependency closure, standalone engine and Tauri release executable
were rebuilt. Screenshots were inspected, and the existing 800 px visibility checks remained in
the native scope. Rust product source was unchanged.

Automatic propagation to separate running engines, native chat-picker policy refresh, live provider
execution acceptance and atomic cross-process preference transactions remain open. This control is
configuration exclusion, not credential deletion or an access-control boundary. Focused models
acceptance does not establish the complete native/companion matrix, full coverage, hosted CI or
release certification. The immutable probe leaves the installed application and latest pointer alone.

## Current-profile session choices and durable file workflows (2026-10-27)

The open conversation model picker now reads the current profile service's saved connections,
provider catalog and visibility/favorite policy. It refreshes policy while open and checks the
latest exclusions again before an explicit session model switch. Only these choice-policy fields
are projected; a profile preference frame must not replace session effort, identity or draft text.
Provider/model catalog requests have correlated replies and stale-selection guards. A reducer
regression first failed when a session preference frame erased preceding shared policy in one
batch; the unchanged assertion passed after merging partial preference updates. The actual native
picker initially timed out because providers.list did not echo its request identity; that route
now correlates provider.catalog and failure acknowledgements.

Portable `46472ee45709-9b6bb0afa2fc` passed the complete composer scope. Portable
`94776c39279c-9b6bb0afa2fc` passed the same scope using a companion session host. The actual profile
fixture changed favorites and model/provider exclusions while the picker was open, verified
ordering and re-enabling, and explicitly switched a temporary model and the original model back.
Session effort, draft and identity were retained. No additional conversation or human user-message
frame was created by these settings operations. Both scoped runs also passed ordinary composer,
BTW, queue/reload/drain, stop/steer, refinement, prompt resources, context controls, binary image/PDF
transport, approvals and next-step submission. A queue-after-reload test now waits for the current
panel to be expanded before asserting the retained attachment action; it still asserts real media
delivery and an unchanged provider-call count while the current turn is held.

Unsaved file text now persists in revision-checked per-file records in the native project registry.
The metadata-only recovery list exposes up to 500 recent records; opening one loads its content and
original disk baseline. Missing or no-longer-text source files do not erase recovery content.
Clean/save/discard operations retain revision tombstones. Before a disk save or explicit discard,
pending local writes drain and the stored draft revision is checked. Competing windows receive
an explicit local/stored comparison, with a fresh comparison after a stale resolution attempt.
This check does not make the subsequent project-file write an atomic cross-process transaction.
The existing 2 MiB native form limit includes both edited text and the original baseline.

An actual native navigation assertion failed when moving from Files to Memory and back lost the
open editor. Window-local file tabs now retain their existing draft controller and revision baseline
across project-tool remounts, while other windows still use independent revision ownership.
Portable `10d81a539441-0b72a5a5d912` passed the focused native files scope, including the unchanged
navigation assertion, durable recovery after renderer reload, a real peer write to the SQLite
draft, side-by-side comparison, explicit stored-version recovery, real disk writes/external-change
refusal, rename/move/delete and unified/split Git review with staging. No conversation was created.
The recovery/comparison screenshots were inspected, including the 800 px comparison layout.

The same files scope exercised engine-owned literal UTF-8 content search: actual source text,
folder and case controls, a rejected parent-directory scope, selected-source-line navigation,
and a real 205-line fixture producing 200 visible results with an explicit partial-result notice.
The 800 px search layout was inspected. The engine searches saved text rather than unsaved drafts,
returns bounded line previews instead of full file contents, honors the explorer's root ignore and
hidden/build/dependency policy, skips symbolic links and reports omissions. Limits are 1 MiB per
file, 32 MiB read, 5,000 scanned files, 20,000 directory entries and five seconds. These limits are
not a large-repository completeness or performance certification.

The wider native run also exposed a genuine number-preservation defect: a fractional instruction
revision changed by one floating-point bit through the Rust client. A real loopback Client.call
regression with an integer control failed before enabling serde_json's float_roundtrip feature and
passed afterward. The pinned version remains 1.0.154; its current registry version and supported
[feature list](https://docs.rs/crate/serde_json/latest/features) were checked before the change.
The full Rust suite passed 19 tests. The exact native timestamp assertion was retained, and the
focused settings scope passed instruction save/stale-refusal/reload, actual tool configuration and
availability windows. Cleanup now avoids treating an already-enabled tool's idempotent refusal as
a failed product operation.

The complete desktop suite passed 245 tests across 53 files with --no-fsModuleCache. Three focused
provider suites passed 77 tests; three file-content/routing suites passed five tests against real
temporary files, including scope/ignore boundaries, literal matching, link escape refusal,
oversized/binary omissions and result limits. Desktop/server/protocol typechecks passed
168/313/29 source files. Targeted Biome checks passed. A direct desktop-suite retry exhausted the
parent environment's memory; the owned 12 GiB QA job then passed. The backend dependency closure,
standalone engine and Tauri executable were rebuilt into an immutable portable probe. Installed
binaries and the portable latest pointer were not replaced. Full native-matrix completion,
external-provider quality, full coverage, hosted CI and signed release certification remain separate.

The default complete standard native suite subsequently passed on
`10d81a539441-0b72a5a5d912`, with verified copied checksums and Bun/Node absent from PATH. It covered
the project workspaces, settings and file/search cases above, three concurrent PTYs, renderer and
application restart, multi-project/session ownership, the full composer/media/approval flow,
canonical appearance, actual local-provider execution, saved-key use by a new engine process,
Code Assist and task dispatch. This is standard-host local acceptance; a complete companion-host
matrix, external provider acceptance and release certification are still distinct gates.

## Topic-boundary choice through refinement (2026-10-27)

Portable `839c1e1bdeab-0b72a5a5d912` passed the complete scoped composer suite on both standard and
companion hosts. It now includes the actual canonical topic advisor. The desktop asks only for
idle normal submissions on a supporting engine after five visible user turns; the engine retains
its own history-size, explicit-continuation, overlap and classifier gates. Advice failure continues
without inventing a fresh boundary. Cancel keeps the unsent text; edits made during the check
require a fresh explicit submission. Queue, active BTW and steering never reset the context.

The native fixture supplied real user turns, exercised advice without a human-send frame, cancelled
and verified the unchanged draft, then sent an explicit same-context choice. A fresh-context choice
opened normal refinement, created no human turn before approval, and retained its flag through
Original approval. The actual next provider request contained the canonical context_boundary marker
and excluded the previous topic's user text, while earlier visible chat and native session identities
remained intact. Both normal and 800 px topic dialogs were inspected. The ordinary queue/refinement,
resource/context, image/PDF, approval and next-step cases also passed after this scenario.

The desktop suite passed 246 tests across 53 files, including delivery acceptance with original
refinement metadata and explicit refusal of fresh-context requests on unsupported, active, queued
or steering paths. Desktop typecheck passed 168 files and targeted Biome checks passed. No engine
or dependency upgrade was required for this feature. Classification used the isolated authenticated
provider fixture; it does not establish external-model recommendation quality, full companion
project-workspace coverage, full coverage, hosted CI or release certification.

## Session-owned agent model plans (2026-10-27)

The advanced composer menu now opens an Agent model plan editor for the owning conversation.
It edits the canonical enabled/lock/followSessionModel/slots/roles preference through the session
engine. The concrete-model picker reuses the current-profile policy/catalog workflow with a local
selection callback; it never sends model.switch while editing a lane. Named tier and fallback
references, labels and nested reasoning settings are retained. Removing configured lanes requires
an explicit draft confirmation. Role overrides, label/runtime metadata and disabled/following pins
are preserved rather than replaced by a minimal provider/model object.

The editor keeps a saved baseline, refuses a competing whole-plan write, verifies full normalized
readback and offers explicit keep/discard/reload choices. The engine journals accepted plans with
the conversation. Profile settings are not used to store a conversation's lanes. Existing active
workers do not switch model merely because the future plan changes. Current subagent/companion
permission is reported independently; changing a model plan grants no spawn permission.

Portable `bc017a8deafb-0b72a5a5d912` passed the complete standard-host composer scope including this
new scenario. The native proof seeded real lane/role preferences, edited reasoning, selected a
current-profile lane model, checked that nothing changed before Save, and verified the saved
provider/model plus retained labels/runtime/roles. Following retained the pins; reducing configured
lanes required review. A competing plan update was refused without losing the local edit. Explicit
reload and renderer reload recovered the stored plan and preserved the independently persisted chat
draft. Profile config bytes and the active chat model stayed unchanged. No human message frame or
additional native session was created by plan management. Actual worker execution and cross-session
worker assignment are separate acceptance cases, not inferred from preference readback.

Portable `bf29d92921e5-0b72a5a5d912` passed the complete companion-host composer scope, including
the same plan scenario, topic/refinement flow, resources/context, binary attachments, approvals and
next steps. Its plan, file-recovery comparison and content-search dialogs use viewport-bounded native
dialog geometry. The plan's normal and 800 px vertical bounds were measured and passed; screenshots
were inspected, including its visible save bar. The complete desktop suite passed 248 tests across
54 files, desktop typecheck passed 170 source files, and targeted Biome checks passed.

Two earlier parallel native runs lost their WebView target before completing; their cause was not
established and they are not counted as passes. Serialized standard and companion retries passed.
The harness now records UI process exit/signal and browser connection state on failure. This does
not establish a parallel stress gate. Unsaved plan-editor recovery, atomic cross-process plan writes,
actual worker-routing execution, full companion project coverage and release certification remain open.

## Project Agent Roster (2026-10-27)

Portable `3ecda931611d-8b27c071046d` passed the dedicated `--roster` scope in a real
Tauri/WebView2 window with the bundled engine and portable checksum verification. The scenario
created custom roles in two isolated projects, edited/read back typed runtime policy, selected
models without switching a conversation, preserved unrelated peer budget edits and refused
same-field conflicts. It recovered window-local runtime drafts, saved identity Markdown exactly
on disk, reviewed a competing identity update and retained malformed configuration until explicit
file repair. Profile config bytes remained unchanged by role edits.

The same native scenario taught three structured directives, captured another from agent output,
paused/resumed learning without removing its buffer, verified project/role draft isolation, pinned
a skill, saved its addendum and resolved a custom role inheriting another custom role. The React
Flow graph used two actual base-role edges. Dark/light screenshots and an 800 px overflow check
passed. An authenticated local provider performed real headless consolidation; all four consumed
directives were archived exactly, the active buffer became empty and consolidated knowledge was
read back and explicitly cleared. Typed single-role/all-role resets stayed inside the fixture
projects and retained unrelated source files. No native conversation was created; no renderer
errors or extra frontend pages were observed.

The native run caught a document verification mismatch caused by canonical boundary trimming;
verification now follows loader normalization while the test separately asserts exact disk bytes.
An initial test incorrectly treated consolidation `sourceEntryCount` as consumed-entry count. That
field intentionally records the buffer after pruning for freshness checks; the UI now labels it
accordingly, and the native proof checks the original four-entry count, exact archive and empty
remaining buffer separately. Earlier failing attempts are not passes.

Backend regressions separately reproduced raw-versus-resolved protected-role tool/budget counts
and legacy-versus-structured directive counts, then passed after canonical resolver/parser fixes.
The three roster server suites passed 33 tests; the complete desktop suite passed 250 tests across
55 files. Desktop typecheck passed 175 source files, server typecheck passed 313 files, Rust tests
passed 19 tests and targeted Biome checks passed. Unsaved secondary forms persist within a window,
not across application restart. Cross-process writes are preflight checked rather than atomic.
Actual worker execution, live fleet topology, knowledge-checklist editing, full companion roster
coverage, full coverage, hosted CI and release certification remain unverified.

## Automation management and evidence (2026-10-27)

Portable `f2ef747dcce9-8b27c071046d` passed the first dedicated native `--automation` management
scope. Portable `47da535684d4-8b27c071046d` passed the expanded scope with the bundled engine,
checksums verified and no Bun/Node dependency in the launched application's PATH. Real Tauri UI
actions reviewed a canonical template, chose a profile model without changing profile config,
authored a reusable environment, refused an invalid cache path, preserved the form on close,
and applied it to the local job draft without creating a stored job. Setup argv, service health
checks and environment-name references, caches, ports and deadlines were saved and read back
through the real project management API. Credential references, GitHub event filters and
verification commands/deadlines survived the same round trip. Preview exposed missing references
without launching a worker or model request.

Two job drafts and two projects retained independent window-local edits. Dirty jobs could not
queue their older saved revision or toggle its enabled state. A competing server revision was
refused without losing the local draft; explicit reload recovered the actual saved revision.
The same scenario enabled a job, queued it with the worker offline, cancelled it through the
actual API and inspected its honest missing-result state. Missing artifacts were readable errors.
A malformed verification artifact was refused without crashing the renderer. Presentation-only
fixture files then exercised failed-check identity/duration/exit status and an explicitly unverified
environment receipt with setup/cache/loopback-port details. These files are rendering fixtures,
not Docker execution evidence. The cancelled run could inspect publication state but could not
prepare or publish a plan. No native conversation or external frontend page was created.

The complete desktop suite passed 254 tests across 57 files; desktop typecheck passed 181 source
files and targeted Biome checks passed. The native scenario includes light/dark screenshots and
an 800 px environment-dialog bounds/overflow check; screenshots were inspected. Actual Docker
execution, vault resolution inside a worker, real GitHub webhook delivery, successful PR plan
preparation/publication/update/CI/follow-up, restart durability of these secondary forms and full
release certification are NOT RUN. Publication controls use the canonical evidence/fingerprint
gates and an explicit in-app review; their presence does not establish successful external execution.

## Broader native baseline and fixture traffic ownership (2026-10-27)

Portable `22b61c4d9b75-8b27c071046d` passed the complete default standard-host native suite,
including project workspaces, settings/provider/model management, files/draft/search/review, Atlas,
Chronicle, skills, concurrent PTYs/restart, themes, cross-window draft conflicts, conversation and
composer/model plans/topic choice/resources, attachments, approvals, next steps, Code Assist and
actual isolated task dispatch. This is a local native baseline, not full release certification.
Automations were split into a lazy route: the main project chunk decreased from 512.52 kB to
464.71 kB; the dedicated automation chunk was 48.75 kB in this build.

An earlier full run on `47da535684d4-8b27c071046d` failed an attachment assertion because its
fixture-wide streaming-call count increased during a held media turn. Its retained transcript
showed the media still queued, no early human turn and an independently registered Kanban
supervisor; that attempt did not retain request metadata establishing the additional call's exact
origin. The stricter fixture-wide counter passed on the subsequent complete `22b...` run.
A separate real-loopback HTTP regression then reproduced the counter's inability to distinguish
unrelated streaming project work from tagged composer traffic (RED 2 versus 1, then GREEN).
Attachment checks now use the fixture's literal instruction markers while retaining exact
no-extra-call assertions, plus an explicit no-early-human-turn assertion. Failure artifacts now
record model/stream/refiner/topic/marker metadata without prompt bodies or media payloads.
This does not establish a parallel stress gate. One overlapping automation retry was stopped
by terminating only its exact owned QA runner and is not counted as a pass.

## Profile MCP resources and prompts (2026-10-27)

Portable `81172a2689af-114df4db694e` passed the dedicated `--mcp` native scope with the actual
bundled engine and portable checksum verification. Before any project/session existed, the UI
saved a disabled loopback HTTP MCP connection with an explicit private-network grant, verified its
stored transport/policy, enabled it, completed real JSON-RPC initialization and displayed its actual
tool count. Catalog opening and metadata selection performed no resource read. Explicit reads
resolved a resource and concrete template URI; a server error returned immediately through the
correlated operation. Required/optional prompt arguments reached the server and the resolved text
appeared with role/source labels. Closing reviewed inputs preserved them until explicit discard.
The scenario checked 800 px dialog bounds/overflow, inspected screenshots and removed the fixture
connection. There were zero projects and zero desktop sessions throughout that workflow.

The same native scenario first reproduced a real remote-connection defect: the UI omitted transport,
so the engine tried stdio and failed with `MCP stdio transport requires "command"`. Remote and local
forms now send `streamable-http` and `stdio` explicitly. Canonical server tool lists contain names,
not description objects; the desktop now preserves/counts those names instead of dropping them.
Server errors and untrusted annotation hints have readable presentation.

Two backend tests separately reproduced missing request IDs on selected MCP content and content
errors while the catalog control passed; after the narrow dispatcher correction, the four relevant
MCP/correlation suites passed 59 tests. The desktop suite passed 255 tests across 58 files and its
typecheck passed 182 source files; targeted Biome checks passed. Real external MCP OAuth,
binary content viewing/download, deep catalogs and first-class chat insertion remain
open. Text-only copy explicitly marks omitted non-text blocks; content is never sent as a user
message merely by browsing or resolving it.

## MCP connection edits and session tasks (2026-10-28)

Portable `ac9fbf84af09-114df4db694e` passed expanded native `--mcp` acceptance. The connection
editor saved a description while retaining a peer's endpoint update and exact hidden fixture
environment/header values, permissions and private-network policy. A competing description was
refused with the local draft retained until explicit reload. The existing content success/error,
compact and theme checks passed with zero projects/sessions in the profile workflow. This does
not cover OAuth or secret administration.

Portable `30fc040aa455-326645085c45` passed the initial native `--mcp-tasks` scope. A real modern
HTTP MCP peer received one tool invocation following the actual session permission review.
The desktop listed its local receipt, hid the remote task ID, prevented duplicate observation,
isolated a second session, preserved owner identity over UI reload, and requested cancellation
only after review. The peer received exactly one cancellation and the engine collected its final
cancelled state without replaying the tool. An expanded run on the same portable passed a real
JSON-RPC polling-error case: the receipt remained undelivered, its observer lease released, and
the UI requested observation recovery through the canonical permission gate. The original remote
result was collected with exactly two total tool invocations for two tasks, rather than replaying
either tool. The compact screenshot was inspected. No seeded task journal or WebUI frontend was
used. An intervening test retry reloaded before the
debounced native layout persisted its selected owner and restored the other session; the proof
now awaits actual persisted owner selection before reload, rather than relying on click timing.

Portable `c86e84d3c467-ed44fc062628` passed the expanded task scope including native elicitation.
This first failed on the real motor with `MCP interaction requests an unsupported or unadvertised
client capability`: the standalone backend never installed an elicitation handler. Its registry
now uses the canonical form adapter with the invoking run's requester, without a pre-context
root fallback. A durable construction/wiring assertion failed before this fix and passed after.
The native UI displayed Needs input, returned to the owning conversation's real question form,
submitted the branch value, observed exactly one actual `tasks/update`, and collected the final
result. Three scenarios caused exactly three total `tools/call` requests. The question screenshot
was inspected. Four covering backend bootstrap suites passed 30 tests; six MCP suites passed 81.
The current desktop suite passed 259 tests across 60 files and typecheck passed 187 source files.

The same portable passed expanded `--mcp` acceptance, including the profile-only connection and
content cases followed by a dedicated native composer session. Catalog browsing made no resource
read. Explicit resource and prompt resolution then appended source-attributed text to an existing
draft without replacing its prefix, creating a human turn or invoking a remote tool. Prompt role
labels remained ordinary draft text. UI reload retained both selections through the actual native
draft store. The normal submit controls remain responsible for sending, refinement and delivery.
Two content-projection tests cover wrong-source refusal, embedded text, binary omission labels,
binary-only refusal and the UTF-8 256 KiB selection limit. Binary attachment insertion is not
implemented by this text workflow.

The native proof exposed real root session IDs in `YYYY-MM-DD/sess_...` form being rejected by
MCP task handler/subscription validation. Both valid-owner cases failed before the correction;
shared validation now accepts a single safe date/session separator while retaining exact owner
resolution and rejecting traversal, encoded separators, backslashes and extra path segments.
The two handler/subscription suites passed 22 tests. Desktop tests passed 257 across 59 files;
desktop typecheck passed 185 source files and server typecheck passed 314.

An accidental root `typecheck` also invoked the root build while an engine build was running;
the overlapping engine output was discarded. Root typecheck failed with seven errors in two CLI
test files outside this desktop scope (`bench-menu.test.ts` and
`wrongforge-leader-provider.test.ts`). No base comparison established when those errors began.
The roster handler's direct production dependency on the private workspace agent-catalog was
moved from devDependencies to dependencies without changing its version; frozen installation
passed. A subsequent serialized engine build and the native task proof passed. Full root
certification, hosted CI, release/install/signing gates and external services remain NOT RUN.

## Session-owned process inspection (2026-10-28)

Portable `40f15229bf7c-6982289680b8` passed the initial dedicated native `--processes` scope.
Portable `e25216eab549-9c37a37d752f` passed the expanded scope with styled theme controls and
operation-time process identity checking. The UI began with an empty owned registry and created
no process by opening it. An actual approved `bash` tool launched an isolated Windows background
command; the desktop displayed its command/PID/tool/start-time and background status and read
its registered log through `process.output`. Explicit refresh awaited the shell's first output;
the UI never claimed that an empty first read was a live output subscription. The line-count
choices follow the canonical endpoint's 200-line maximum.

A second real conversation could not see the first conversation's process. Keeping the reviewed
termination dialog open left that process running; confirming termination used `process.kill`,
waited for registry disappearance and separately verified the actual owned OS PID had exited.
Light/dark and 800 px screenshots were captured and inspected. The test used an absolute Windows
PowerShell path because the bundled acceptance environment deliberately removes development
runtime paths and therefore selects cmd when no PowerShell is discoverable. Earlier fixture
attempts without provider setup or with unresolved shell commands were setup failures, not native
passes. One premature overlapping runner produced no result and is also not counted as a pass.

Three actual-handler tests reproduced missing request IDs on list/output/termination replies;
the narrow route correlation change restored them. A separate regression reproduced termination
of a replacement PID despite a mismatched reviewed start time. Optional `expectedStartedAt` now
checks identity inside the canonical output/termination operation, preserving legacy requests
and existing permission/protected-process policy. Matching and replaced identities have durable
tests; the three process suites passed 24 tests, followed by a five-test rerun after fixture
isolation cleanup. Desktop tests passed 261 across 61 files, desktop typecheck passed 189 source
files and server typecheck passed 314. Batch termination, richer exit/history records, browser
preview controls, long-running stress and full release certification remain separate work.

An additional incorrectly scoped root test command was interrupted and is NOT a full-suite
result. Focused reruns identified stale content-search protocol counts and an incomplete container
stub in host-seam acceptance; the original protocol iteration and cross-host assertions are retained.
The two focused protocol/host suites subsequently passed nine tests. The protocol inventory now
asserts all 299 client and 310 server entries, including content search and task notifications.
The CLI's WebUI response-consumer guard passed with the desktop-only content-search reply
explicitly documented; it does not imply that the WebUI implements the native search workflow.

## Refreshed complete standard-host native baseline (2026-10-28)

Portable `e25216eab549-9c37a37d752f` passed the complete default standard-host native suite after
the MCP content/task and process changes. Its final result was written only after test cleanup
completed; the owned QA job exited zero. The bundled binaries/checksums were verified and the
launched app had no Bun/Node on PATH. The run covered project workspaces without conversations,
SAGE/candidates/doctor and separate vector status, Kanban, Atlas, Chronicle, settings/provider/model
management, profile visibility/OAuth fixture handling, files/search/drafts/Git review, skills,
three concurrent PTYs/restart, all canonical palette pairs and theme persistence, two-window draft
conflicts, chat/clarification, model/effort and session model plans, explicit topic boundaries,
BTW/queue/steer/refinement, prompt/context tools, actual image/PDF transfer and extraction,
approvals, next steps, Code Assist, actual task dispatch and saved-provider reuse by a new engine.
The separate process scope also passed this portable; MCP content/task scopes passed the earlier
`c86...` portable as recorded above. This is focused local native acceptance and a broader local
standard-host baseline, not complete WebUI parity, a fresh companion-host certification, full
coverage, hosted CI, external-service proof or release/signing certification.

## Project Live fleet (2026-10-28)

Portable `934a8f4e5bae-9c37a37d752f` passed the initial dedicated native `--fleet` scope.
Portable `39c20763ea1b-9c37a37d752f` passed expanded acceptance with verified native session names,
recent activity reading, subject/priority controls, and themed graph controls. The actual bundled
engine and portable checksums were verified. Before any human conversation existed, opening Live
fleet showed no conversation runtimes and created no conversation or worker. Three actual native
conversations in two projects then proved exact project filtering and private project-service
carrier exclusion. A real model turn supplied recorded leader activity; no fake registry entries
or fabricated agent relationships were inserted.

The list and React Flow graph showed real session membership. Native labels came from matching
live host identities to desktop session titles. The inspector read process/heartbeat and agent
counters, explicitly fetched the selected session's actual journal, and rendered its user and
assistant messages. Tool arguments/output have structured, expandable presentation; recent
activity is a bounded read rather than a claim of complete agent-scoped history. Selecting an
agent still labels the journal and mailbox controls as session-level operations.
The native journal fixture contains text messages; richer tool-event expansion needs separate
native acceptance beyond the reused structured viewer's existing coverage.

Keeping an instruction review closed sent no message and retained the session-owned draft.
Explicit confirmation produced one actual mailbox note with the reviewed subject and normal
priority; another session's mailbox contained no copy. A separately reviewed cooperative interrupt
produced its canonical control message. The UI verifies the hashed leader recipient and records
delivery receipts; these tests establish mailbox delivery, not execution, read acknowledgement or
successful interruption. Runtime identity is preflight checked, not atomically bound by this API.
Light/dark and 800 px screenshots were captured and inspected. The final test cleanup succeeded.

Desktop tests passed 265 across 62 files and typecheck passed 192 source files. Targeted Biome
checks and documentation links passed. Projection tests cover project path normalization, carrier
exclusion, disjoint graph IDs, canonical mailbox tags, malformed records, duplicate identities
and invalid counters; the duplicate/malformed case was observed failing before the guard.
The map explicitly caps rendered runtimes/agents and retains the complete loaded list. Large-fleet
performance, delegated-worker ancestry, agent-specific controls, council, side effects, restart
durability of operator drafts, interrupted-run outcome verification and a fresh full release matrix
remain open. No WebUI frontend was opened or imported.

## Session side-effect audit (2026-10-28)

Native bundled identity `628fa33912ab-5ab6516e4f88` passed the processes scope,
including the dedicated Side effects view under conversation Tools. Portable checksums were
verified. This is an isolated native QA artifact, not an installed application update or release.

A real approved background bash command produced its actual shell audit record. The inspector
showed recorded input and launch outcome; kind/search/sort controls, an empty second session,
and switching back to the owner were exercised. Clipboard instrumentation delegated to the real
clipboard API; the CSV success notice and written content were checked. The download test read
the actual newly created CSV file. Desktop and 800 px screenshots were inspected, including dark
mode; panel-width assertions cover long recorded input without horizontal overflow. The owned
fixture process was terminated and its OS PID was observed gone. No WebUI frontend was opened.

The new regression first failed on the real streaming executor path: background bash returned
its valid PID but never called the audit recorder. The executor closes the iterator on its final
event, so recording after that yield was unreachable. Moving the launch record before the final
yield made the same test pass; all 38 bash-spawn tests passed. The per-session introspection
regression also first failed on missing request correlation. The response now preserves the
request ID and reports retained-runtime totals plus explicit truncation for the latest 50 rows.
Both introspection suites passed all 16 tests, including ownership and count controls.

Desktop tests passed 267 tests across 63 files. Typecheck passed desktop 194, tools 372 and
webui-server 314 source files. Targeted Biome checks passed. The engine dependency build and
native Tauri build passed. Full repository certification and hosted CI were not run for this
increment. Counts describe retained runtime memory, not complete persisted journal coverage;
project-wide aggregation, persisted audit paging and richer outcome updates remain open.

The preceding Live fleet source was committed separately as `49887b138` (eight files). At the
user's explicit request, only that commit skipped the shared architecture report writer/staging
block; other applicable hook guards ran. The temporary hook was removed and `.githooks` restored.
The subsequent audit-screen increment remains uncommitted alongside preserved desktop work.

## Collapsible Code Atlas boundaries (2026-10-28)

Bundled native identity `a2087fc689cb-5ab6516e4f88` passed the focused `--atlas` scope.
Portable checksums were verified and native renderer errors were empty. The test indexed actual
fixture project files through the visible Index project control, without creating a desktop
conversation. The Subsystems view collapsed and expanded indexed groups, selected a real member
into the existing node inspector, and displayed the actual directed alpha-to-beta reference.
Search-to-empty and recovery, collapse-all, dark mode and an 800 px layout were exercised.
Desktop and compact screenshots were inspected. A group with more than 160 indexed files was
expanded under Smart scope, switched to All nodes to verify every canonical file was rendered,
and collapsed back to one container. This establishes the tested fixture, not large-codebase
performance certification.

Projection tests distinguish reverse references and relation kinds, count underlying records
separately from summed weights, exclude unavailable endpoints, recover internal references on
expansion and protect original/container identities from collisions. Current Atlas filters apply
before projection. Grouping uses indexed group labels; inferred communities and cross-scope paths
remain open. New arrow markers are opt-in, preserving other graph consumers' default rendering.

Desktop tests passed 269 tests across 64 files; typecheck passed 196 source files. Targeted Biome
checks and the Tauri release build passed. The attempted broad native standard run was interrupted
when its shared `.temp_files/desktop-v2-native` evidence folder disappeared. Its full result is
NOT VERIFIED; the successful focused run above was executed after recreating that folder. The
cause of the folder removal was not established. No full repository release check or hosted CI
was run, and the portable QA build does not update the installed application.

## Fleet and companion profile policy (2026-10-28)

Bundled native identity `666df9b61fde-5ab6516e4f88` passed `--fleet-policy` with verified
portable checksums and no native renderer errors. The seven controls cover concurrent agents,
shared fleet-chat detail, next-step prediction, nextsteps tool availability and the three
Memory/Explore/Skill Companion eligibility switches. The native settings workflow ran while the
registry contained zero projects and zero conversations; the general harness registered its
unrelated project fixtures only afterwards. No companion execution is inferred from these settings.

The real profile API and on-disk config agreed after explicit Save. The test verified a concurrency
of 64, five independent boolean edits, chat detail, draft retention across section navigation,
invalid fractional input refusal, draft discard, and reload persistence. A competing update to
concurrency 96 caused a stale editor's proposed 128 to be refused; the reload action recovered the
actual saved value. Companion toggles retained the seeded Explore probe ceiling of 600000 calls,
18000000 ms deadline and per-signal configuration, Skill enforce/candidate settings and unrelated
fleet lifecycle configuration. No UI cap of 50 was introduced.

Desktop tests passed 271 tests across 65 files; typecheck passed 198 source files. Targeted Biome
checks and the Tauri release build passed. Light/dark screenshots were inspected; the 800 px case
also asserted no document-level horizontal overflow. The profile read-before-write guard is not
an atomic cross-process transaction. Drafts still follow the existing in-process settings lifetime.
Advanced lifecycle/dispatch/probe editing, Brain, Shadow and remaining security/display policies
stay open. Full repository certification and hosted CI were not run for this increment. The
portable QA artifact does not update the installed application.

## Brain policy workspace (2026-10-28)

Bundled identity `b7551c8d266d-ca81789562d6` passed the focused `--brain-policy` native
scope. Portable checksums were verified and renderer errors were empty. The settings workflow
ran with zero registered projects and zero desktop conversations; unrelated general-harness
project fixtures were registered only afterwards. Brain configuration belongs to the profile
runtime used by this settings screen. No cross-runtime hot update or session decision history
is implied.

The form exposes risk/escalation, deterministic heuristics, single-model quality, decision cache,
monitor response, council thresholds and ledger/replay policy. Read-only evidence shows configured
model references/voters, resolved pool/seats/judge, rule conditions/actions and evidence paths.
Configured council enablement remains distinct from its effective state. Decision-cache counters
are runtime evidence and are excluded from draft conflict checks. Profile search finds Brain by
decision-cache terminology. Model-pool/voter/judge editing, richer monitor/trace controls and
origin-owned decision histories remain open.

The native test changed risk, cache enablement/lifetime/capacity, a heuristic, confidence,
monitor policy, council diversity, failure-denial threshold and replay content, then checked
canonical readback and on-disk configuration. Clearing the optional model timeout removed its
stored override. Existing monitor cooldown and deterministic rules survived the partial patch.
Drafts survived settings-section navigation. A competing risk change was refused by the stale
editor, explicit reload recovered it, and a page reload retained the stored values. Light/dark
and 800 px screenshots were inspected; the compact case checked document horizontal overflow.
These are configuration/persistence tests, not real-model council-quality or decision execution
acceptance. The read-before-write conflict check is not an atomic cross-process transaction;
drafts remain in-process rather than restart-durable.

A production-route regression first failed because Brain config responses omitted the request
ID. Per-request transport decoration now correlates get/set responses and invalid set payloads,
while retaining legacy untagged reads. The regression uses the actual BrainRuntime and observes
its persistence call. Four Brain server suites passed 34 tests. Desktop tests passed 273 tests
across 66 files. Typecheck passed desktop 201 and webui-server 314 source files. Targeted Biome,
engine dependency/compiled-engine build and Tauri release build passed. Full repository release
certification and hosted CI were not run. The portable QA build does not update the installed app.

## Brain model pool, council voters and judge (2026-10-28)

Bundled identity `e6f3a97e038b-30bac16cfbcb` passed the expanded `--brain-policy` scope
with verified portable checksums and no renderer errors. The profile-only workflow still ran
before any project or desktop conversation was registered. A real isolated loopback provider
supplied the saved model catalog; the test observed no additional completion requests while
editing settings. This proves configuration behavior, not council voting quality or execution.

The native editor selected a catalog model, entered a custom namespaced model, reordered the
pool and saved round-robin strategy. It configured a security-lens voter with weight 2.5 and
explicit false veto, a second voter with inherited provider/lens/weight/veto, and an explicit
judge. A simultaneous quorum edit survived the same council patch. Canonical replies and raw
on-disk values matched, and a UI reload retained explicit versus inherited veto. A competing
model-pool change was refused by the stale editor; reload recovered it. Clearing pool, voters
and judge returned them to runtime/pool inheritance. A blank new voter could not be saved.
Desktop/800 px screenshots were inspected and a dark capture was taken. Target arrays use an
ordered, indivisible read-before-write conflict boundary; this is not an atomic cross-process
compare-and-swap. In-process draft retention and restart-durable drafts remain separate.

The first native disk assertion exposed compact string storage for unambiguous references.
Inspection then found a real ambiguity: an inherited-provider model named `org/model` was also
compacted to a string and became provider `org`, model `model` after a new runtime boot. A
permanent regression reproduced this on the actual BrainRuntime persistence/restart path while
an ordinary qualified-reference control passed. The serializer now uses compact strings only
when parsing them returns the identical provider/model pair; ambiguous entries remain objects.
The unchanged reproduction passed after the fix, including pool, voter and judge identities.
Unambiguous persisted references retain their existing string format.

Desktop tests passed 276 tests across 67 files. Two focused core suites passed 40 tests.
Typecheck passed desktop 203 and core 633 source files. Targeted Biome, engine dependency and
compiled-engine build, and Tauri release build passed. Full repository release certification
and hosted CI were not run. The portable QA artifact does not update the installed application.
Advanced derived-seat overrides, monitor/trace controls, origin-owned decision inspection and
real provider/council outcome acceptance remain open.

## Brain monitor and replay-trace configuration (2026-10-28)

Bundled identity `2a8df69f7224-12f87dc13cdd` passed the expanded `--brain-policy` native
scope, including prior model/council workflows. Portable checksums were verified and renderer
errors were empty. The profile settings tests ran before project/conversation registration.
No additional model completions were recorded during monitor/trace configuration.

Controls cover each of the four monitor signals, eight failure/storm/stall/churn/cooldown
thresholds or windows, and a newline-based replacement list of file-edit tool names. The patch
builder now handles nested field paths. Because the canonical monitor API replaces its signals
field, the UI preserves the complete latest signal map before applying reviewed edits. Unit
coverage retains an unrecognized signal and an independent concurrent signal edit. The native
case changed two signals while preserving the other saved/independently updated switches.
A competing edit to the same failure threshold was refused and explicit reload recovered it.

Replay configuration now exposes JSONL destination and actual open-record capacity. The runtime
snapshot publishes maxOpenRecords additively, allowing a preconfigured capacity of 777 to appear
without a guessed UI default. The native case saved capacity 512 and an owned test destination,
verified canonical/on-disk readback and UI reload, and cleared the destination back to automatic
selection. Clearing the edit-tool list persisted an explicit empty list; it does not mean inherit.
An invalid zero trace capacity did not persist. Edited monitor numbers remain explicit overrides;
individual inherited-default reset controls remain open rather than sending unsupported nulls.

Brain group shortcuts were exercised by jumping to the Runtime monitor heading, and global
settings search found Brain via stall terminology. Desktop/800 px screenshots were inspected;
dark mode was also captured. These tests establish configuration and persistence, not actual
monitor intervention outcomes, trace-file output/permission handling or real-model council
quality. Read-before-write checks are not atomic cross-process transactions.

Desktop tests passed 279 tests across 67 files; two focused core suites passed 41 tests.
Typecheck passed desktop 204 and core 633 source files. Targeted Biome, compiled engine/dependency
build and Tauri release build passed. Full repository release certification and hosted CI were
not run. The isolated portable QA artifact does not update the installed application.

## Execution confirmation policy (2026-10-28)

Bundled native identity `d92d0707aef0-12f87dc13cdd` passed `--execution-policy` with
verified portable checksums and no renderer errors. The isolated profile settings workflow ran
with zero projects and zero desktop conversations; unrelated harness fixtures were registered
later. No destructive operations or model completions were invoked by this settings test.

Standard, YOLO and YOLO+ are one explicit mode choice backed by the two canonical flags. The
nine destructive-operation preferences match core's category list; tests also match the locked
trusted-state and credential categories. Locked toggles remain enabled/read-only under normal
YOLO. YOLO+ text explicitly identifies that its bypass includes those categories; the stored
normal-YOLO map is retained rather than falsely shown as active protection. Standard mode follows
configured permission rules rather than claiming every tool always prompts.

The real native test saved and read back all three modes, checked raw profile config, reloaded
YOLO+, and confirmed that returning to Standard cleared both mode flags. A local publish-category
edit preserved an independent Git-history-category update and the existing bulk-delete choice.
A competing mode-pair update caused a stale YOLO+ editor to refuse its write; reload recovered
the live YOLO state. Unsaved category edits survived section navigation and could be discarded.
Light/dark and 800 px screenshots were captured and inspected. Runtime enforcement of dangerous
commands was deliberately not exercised; these cases prove configuration, persistence and UI
semantics rather than operational permission-policy certification.

Desktop tests passed 283 tests across 68 files; typecheck passed 206 source files. Targeted Biome
and the Tauri release build passed. A canonical parity test prevents the category and locked-kind
lists from drifting. Mode preflight treats the two flags as an indivisible choice, while the
existing three-way merge preserves independent category edits. The check is read-before-write,
not an atomic cross-process compare-and-swap. Full repository release checks and hosted CI were
not run, and the portable QA artifact does not update the installed application.

## Prompt refinement profile settings (2026-10-28)

Final bundled identity `fba85b5b819c-12f87dc13cdd` passed `--refinement-policy` with verified
portable checksums and no renderer errors. The settings phase ran before project/session
registration; the harness subsequently exercised a separate project-owned prompt library.

Dedicated settings expose review-on-submit, preferred language, saved model catalogs,
independent provider/model inheritance and a named refiner profile. The named profile takes
precedence according to the existing backend contract. The sample preview explicitly calls
the saved route and displays the returned actual provider/model and both language variants.
Saving preferences never invokes a model completion. Preview does not submit chat or create
a desktop conversation. Referenced profiles cannot be removed from the fallback editor.

Route preflight treats provider, model and profile as one logical choice and refuses stale
mixed routes. It checks that the selected profile chain still matches the reviewed draft and
rejects missing or emptied selected profiles. Semantically unchanged whitespace-only route
edits are omitted; an empty resulting patch reloads the latest saved values without writing.
This remains read-before-write protection, not an atomic cross-process transaction.
Catalog and preview replies use ownership generations; changing the connection or saved route
clears transient previews. Broader reconnect/concurrent-window acceptance remains open.

The focused bundled native test covers catalog selection, explicit route/profile persistence,
profile-removal protection, real local-provider routing precedence, actual-model preview,
stale route refusal and reload, independent inheritance, language/enhance persistence and
zero desktop projects/conversations during settings testing. Light/dark and 800 px captures
are retained under `.temp_files/desktop-v2-native/refinement-policy`. A first attempt reached
the correct profile model but received HTTP 400 from the fixture's single-model assertion;
the fixture now accepts an explicit model list only for this scope, retaining its strict default.
An intermediate staging attempt was refused by checksum validation because its manifest used
CRLF line endings; the manifest was rewritten with LF before native execution.

The full composer native suite passed on bundled identity `dc26a4ae5b3a-12f87dc13cdd`.
It verifies the English preference as the initial selected variant, explicit original-language
selection and approval, BTW/queue/stop-and-steer, attachments, prompt sources and approvals,
plus existing draft recovery and paired-theme cases. Later settings-only lifecycle, no-op
save and explanatory-copy changes do not alter the composer dialog; its full suite was not
repeated on the final settings artifact. The companion host was not compatible with that
suite and companion-host behavior was not verified.

Desktop tests passed 286 tests across 69 files; typecheck passed 208 source files and targeted
Biome passed 11 files. Tauri release builds passed. These tests use an isolated loopback
provider; external-model refinement quality, automatic submission/countdown policy and a
searchable per-request refiner picker remain open. Full repository release checks, coverage,
hosted CI and installed-application replacement were not performed.

## Per-request refiner selection and recovery (2026-10-28)

Final bundled identity `3f55bd6ab91b-ba12177e221c` passed the complete `--composer` native
scope with verified portable checksums and no renderer errors. It covers searched request-only
selection, no selection-time completion/profile-default/chat-model changes, real explicit
fallback completion, configured-route reset and unchanged original draft. Desktop and 800 px
picker/review captures were inspected. The same run passed the previously failing image/PDF
submission after custom-model changes, including actual image bytes, PDF extraction, >1 MB
native transport, queued media and reload; it also passed prompt resources, approvals, queue,
BTW, steer, next steps, two-window draft recovery, agent model plans, topic boundaries and
all 13 paired palettes. Companion-host compatibility was false and that host was not tested.

The review dialog now opens the native current-profile model picker for a request-only
refiner target. Search, favorites, exclusions and fresh selection preflight use the same
profile model policy as the session picker. Selection only changes the pending retry target;
it does not switch the conversation model, persist refiner defaults or invoke a completion.
Custom provider/model IDs and an explicit return to configured routing remain available.
Recovery explains timeout, unusable-output and provider failures before showing expandable
technical details. Suggested fallback and longer-window retries require explicit clicks.
The returned actual provider/model remains the provenance for the last successful rewrite.

The operation layer previously discarded every structured error field when rejecting a
correlated engine reply. A durable test failed because timeout, retryTimeoutMs and fallbackRef
were missing, then passed with EngineReplyError retaining the reply details. Recovery tests
cover nested model IDs, malformed routes, plain transport failures, unusable output and timer
overflow bounds. Timeout/empty guidance is unit-tested; actual timeout/empty native failure
injection and external-provider quality remain open.

An initial picker test could not find its alternate model: accepting a model at the loopback
provider does not register it in the saved profile catalog. The test now explicitly registers
and later removes its owned custom definition. The expanded native flow then passed refiner
selection and explicit fallback, but the later existing image/PDF case failed before provider
submission. The recorded profile still advertised vision=true. Investigation found that config
hot-reload rebuilt the active provider using wire-family defaults after the custom definition
changed, losing the active model's vision and output-limit overrides.

The credential watcher now reapplies canonical catalog/custom capabilities for the active
model before attaching the rebuilt provider. A production-watcher regression with the real
provider constructor and capability resolver failed on vision=false before the fix and passed
afterward; its family-baseline control remains false, while a properly resolved active model
retains vision=true and maxOutput=8192 across the rebuild. The watcher, provider fan-out and
model-operation suites passed 17 tests. Backend typecheck passed 314 source files. This narrow
fix does not certify simultaneous credential/model switches across independently switched tabs.

Desktop tests passed 289 tests across 70 files; desktop typecheck passed 209 source files.
Targeted Biome passed nine desktop and two backend files. Backend dependency closure, compiled
engine/asset pack and Tauri release builds passed. The first engine-build attempt could not
spawn Bun from its child PATH; rerunning with the pinned Bun directory on PATH completed.
Full repository release certification, coverage, hosted CI and installed-app replacement were
not performed. Owned QA logs/screenshots remain in `.temp_files/desktop-v2-native`.

## Selective Git staging and persistent review notes (2026-10-28)

Bundled native identity `1173e717c005-09ce8d6e111a` passed `--files` with verified portable
checksums and no renderer errors. The actual native UI staged one of two distant hunks,
verified the real index while preserving disk bytes, refused a stale review after an external
edit, and unstaged the selected indexed hunk. Light/dark and 800 px captures were inspected.
Review notes survived renderer reload and direct native SQLite readback; a peer revision
prevented a stale deletion and explicit reload showed the peer note. The scope also passed
the existing file/draft/search/edit/conflict/move/delete/diff flows and created zero desktop
conversation sessions. An intermediate stale-diff test edited the file while the post-stage
refresh was still pending, so the newer text was correctly included in the newly loaded review.
The test now waits for the acknowledged refreshed hunk list before introducing its external
edit; production assertions and stale-review protection were retained.

The native Changes workspace now opens a focused hunk review with separate index-to-worktree
and HEAD-to-index layers. New `git.hunks` and `git.hunk.apply` messages use the canonical
standalone and embedded Git routers with request correlation. The server regenerates the
Git diff, checks its reviewed SHA-256 identity and applies only the selected canonical hunk
to the index. Clients cannot submit arbitrary patch text. Working-tree bytes are not rewritten.
Project containment, literal pathspecs, isolated Git configuration, process/output limits and
strict UTF-8 decoding apply. Hunk support currently covers modified regular text files;
whole-file controls remain necessary for additions/deletions, binaries, mode changes and
conflicts. Per-line selection and merge-conflict resolution remain open.

The real-Git integration exercises two distant hunks, selected-hunk staging and reverse
unstaging, unchanged working files, stale-diff refusal, request correlation, invalid layer and
path rejection, subproject containment, invalid UTF-8 refusal and untracked-file behavior.
Three focused backend suites passed 56 tests; after strict UTF-8 handling and boundary cases
were added, the hunk integration was rerun and passed. Backend typecheck passed 315 files.
The protocol suite passed 260 tests in 15 files and typecheck passed 29 source files.

Review notes now use a dedicated allowlisted native project form in SQLite. They are separate
from conversation drafts. Saves acknowledge the database revision before replacing the shown
collection. A stale window cannot remove or replace newer notes; explicit saved-note reload
recovers it. Existing in-window notes migrate only into an absent saved collection using the
same revision guard. Notes remain bounded to 500 records and the native form payload budget.
Path/line anchors are not automatically rebased when file content changes. Thread replies,
resolution state and version-aware reanchoring remain open.

Desktop tests passed 292 tests across 71 files, including persistence/restart, peer revision
conflicts, malformed data, storage failure and existing-note migration. Desktop typecheck
passed 212 files. The full no-default-features native Rust suite passed 19 tests; its project
form test additionally covers review-note isolation, revision checks and database reopen and
was rerun after the final reopen assertion. Targeted Biome and engine/dependency/asset-pack
builds passed. Tauri release builds passed. An initial native UI run reached the new review
but failed the 800 px overflow assertion; the hunk dialog now sizes its outer container and
keeps its content within that container. Full repository coverage/release checks, hosted CI,
installed-app replacement and unrelated working-tree changes were outside this increment.

## Three-way text conflict resolution (2026-10-28)

Bundled identity `211273172880-678c0b40014d` passed the expanded `--files` native scope,
including the preceding hunk/persistent-note workflows, with verified portable checksums and
no renderer errors. The isolated fixture created a real two-branch conflict. The native editor
showed the common base and actual index stages 2/3, kept marker-containing output unsavable,
required explicit dirty-close review, refused a changed working file while retaining the local
merge draft, explicitly reloaded the new snapshot and saved/staged a reviewed merged result.
Disk content, stage-0 blob and removal of unmerged index entries were checked through real Git.
MERGE_HEAD remained, proving that resolving the file did not create a merge commit. Desktop and
800 px conflict captures were inspected. The entire scope created zero conversation sessions.

The new `git.conflict` and `git.conflict.resolve` operations share request-correlated canonical
standalone/embedded routing and the existing contained, isolated Git review process helper.
They require a regular UTF-8 modify/modify conflict with all three index stages. The reviewed
revision covers those index entries and exact working bytes. Resolution rejects stale revisions,
NUL/oversized text and standard conflict markers. A failure after writing but before staging is
reported as a partial outcome, rather than claiming the disk remained unchanged. No merge commit
is issued. The check is read-before-write; atomic file/index transactions and simultaneous external
writes remain outside this evidence. Merge editor drafts remain window-local, with an explicit
discard guard; restart-persistent unsaved merge drafts remain open.

Combined previews are limited to 1 MiB across the three sides and working file; merged output is
limited to 2 MiB. A real-index boundary case builds three valid blob stages plus a working file
exceeding the preview budget and verifies refusal without altering the index. Add/delete, rename,
binary and larger conflicts remain explicit limitations rather than fabricated empty-side views.

The conflict and hunk integration suites passed together after the shared process/path helper was
extracted. The conflict suite was rerun after adding the final combined-preview boundary case
and passed. Desktop tests passed 292 tests in 71 files; typecheck passed desktop 213, backend 316
and protocol 29 source files. The protocol suite passed 260 tests in 15 files. Targeted Biome,
backend dependency/engine builds and Tauri release build passed. An initial dependency build
encountered a temporarily missing ChronicleEvent type import in concurrent Chronicle work;
that source was already corrected on reread, without a change by this desktop increment, and
the subsequent build completed. Full repository release/coverage, hosted CI, installed-app
replacement and comprehensive conflict-type/concurrency acceptance were not performed.

## Missing-side, binary and rename conflict choices (2026-10-28)

Bundled native identity `2f8eedf96a89-e0869c855f69` passed the expanded `--files` scope with
verified portable checksums and no renderer errors. Native UI cases cover add/add with an
explicitly absent base, modify/delete with a disabled missing-side action and explicit deletion,
opaque binary side selection with no text editor, and rename/rename resolution across the
three actual unmerged paths. Choosing a side alone does not save. Binary working bytes and
the indexed blob were compared byte-for-byte. Resolving one rename path left both sibling
index entries and the unselected destination's actual bytes intact until separately reviewed.
The final file resolution left MERGE_HEAD in place; fixture-only commits between scenarios
were explicit test setup, not a resolver action. The complete scope created zero conversations.
Light/dark, 800 px binary and rename-path evidence captures were inspected.

Git review now permits an absent working file through a verified existing ancestor, including
missing parent directories, while refusing symbolic-link file/parent targets and paths outside
the project. The stage-presence map distinguishes absence from an empty file. Binary/non-UTF-8
blobs stay opaque; only a reviewed server-side blob can supply binary replacement bytes.
Explicit deletion uses the exact reviewed path. Selected side executable index mode is retained.
The snapshot revision includes the project's actual unmerged index paths as well as the selected
file/stages, so resolving a sibling makes an older rename-context review stale. Related path
metadata is bounded to 200 and the UI explicitly shows at most 50 with the recorded total;
no rename relationship is guessed from a missing side.

Independent base/ours/theirs blob reads run in parallel. Process execution, isolation and size
guards remain in place. Combined text previews retain the 1 MiB budget; blob and working-file
reads retain the 2 MiB budget. Larger files, symlink/submodule conflicts, automatic rename grouping,
cross-process atomic file/index mutation and restart-persistent unsaved merge drafts remain open.
Changes can now review deleted/conflicted paths without first fabricating a source document;
their virtual review tab is separate from cached editor text. Returning to Files loads actual
content and duplicate in-flight reads are suppressed. Binary/error diff states retain access to
the conflict resolver.

Three focused Git suites passed six tests after the shared byte/path and parallel-read changes.
The expanded variant suite then passed five tests, adding restoration through missing working
directories with explicit executable stage mode preservation. Existing stale-file, marker,
containment, UTF-8 and combined-preview-budget checks remain in the production-path integration.
Desktop tests passed 292 tests in 71 files. Desktop/backend typecheck passed 213/316 source files;
targeted Biome and compiled engine/dependency/Tauri builds passed. No dependencies changed.

An initial native wait used the general 20-second locator deadline while the acknowledged Git
operation permits 45 seconds; the dialog had closed by failure capture. Native completion waits
now allow the existing command deadline and UI processing to finish, still bounded at 60 seconds.
Another native fixture expected LF in an unselected rename target that Git had checked out as
CRLF. Its assertion now compares exact pre/post working bytes, preserving the intended no-change
contract without normalizing content or weakening the indexed-blob checks. Full repository
coverage/release checks, hosted CI and installed-application replacement were not performed.

History follow-up inspection confirmed two distinct current bounds: desktop content search caps
its window at 500, and the canonical session catalog caps a list RPC at 1000. Deeper history needs
a real continuation contract and native evidence; merely increasing a selector cannot certify it.

### Project history catalog continuation and full-catalog search (2026-10-28)

The additive `page_catalog` operation leaves the legacy list contract unchanged. Canonical SQLite
pages read an ordered identity snapshot and at most 200 full summaries inside one transaction.
Continuation revisions bind membership, ordering and the excluded project carrier; metadata-only
renames do not invalidate otherwise stable pages. Exact-ID anchors locate an older record's real
page. Membership/order drift rejects continuation until an explicit refresh. The file-store
fallback has a conservative 10,000-record budget and reports truncation rather than complete coverage.

The native library exposes 50/100/200-summary pages with range/count and previous/next controls.
Summary filters apply to the visible page. Cross-session retained-text search independently scans
the project catalog in five-record batches with query/role and catalog revision checks. A result
opens its actual page and retains the existing transcript revision guard. Rename preflight and
verified readback work on older pages. Runtimes without the additive paging contract fail explicitly.

Focused production-path checks passed: 22 core catalog/storage cases across two suites, three
authenticated catalog IPC cases, and six backend search/content-state cases across two suites.
The SQLite fixture contains 1106 records and verifies all 1105 eligible identities without
duplicates beyond the unchanged legacy 1000-record limit. The content-search fixture finds a
retained message beyond 500 newer records and rejects changed queries, missing continuation
tokens and catalog drift. Desktop tests passed 294 cases in 72 files. Contracts/core/backend/
desktop typechecks passed 126/634/316/214 source files. Targeted formatting and compiled engine/
dependency/Tauri builds passed. No dependencies changed.

Bundled native identity `ec241cf89238-e1b7d79bd098` passed
`bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --history` (exit 0).
The real project fixture seeded 1105 closed records; the visible catalog reached 1117 eligible
records before the additional membership-change fixture. All canonical pages were traversed
without duplicate identities. The native UI opened and renamed the selected record on the page
starting at offset 1000, rejected stale continuation after a new record, refreshed explicitly,
searched the full catalog and navigated the matching retained message back to its actual page.
Read/search operations and closed fixtures created no desktop conversations. Existing transcript,
project-isolation, preserved-draft reuse, native fork/resume and duplicate-writer checks also passed.
An 800 px screenshot and overflow assertion passed. Evidence is retained under
`.temp_files/desktop-v2-native/history/`, including `native-history-beyond-1000.png`,
`native-history-paging-compact.png` and `native-history-full-catalog-search.png`.

The first native run stopped before bulk seeding because its new test helper used an absent
registry root field. It now takes the project root verified by the engine; the same packaged
application then passed the complete scenario. No production fallback or acceptance assertion
was weakened. This increment did not rerun companion-host acceptance, full repository coverage/
release checks or hosted CI, and did not replace the installed application. Compressed/large
transcript acceptance, durable catalog selection/filter state and broader performance remain open.

### Structured advanced model definitions and saved reasoning propagation (2026-10-28)

Model definitions now expose grouped advanced controls instead of requiring raw JSON: effort
levels, toggle and bounded token-budget controls, interleaved replay fields, lifecycle/experimental
status and per-model SDK/API metadata. Extended numeric prices cover cache write durations,
long context, reasoning and audio. Blank overrides inherit the catalog/provider; unedited unknown
fields, reasoning policies and price tiers survive round trips. The inspector renders saved
behavior as labelled text. Explicit runtime reasoning policy takes precedence, so edits to
catalog reasoning controls require an explicit switch that removes that saved override.

The production models.dev schema accepts authored payloads. Invalid integer token bounds,
reversed ranges, duplicate control types, unsupported effort names and malformed/credentialed
endpoints fail before writing. Desktop tests passed 308 cases in 73 files and typecheck passed
216 source files. No dependency versions changed; the live test-runner registry still reports
the installed Vitest 5.0.5.

Native acceptance first exposed a false-negative saved-value check: arrays of equivalent objects
were compared with serialized key order. A durable regression failed before the fix. Structural
comparison now verifies nested values, array lengths and element order while accepting object
key reordering. The first corrected native model-management flow passed, including actual disk
readback, stale-definition refusal, unrelated price-tier preservation, definition removal and
existing key/quota/visibility/OAuth-startup cases.

An added effective-catalog assertion then exposed a separate propagation gap: configured custom
model reasoning options were saved but absent from both `provider.models` and metadata resolution.
Two real backend-path regressions failed before the fix. These paths now use the core registry's
canonical reasoning normalizer for saved controls, preserve unrelated upstream reasoning/replay
policy and respect explicit runtime policy and explicitly empty controls. Three focused backend
suites passed 71 cases; backend typecheck passed 316 source files. These checks do not establish
live external OAuth completion, provider execution of every declared reasoning control, full
repository release/coverage certification, hosted CI or replacement of the installed application.

Final bundled identity `33f5953d41f2-ab32e9424fe1` passed
`bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --models` (exit 0), with checksum
verification. The unchanged effective-catalog assertion now observes `low/high` and
`effortSupported: true` from the real `provider.models` reply after native authoring. The same run
checks rejection without storage mutation for reversed token bounds, valid structured controls,
replay/lifecycle/SDK/API/cache metadata on disk, editor reopen, stale-definition refusal,
unrelated price-tier preservation and the existing definition/key/quota/visibility/OAuth-startup
flows. Desktop tests remain 308/73 and desktop/core/backend typechecks passed 216/634/316 source
files. Targeted Biome, compiled engine/dependency builds and the Tauri release build passed.
Native screenshots and logs remain under `.temp_files/desktop-v2-native/models/`; the final
command log is `.temp_files/desktop-v2-native/model-advanced-native.log`. The installed app was
not replaced. Explicit runtime-policy and price-tier authoring, durable editor drafts and atomic
cross-window custom-model writes remain open.

The follow-up editor also authors explicit runtime reasoning policy: enabled/disabled/adaptive/
always-on defaults, disable support, documented/unsupported/undocumented effort support and
levels, and thinking retention. Unknown policy metadata survives edits. Validation rejects
contradictory always-on/disable support, missing documented levels, unknown enums and levels
declared under undocumented/unsupported effort. Explicitly returning to catalog controls removes
the runtime override while retaining the catalog options. Canonical normalization tests verify
both the authored policy and restored catalog effort vocabulary. Focused model suites passed
33 cases; the complete desktop suite passed 313 cases in 73 files with 216-file typecheck.

Bundled identity `49187302a95f-ab32e9424fe1` passed the complete native `--models` scope (exit 0).
The added policy flow authors adaptive reasoning with disable support, documented `xhigh` effort
and optional thinking retention, verifies the exact policy on disk and the `xhigh` vocabulary
from the real model catalog, reopens the editor and observes the saved values, then returns to
catalog controls. Saved policy removal and restored `low/high` catalog vocabulary are both
asserted. Existing custom-definition/schema preservation, stale-edit, key, visibility, quota and
OAuth-startup cases pass in the same run. No conversations were created by model management.
The new screenshot is `native-model-explicit-runtime-policy.png`; final command output is
`.temp_files/desktop-v2-native/model-runtime-native.log`. Targeted Biome, diff whitespace checks
and the Tauri release build passed. Price-tier authoring, durable editor drafts and atomic
cross-window writes remain open; the earlier external-service and release limitations still apply.

### Native persistent Chimera note drafts (2026-10-28)

Unsent review notes now autosave through the native project-form store, keyed by project and
SHA-256 report identity. The typed payload also verifies the original report identity on load.
The existing SQLite compare-and-swap revision check protects competing writers. Invalid/cross-
report payloads are refused. Pending edits are coalesced in order; write failures retain local
text and block posting until explicit review. Notes are limited to 100,000 characters and retain
the existing 2 MiB native form-row limit. No session is needed for draft reads or writes.

The journal form shows saving/saved/unsaved state and explicit local/saved comparisons, with
fresh revision checks before choosing either version. A version that changes again requires a
new review. Choosing a draft does not post a report note. Posting flushes pending saves and
checks the saved revision before invoking the canonical engine operation. Duplicate in-process
submissions are refused; failed submissions preserve the draft. Only acknowledged submission
clears it, and a competing newer draft is protected from that clear by the same native revision.
This does not establish an atomic transaction spanning the engine journal and desktop SQLite.

The complete desktop suite passed 319 cases in 74 files; desktop typecheck passed 217 source
files. Seven draft-controller cases cover reopen, ordered saves, submission failure/clear,
competing writers, second changes during review, clear-vs-newer-note and malformed ownership.
Three focused Rust registry cases passed, including actual SQLite reopening, report/project
isolation, unsupported keys and stale writes. Targeted Biome, Rust format and Tauri release
build passed. Existing shared-checkout changes were preserved and no dependencies changed.

Bundled native identity `3f307975d336-ab32e9424fe1` passed
`bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --chimera` (exit 0, checksums
verified). The real UI autosaves an unsent note through Tauri IPC, isolates it from another
project/report, recovers it after a renderer reload, refuses a competing native writer and
rechecks a second competing revision before permitting the reviewed local overwrite. It also
adopts the reviewed saved version without posting any report note. A final explicit post produces
one journal note, clears the native draft and remains cleared after another renderer reload.
Existing report/finding lifecycle, profile review policy, follow-up draft and no-conversation
reading checks pass in the same run. The competing writer uses the real Tauri/SQLite path;
this is not a simultaneous two-WebView stress test. Registry reopening is separately covered
by Rust tests; a complete host restart was not exercised in this increment.

Screenshots `native-chimera-note-conflict.png` and `native-chimera-note-conflict-compact.png`
capture the compared versions; the 800 px overflow assertion passes. The final command log is
`.temp_files/desktop-v2-native/chimera-draft-native.log`. The initial harness used a test socket
that does not expose form operations; it was corrected to call the application's actual Tauri
IPC, without changing the application or weakening assertions. Full repository coverage/release
checks, hosted CI, external provider acceptance and installed-application replacement were not run.

### Persistent project history view (2026-10-28)

History summary query, provider/outcome filters, empty-journal visibility, page size, selected
record and unselected-page first-row anchor now persist under the native `history-view` project
form. The renderer restores exact identities through the real catalog paging contract; saved
offsets and catalog revisions are not reused. A missing remembered identity produces a notice
and a fresh first page. A remembered provider absent from the loaded page remains a labelled
filter option. Restoring selection only reads the transcript; agent resume/fork stays explicit.

Preference updates serialize/coalesce local edits, read the latest native value and merge only
explicitly supplied fields, with at most three compare-and-swap retries. Independent fields from
other windows survive. Explicit selection clears remain writes even when that window already
has an empty local selection; a durable regression failed before correcting that case. These
are view preferences, with last successful explicit intent winning for the same field. They do
not silently resolve competing user-authored note or document drafts. Malformed storage is not
overwritten; browsing can continue with defaults and an explicit storage retry.

Eleven view-store cases and two catalog-page validation cases passed. The complete desktop suite
passed 330 cases in 75 files; desktop typecheck passed 219 source files. Three focused Rust
registry cases passed with real SQLite reopening, project isolation and stale-write refusal for
the new key. Targeted Biome, Rust formatting and the Tauri release build passed. No dependency
versions changed; the live Vitest registry still reports the installed 5.0.5. Shared-checkout work
was preserved. Native acceptance for this package is recorded below after execution.

Bundled identity `3c1cfdefb7b5-ab32e9424fe1` passed
`bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --history` (exit 0, portable
checksums verified). The fixture seeds 1105 closed records; after the additional membership
fixtures the visible catalog contains 1119 eligible records. The native UI saves all summary
filters, page size and a selected record beyond offset 1000 through actual Tauri IPC/SQLite,
adds another catalog member, reloads the renderer and restores the exact record's current page
and read-only transcript. Another project's controls remain independent. A remembered missing
record falls back to a fresh first page with a notice; an unavailable provider remains a labelled
option. A second page without any selection is also saved and recovered through its first-row
identity. Reads and preference recovery create no desktop conversations.

Existing native history transcript/search/rename, full-catalog search, stale continuation,
fork/resume, duplicate-writer and preserved-composer-draft checks pass in the same run. Screenshots
`native-history-restored-view.png` and `native-history-restored-view-compact.png` are retained
under `.temp_files/desktop-v2-native/history/`; the 800 px overflow assertion passes. Command
output is `.temp_files/desktop-v2-native/history-view-native.log`. Actual full host restart,
simultaneous two-WebView stress, companion-host acceptance for this increment, compressed/large
transcript certification, full repository release/coverage, hosted CI and installed-application
replacement were not performed.

### SAGE applicability authoring and current-source evidence (2026-10-28)

The native SAGE editor now authors and removes an applicability statement and up to four
`source_contains` checks with project-relative paths and exact literals. Form validation follows
the canonical 1,000-character statement, 500-character path and 400-character literal bounds;
checks require a statement. Invalid/absolute/traversing paths are refused before writing.
Create/update acknowledgements with applicability changes are followed by an actual record read;
missing/different stored conditions retain the editor and show a verification error. Existing
structured anchors and retention/audience/lifecycle controls remain separate.

An explicit Source evidence card requests the additive `reviewValidity` option on
`memory.sage.get`, with the selected revision. Both host routers supply their own project root.
The handler uses SAGE's canonical normalization and injection-validity checker, including its
250 ms budget, project containment and at most four 64 KiB source reads. Only stored check text,
status, observed revision, time and source hashes return; source file bodies do not. Ordinary
record reads do not inspect files. Missing, oversized, outside-project or unavailable sources
remain unknown; literal absence is distinct from unknown. Overall applicability remains unknown
and human-reviewed even when a literal is found. Review never mutates memory lifecycle/counters.
Old hosts without review metadata refuse the UI check; stale record revisions fail explicitly.
Evidence is transient and clears on record/revision/runtime changes or UI reload. This is a
current-source review, separate from a live injection/context trace and vector retrieval.

The complete desktop suite passed 343 cases in 76 files; desktop typecheck passed 221 source
files. Three focused backend suites passed 70 cases and backend typecheck passed 316 files.
Three canonical SAGE validity/injection suites passed 14 cases; SAGE typecheck passed 162 files.
Real SQLite/filesystem route checks cover CRLF-normalized matching, literal absence, missing and
oversized sources, unchanged stored records, no source-body disclosure, outside-project junction
containment, ignored client-supplied roots, stale/missing revisions and statement-only conditions.
Targeted Biome, compiled dependency/engine builds and Tauri release build passed. No dependencies
changed; the live Vitest registry still reported the installed 5.0.5.

Bundled identity `5c75e2ab9510-c2030f74b927` passed
`bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --sage` (exit 0, portable checksums
verified). The UI creates four source checks, refuses invalid paths without creating a record,
observes found/missing/unknown results, detects a real source edit, refuses stale memory revision
and another project's record, cancels edits without a write, explicitly clears and re-adds
conditions, verifies updated readback and reopens after renderer reload without replaying old
source evidence. The same flow works while Vector Memory is disabled and creates no desktop
conversations. The 800 px overflow assertion passes. Screenshots and result are retained under
`.temp_files/desktop-v2-native/sage-validity/`; command output is
`.temp_files/desktop-v2-native/sage-validity-native.log`.

This focused scope does not replace the full native suite, live SAGE injector trace acceptance,
every lifecycle/repair/concurrent-write case, full repository release/coverage gates, hosted CI
or installed-application replacement. No external provider calls were needed.

### Conversation usage and cost workspace (2026-10-28)

Tools now opens a dedicated session-owned Usage & cost workspace while the resting chat keeps
its compact footer. The workspace separates accumulated disjoint input/output/cache token
traffic, the last provider-reported request and the current context snapshot. The latter may
change after compaction without a new provider response. Cumulative and last-request cache
ratios, routed-provider counters, optional TTL splits, qualified gross cache-read discount and
live/manual refresh have explicit labels. Read failures retain the last successful snapshot;
responses for another session are refused. Unsubmitted chat drafts survive navigation.

The additive `stats.get.pricing` detail preserves the legacy `cost` field for existing clients.
It reports known/partial/unavailable aggregate rates, explicit input-rate cache fallback, saved
model price overrides, per-category estimates and the known-priced subtotal. Missing rates are
not converted into a free-price claim. Explicit zero rates remain valid. The resting-chat chip
uses the new availability distinction and hides ambiguous legacy zero prices. This is current
model aggregate-rate estimation; historical model routing, tiers, TTL-specific cache-write
pricing, auxiliary-worker aggregation and invoices are not reconstructed by this scope.

The complete desktop suite passed 349 cases in 77 files; desktop typecheck passed 223 source
files. Three focused backend pricing/introspection suites passed 33 cases, with 317-file backend
typecheck. Real counter tests account cold/warm responses and separately change the context
snapshot, proving that the last provider request remains distinct. Other tests cover unknown,
partial and explicit-zero prices, saved overrides, arithmetic/category validation, session
ownership and the resting-chat chip. Targeted Biome and compiled dependency/engine/Tauri builds
passed. No dependencies changed; the live Vitest registry reported installed version 5.0.5.

Bundled identity `3edad3321000-fbb0c8a21f7a` passed
`bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --usage` (exit 0, portable checksums
verified). Two real loopback provider responses produce 725 accumulated tokens, 80% cache hit
for the latest provider request and approximately 68.6% cumulatively. The configured current-rate
estimate is verified against the engine response. The UI exercises live/manual refresh,
preserved composer text, an isolated second session with zero usage and an unpriced model,
and return to the original session's counters. The 800 px overflow assertion passes.
Screenshots/results remain under `.temp_files/desktop-v2-native/session-usage/`; command output
is `.temp_files/desktop-v2-native/session-usage-native.log`.

This focused local scope does not complete project/profile usage aggregation, historical cost
attribution, broader reconnect/restart stress, companion-host certification, full release/coverage
gates, hosted CI, external-provider billing acceptance or installed-application replacement.
## Council seat-default rotation (2026-10-28)

- Added a separate ordered `brain.council.seats` editor to native Brain policy settings. Catalog
  and custom decision lenses, inherited/enabled/disabled veto, reorder/remove, and built-in reset
  remain independent of explicit voter model references, weights and judge selection.
- Labels follow actual engine precedence: explicit voter preferences override rotation values;
  missing preferences use the rotation. Pool-derived voters are limited by rotation length.
  An empty configured rotation restores executor, skeptic (veto enabled), auditor.
- Read-before-write conflict refusal treats the rotation as an ordered atomic value. Saved
  readback is verified; explicit `false` survives disk/reload, omitted veto remains inherited,
  and reset removes the configured override. Empty lens rows are rejected before a write.
- Desktop suite: **350 tests / 77 files PASS**. Desktop typecheck: **223 files PASS**.
  Focused Biome checks: **6 files PASS**. Tauri release build: **PASS**.
- Bundled native acceptance: `bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled
  --brain-policy`, **exit 0 / PASS**, portable identity `1204ca39a10d-fbb0c8a21f7a`, checksums
  verified. Exercised add/reorder/remove, three veto states, combined policy/target save,
  actual profile disk/readback, reload, independent stale-seat refusal with draft preservation,
  built-in reset and empty-row rejection. Existing model-pool, monitor and trace acceptance
  also passed. No model completion requests were made by settings acceptance.
- Inspected the 800px native seat-default screenshot; no horizontal document overflow.
  Artifacts: `.temp_files/desktop-v2-native/brain-policy/native-brain-seat-defaults.png`,
  `native-brain-seat-defaults-compact.png`, and `native-result.json` in the same directory.
  Logs: `.temp_files/desktop-v2-native/brain-seats-native.log` and `.err`.
- This verifies configuration behavior in the native application. Real council deliberation,
  external-provider quality/billing, hosted CI, full repository certification and installed
  application replacement were not performed in this increment.
## Desktop implementation commit series (2026-10-28)

The pending desktop implementation was separated from unrelated shared-checkout work into:

| Commit | Scope |
| --- | --- |
| `c7eeb5211` | Revision-aware retained conversation catalog paging |
| `25c9f1a21` | Engine APIs, request correlation, structured policies, history/recovery, Git review and source evidence support |
| `e22d3362c` | Native registry/drafts, recorded conversation restoration and host contracts |
| `aa195a088` | Structured provider, model, Brain, fleet and execution/refinement/review settings |
| `4f3b5d4c3` | Project knowledge, engineering tools, history and persistent secondary drafts |
| `b089b1334` | Session tools, chat/composer integration and native acceptance coverage |
| `e9906c6a6` | Shared error scrubbing for Git hunk and conflict handler failures |

Verification on the shared working snapshot:

- Desktop: **350 tests / 77 files PASS**; **223 source files typecheck PASS**.
- Backend final full package run: **3335 tests / 340 files PASS**, exit 0, using
  `WRONGSTACK_VITEST_MAX_WORKERS=4 bun run test` from `packages/webui-server`.
  Log: `.temp_files/desktop-v2-server-precommit-certified.log`.
- Backend source typecheck: **317 files PASS**.
- Core focused history/catalog/Brain round-trip checks: **8 tests / 3 files PASS**.
- Native Rust tests: **19 PASS**; binary/doc-test targets contain zero additional tests.
- Before the final green backend run, protocol totals were updated for four new client Git
  messages and two snapshot replies. The older-than-500 search fixture now seeds real writer-format
  transcript files rather than performing hundreds of unrelated create/close durability cycles;
  its search/revision assertions are unchanged. Git review handlers now use the shared credential
  scrubbing error helper, satisfying the existing architecture regression guard.
- Every commit ran corruption, logging and relative-import guards. The repository's existing
  total-dirty-file guard ceiling was explicitly raised to 800 for this known 773-file shared
  snapshot; staged files remained limited to each reviewed group. Newly introduced relative
  dependencies were included with their first consumer.
- The user authorized skipping **only generated Core API snapshots and architecture report
  production for this commit series**, because shared unstaged/untracked inputs would mix unrelated
  work into generated artifacts. The temporary per-command hook retained all other hook steps;
  the repository's configured `.githooks` path and original hook were not changed.
- Committed paths were checked against the reviewed desktop plan. Unrelated bench, prompt,
  security/fix work and agent learning files remain outside these commits. Mixed preference files
  include only companion-policy hunks; their unrelated prompt-toggle edits remain uncommitted.
- Prior native acceptance evidence in this document remains tied to its recorded portable hashes.
  This commit checkpoint does not certify a fresh clean checkout, full repository release gate,
  hosted CI or installed application replacement.
## Monitor override inheritance reset (2026-10-28)

- Native Brain policy now distinguishes saved monitor overrides from inherited engine defaults.
  The reset button previews defaults without writing. The operator can keep saved overrides or
  explicitly save the reset. Preview fields are disabled to avoid mixing overrides with a reset.
- Reset uses the existing `monitor: null` engine contract, removing the entire override group,
  including custom file-edit matching and additional signal settings. It does not pin today's
  defaults as explicit values. A changed monitor group is rejected before writing; an already
  cleared live monitor is accepted. Independent Brain and trace edits remain separate.
- Saved readback verifies that no monitor overrides remain. Discard/reload clear pending reset
  intent. Native acceptance verifies preview/undo, no early write, stale-reset refusal, combined
  trace-capacity edit, actual config-file removal, other council/risk preservation and inherited
  values after renderer reload. No model completion requests were made.
- Desktop: **351 tests / 77 files PASS**, **223 source files typecheck PASS**. Focused Biome:
  **4 files PASS**, without warnings. Fresh engine build and Tauri release build: **PASS**.
- Bundled native `--brain-policy`: **exit 0 / PASS**; portable identity
  `85b23f01e9bc-a06bfc7bb563`, engine bundled and checksums verified. Existing seat, monitor,
  trace, theme and compact-layout acceptance also passed. Inspected
  `.temp_files/desktop-v2-native/brain-policy/native-brain-monitor-inherited.png`.
  Logs: `.temp_files/desktop-v2-native/brain-monitor-reset-native.log` and `.err`;
  acceptance result: `.temp_files/desktop-v2-native/brain-policy/native-result.json`.
- The native application still requires separate real council execution/quality acceptance,
  cross-runtime policy refresh and broader release certification. No installed binary was replaced.
## Structured model context price tiers (2026-10-28)

- Native model settings now author the observed catalog shape
  `cost.tiers[].tier = { type: "context", size: <tokens> }`. Rows expose context thresholds and
  input/output/cache/reasoning/audio rates in USD per million tokens; add, reorder, remove and
  explicit whole-schedule removal remain drafts until Save. Read-only detail shows human-readable
  saved thresholds/rates. Blank rates remain unspecified; explicit zero is preserved.
- Rejects non-positive/fractional/unsafe thresholds, duplicate context thresholds, negative/non-finite
  rates and new rows without any price. Unknown row/nested metadata survives supported edits;
  provider-specific rows and unsupported root formats remain preserved until explicit removal.
- Existing structured `context_over_200k` schedules are displayed separately, retained during unrelated
  edits and protected from the scalar input. The shared schema now accepts both legacy scalar rates
  and observed nested schedules while retaining future keys and validating known numeric fields.
- Saved tier edits/removal require exact tier-array readback rather than only a subset match.
  Existing whole-definition stale-edit preflight remains. This is catalog metadata authoring;
  historical billing and tier-aware Usage & cost calculations remain separate work.
- Registry format verified directly against [the upstream catalog](https://models.dev/api.json)
  on this date; sampled context tiers use `tier.type=context` and `tier.size`, including nested
  `context_over_200k` schedules. No package dependency or framework version changed.
- Before-proof uses preserved HEAD copies without overwriting production source:
  `.temp_files/desktop-v2-price-tiers/proof.mjs --before`, **exit 1 / assertion RED**;
  scalar control PASS, nested schedule accepted=false and preserved=false. The identical production
  assertions after the patch report accepted=true and preserved=true, **exit 0 / PASS**.
  Evidence: `red.log` and `green.log` in that directory. Durable regressions are in the core schema
  suite and desktop `model-price-tiers.test.ts`.
- Desktop: **365 tests / 78 files PASS**, **225 files typecheck PASS**. Core schema: **12 tests /
  1 file PASS**; core source typecheck: **634 files PASS**. Focused Biome: **10 files PASS**.
  Fresh engine build and Tauri release build: **PASS**.
- Real bundled native `--models`: **exit 0 / PASS**, portable identity
  `7ef0ce69f3ea-890d72a48a36`, bundled-engine/checksum verification PASS. Exercised canonical saved
  schedule loading, unrelated edit preservation, row add/reorder/remove, explicit zero/blank,
  duplicate refusal before storage, actual profile disk/readback, reopen and whole-tier removal
  retaining base/legacy prices. Existing provider visibility/OAuth-metadata/catalog/key/quota
  acceptance also passed; no external OAuth authentication or provider billing was certified.
- Inspected `.temp_files/desktop-v2-native/models/native-model-price-tiers-compact.png` at 800px;
  no document or tier-panel horizontal overflow. Desktop screenshots and `native-result.json` are
  in that directory. Logs: `.temp_files/desktop-v2-native/model-price-tiers-native.log` and `.err`.
- Full repository release/coverage, hosted CI, installed app replacement, live provider invoices,
  and durable model-editor draft recovery were not performed in this increment. Shared-checkout
  HEAD advanced independently during verification; these results describe the tested dirty source
  snapshot and exact recorded native build, not a pristine checkout certification.
## Durable native model-editor drafts (2026-10-28)

- Added a native SQLite `profile_form_drafts` table, separate from project forms and conversation
  drafts. Trusted Tauri IPC exposes only `profile-draft.get/save`; model-editor keys are restricted
  to a provider-derived SHA-256 namespace. Draft payloads are object/null values, bounded at 2 MiB.
  Saves and clears use `BEGIN IMMEDIATE`, exact expected revision checks and checked acknowledgements.
- The desktop profile context keeps one parked editor per provider. A versioned envelope retains
  provider ownership, model identity, original saved definition/baseline, typed form values, reasoning
  and price-tier edits, including invalid-in-progress numbers. Unsupported/cross-provider formats
  fail closed. Autosave never writes provider configuration or creates a project/session.
- Reopen displays an explicit Continue/Discard notice rather than applying or automatically opening
  the draft. Provider refresh retains the current editor's provider identity. Local and saved forms
  have readable comparisons, including capabilities, reasoning, lifecycle, connection metadata and
  price tiers. Saved choices are read again before replacement; intervening changes require a new
  review. Conflicted local edits remain in the current window until a reviewed choice.
- Applying a model first flushes and verifies the native draft revision and checks that the rendered
  editor matches the acknowledged draft. Existing saved-model stale-edit checks remain. Provider
  save/readback is followed by revision-checked draft cleanup. A newer peer draft cannot be erased by
  old cleanup, and a failed clear retains the editor. This is not an atomic transaction spanning
  provider config and native draft storage.
- Desktop full suite: **371 tests / 79 files PASS**. Typecheck: **228 source files PASS**.
  New controller tests cover complete restoration, ownership/format rejection, ordered in-flight
  autosave, explicit conflict resolution, changed-again review, stale application/cleanup, bad
  acknowledgements and mismatched rendered-form preflight. Focused Biome: **8 files PASS**;
  Rust formatting check PASS. Native Rust: **20 tests PASS**, including SQLite reopen, independent
  provider keys, no-project operation, stale saves/clears, payload/key limits and invalid inputs.
- Tauri release build PASS. Final real bundled `--models` acceptance: **exit 0 / PASS**, portable
  identity `59b87f3dc9da-890d72a48a36`, bundled engine/checksum verification PASS. Tested unfinished
  negative-price recovery across renderer reload, explicit resume/discard, native-IPC-injected peer
  writes, changed-again refusal, saved-version choice, actual model application/readback, acknowledged
  cleanup and provider isolation. Resolution assertions wait for native storage acknowledgement.
  Existing price-tier/catalog/provider visibility/OAuth-metadata/key/quota scopes also passed.
- Inspected `native-model-draft-comparison-compact.png` at 800px, with no document horizontal overflow.
  Artifacts: `.temp_files/desktop-v2-native/models/`; final `native-result.json` is tied to the portable
  identity above. Logs: `.temp_files/desktop-v2-native/model-drafts-native.log` / `.err`,
  `model-drafts-build.log` / `.err` and `model-draft-rust.log`.
- Storage is scoped to the current native desktop data/profile context; active WrongStack profile
  switching, orphaned-provider draft administration and future format migration remain open.
  A full application-process restart/abrupt-termination and actual concurrent multi-window stress
  were not exercised; renderer reload plus SQLite close/reopen were verified separately. Full
  repository release/coverage, hosted CI and installed application replacement were not run.
## Actual process restart acceptance for model drafts (2026-10-29)

- Added a dedicated `--model-draft-restart` native acceptance scope. It launches the real portable
  Tauri application with a fresh WebView2 data directory on every launch, terminates the actual UI
  process twice, and separately terminates/restarts the owned host and engine tree twice. Numeric
  process identities and observed exit/signal state are recorded; cold restart also checks that the
  host authentication identity changes without logging its token.
- The test confirms an exact acknowledged native SQLite draft snapshot across UI-only and complete
  host/engine restarts, including an unfinished negative price and the original model definition
  baseline. Recovery remains opt-in and never adds the unfinished model to provider configuration.
- A model definition changed independently before a cold restart cannot be overwritten by the
  recovered stale draft. Local form values remain visible on refusal. Explicitly discarded drafts
  stay cleared after a subsequent process restart. Project/session registry membership is preserved.
- Cleanup and restart operate only on this test's unique `mkdtemp` directory and authenticated owned
  host PID. Resolved temporary-directory boundaries are checked before process cleanup and recursive
  removal. The same bounded scoped cleanup helper is shared with the normal harness teardown.
- The initial harness attempt incorrectly treated Windows `exitCode=null` with `signalCode=SIGTERM`
  as a live UI. The corrected assertion records a real process exit through its code or signal.
  Fixture teardown preserves the original failure when a page has already closed.
- Final native command: `bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled
  --model-draft-restart`, **exit 0 / PASS**, portable identity `59b87f3dc9da-890d72a48a36`.
  Bundled engine/checksum verification PASS. Four restarts produced five distinct Tauri PIDs;
  both cold restarts changed native host PIDs and both UI-only restarts retained the host.
- Desktop package checks remain green: **371 tests / 79 files PASS**; **228 source files typecheck
  PASS**. Focused Biome: **2 files PASS**. This acceptance increment reuses the recorded portable
  executables; runtime source did not require a change or a rebuild.
- Artifacts: `.temp_files/desktop-v2-native/model-draft-restart/native-result.json`,
  `native-model-draft-restarts.json`, `native-model-draft-cold-recovered.png` and
  `native-model-draft-cold-stale-refusal.png`. Logs: `.temp_files/desktop-v2-native/model-draft-restart.log`
  and `.err`. The final stale-refusal screenshot was inspected.
- This closes the previously unexercised complete application-process restart case for acknowledged
  model-editor drafts. It does not guarantee the last unacknowledged keystroke survives termination,
  or certify power loss, long-running repeated crashes, actual concurrent multi-window UI stress,
  active profile switching, the full release/coverage matrix, hosted CI or installed-app replacement.
## Profile-ownership verification and saved-draft administration (2026-10-29)

- Verification of the committed profile-ownership increment (`a7827d8a8`, `4fcafaf8d`) on a clean
  tree. Desktop suite before this increment: **373 tests / 80 files PASS**; typecheck **231 PASS**.
  Full `packages/webui-server` run with `WRONGSTACK_VITEST_MAX_WORKERS=2` and no concurrent native UI
  or build: **3337 tests / 341 files PASS** in 299 s, including
  `project-history-search.test.ts`. No test, fixture, timeout or worker count was changed. The
  earlier single timeout occurred during a concurrently loaded run; its cause is not further
  diagnosed, and a later loaded run could still reproduce it.
- Runtime metadata audit: `profileIdentity` is supplied by the standalone `startWebUI` host used by
  the desktop engine. The CLI-embedded WebUI router does not supply it, so desktop model settings
  fail closed there with reconnect guidance rather than inventing an identity.
- New native `profile-draft.list` IPC (trusted shell allow-list) returns typed ownership summaries
  of parked model-editor drafts: key, revision, timestamp, size, envelope support and text-typed
  provider/profile/profile-name/model fields. Bodies are not returned. Cleared rows are omitted;
  the listing is bounded at 200 rows with an explicit truncation flag.
- Model catalog gains a **Saved drafts** dialog. Ownership is trusted only when the stored owner
  hashes back to the row's own storage key. Drafts are grouped as connection removed, earlier
  unassigned, another profile, unrecognized (missing/malformed/forged owner) and this profile.
  Reachable drafts open their provider; the editor keeps managing them. Unreachable drafts can be
  discarded with a confirmation, using the listed revision, so a draft rewritten after listing is
  never erased. Provider configuration is never written. New saves also record the profile display
  name beside the unchanged opaque owner ID.
- Checks: desktop **377 tests / 81 files PASS**; typecheck **233 PASS**; focused Biome **8 files
  PASS**; Rust fmt PASS; native Rust **21 tests PASS** (new listing test covers typed extraction,
  mistyped envelopes, cleared-row omission, body exclusion and the 201-row truncation boundary).
- Native acceptance on portable identity `2f5045c5270f-8d5e009090b5`, bundled engine/checksums
  verified, all **exit 0 / PASS**: `--model-profiles` (now also seeds a removed-connection draft,
  a second-profile draft and a forged-owner draft; verifies grouping, stale-listing discard refusal
  preserving the newer peer draft, acknowledged discards and unchanged provider config), `--models`
  and `--model-draft-restart` (four restarts, two cold host changes). This closes the previously
  unrun `--models` and restart scopes against the profile-aware bundle.
- Inspected `model-profiles/native-model-draft-administration.png`. Logs:
  `.temp_files/desktop-v2-native/draft-admin-*.log` / `.err`, `s2-backend-full.log`,
  `s2-desktop-test.log`.
- Not covered: profile rename/move migration, future draft-format migration, existence checks for
  other profiles, actual concurrent multi-window UI stress, full repository release/coverage,
  hosted CI and installed-app replacement.
## Version-bound file saves (2026-10-29)

- Engine contract: `files.read` now reports `sha256` of the raw bytes read (byte-order marks and
  CRLF included). `files.write` accepts optional `expectedSha256`; inside a per-resolved-path
  in-process queue the engine re-hashes the current bytes immediately before its atomic temp+rename
  and writes only on a match. A mismatch replies `success: false`, `conflict: true`,
  `currentSha256` (null when the file was removed) and a `FILE_CONFLICT` error; nothing is written
  or recreated. Unconditional writes keep working and are queued with conditional ones. Payload
  types are now validated (`filePath`/`content` strings, lowercase 64-hex hash).
- Boundary: this serializes and verifies every save that goes through the engine (all windows and
  surfaces sharing it). It is not an OS lock; an external process writing in the instant between the
  engine check and the rename can still be replaced. Agent write tools do not take this queue.
- Desktop `saveFileVersion` binds a normal save to the disk version whose text equals the editor
  baseline, and an explicit overwrite to the exact version shown in the conflict review. A newer
  disk edit during review opens a fresh review instead of being replaced; a removed file cannot be
  silently recreated from the review. Engines that do not report a hash fail closed with the draft
  retained.
- Checks: backend proof `tests/file-write-conditional.test.ts` (raw-byte hash with BOM/CRLF,
  matched write, stale refusal without writing, removed-file conflict, three concurrent saves bound
  to one version with exactly one winner, malformed payloads). Mutation check: removing the queue
  turns the race case RED (3 winners); restored GREEN. Full `packages/webui-server` with 2 workers:
  **3343 tests / 342 files PASS**; typecheck **318 PASS**. Desktop **382 tests / 82 files PASS**
  (new `file-save.test.ts`: baseline save, pre-write conflict, check-to-write race, reviewed-version
  overwrite, legacy engine refusal); typecheck **234 PASS**; focused Biome **7 files PASS**.
- Native `--files` on portable identity `93623092f94f-f3cd0165f635`, bundled engine/checksums
  verified: **exit 0 / PASS**, including the new scenario: a second external edit while the
  conflict review is open is not overwritten and is reviewed again; the reviewed overwrite then
  reaches disk; a direct engine write with a stale hash is refused with the current disk hash and
  leaves the file intact; a matched engine write succeeds and the stale editor baseline is
  reconciled through the conflict review. All existing file, hunk, merge and conflict-variant
  scenarios passed. Inspected `files/native-file-version-conflict.png`. Logs:
  `.temp_files/desktop-v2-native/file-save-*.log` / `.err`.
- Not covered: OS-level exclusion against external writers, large-tree/large-file acceptance,
  symlink-target saves beyond the existing containment tests, actual concurrent multi-window UI
  stress, full repository release/coverage, hosted CI and installed-app replacement.
## Durable Project Kit parameter drafts (2026-10-29)

- New generic `DurableFormDraft<T>` (`src/durable-form-draft.ts`): autosave through native
  revision-checked project form storage, stop-and-review on `DRAFT_CONFLICT`, explicit
  keep-local/use-saved resolution with changed-again refusal, and cleanup that only removes the
  exact submitted value and refuses to erase a newer peer draft.
- Project Kit parameters use it under native key `kit-parameters:<sha256(kit name)>` (new Rust
  allow-list entry, project-scoped). The envelope records the kit name and a canonical SHA-256 of
  the input schema; NaN/Infinity positions travel beside the JSON value so an unfinished number
  restores as unfinished rather than `null`. Prototype-path steps are refused.
- Same-contract drafts restore automatically with a visible "Restored unsent parameters" status
  and a reset; drafts typed against an older contract are shown but not applied until the person
  uses or discards them. The draft is cleared only after the request reaches the conversation
  draft. `KitValue` now shows non-finite numbers as "Not entered".
- Checks: desktop **403 tests / 83 files PASS** (the shared tree also holds unrelated concurrent
  mailbox work); new `kit-parameter-draft.test.ts` covers special-number round trip, foreign
  kit/format/prototype refusal, key-order-independent fingerprint, peer review, submitted-only
  cleanup and stale-cleanup refusal. Typecheck **239 PASS**; Biome on changed files PASS (one
  pre-existing CSS specificity warning); Rust fmt PASS; native Rust **21 tests PASS** (form-draft
  test extended with the kit key and malformed-key refusal).
- Native `--kit` on portable identity `991bea41d8fd-f3cd0165f635`, bundled engine/checksums
  verified: **exit 0 / PASS**. New `native-kit-parameters.mjs` verifies cleanup after the existing
  conversation handoff, restore after a real renderer reload including an empty number field, a
  peer write through native IPC stopping this window's autosave for review without overwriting it,
  adopting the saved values, and a changed `kit.json` contract showing saved values without
  applying them, then discarding them. Existing kit scenarios still pass. Inspected
  `kit/native-kit-parameter-conflict.png` from the first run (before the "Not entered" label fix;
  the final run asserts the label). A formatter-only change to `KitParameterForm.tsx` followed
  the final native run. Logs: `.temp_files/desktop-v2-native/kit-draft-*.log` / `.err`.
- Not covered: full application-process restart for kit drafts (renderer reload plus native
  storage only), actual concurrent multi-window UI stress, the remaining secondary forms, full
  repository release/coverage, hosted CI and installed-app replacement.

## Durable skill edit drafts (2026-10-29)

- SKILL.md edits now autosave through `DurableFormDraft`. Project skills use native project form
  storage under `skill-editor:<sha256(['skill-editor', null, source, name])>`; profile skills use
  native profile draft storage keyed with the verified runtime profile ID. When the profile engine
  reports no identity, editing still works but the screen states that edits are not kept. Both Rust
  key allow-lists accept only the hashed `skill-editor:` form.
- The envelope records skill name, source, profile owner, the disk text the edits started from
  (`base`) and the edited body (512 KiB bounds). Edits matching the current disk text restore into
  the editor after a reload with a visible status; edits made against an older disk text are shown
  beside the current file and are applied only through "Continue with my edits" (which rebases
  them onto the reviewed file) or removed through "Discard my edits". Reverting to the disk text
  clears the draft. Parked edits are cleared after a verified save, before the new disk text is
  shown, and on explicit discard from the leave guard.
- Checks: desktop **416 tests / 85 files PASS** (shared tree includes unrelated concurrent work);
  new `skill-editor-draft.test.ts` covers profile/source/name key separation, foreign-owner and
  oversize refusal and a native-slot round trip. Typecheck **242 PASS**; Biome on changed files
  PASS; Rust fmt PASS (after a formatter-only test-line change); native Rust **21 tests PASS** with
  project and profile `skill-editor:` acceptance and malformed-key refusal.
- New native `--skills` scope runs the existing skill scenarios plus `native-skill-drafts.mjs` on
  portable identity `c445308cf0bc-f3cd0165f635`, bundled engine/checksums verified: **exit 0 /
  PASS**. Verified acknowledged native storage of edits, restore after a real renderer reload, an
  external SKILL.md change showing the earlier edits for review without loading them into the
  editor, explicit continue rebasing the stored base, a verified save writing the reviewed text
  and draft cleanup. Existing create/edit/invalid-document/leave-guard/profile-creation scenarios
  still pass. Inspected `skills/native-skill-draft-review.png`; both texts start at the top, so a
  late difference needs scrolling.
- Not covered: profile-skill draft native acceptance (unit and Rust only), full application
  restart, actual multi-window stress, a version-bound engine `skills.edit`, full repository
  release/coverage, hosted CI and installed-app replacement.

## Durable Design Studio edits (2026-10-29)

- Unsaved color overrides, their saved-override baseline and tuning fields autosave through
  `DurableFormDraft` under the project form key `design-edits` (new Rust allow-list literal). The
  envelope records the active kit; entries are bounded and prototype keys are refused.
- Persistence follows the studio state itself, so a verified `design.set`/`design.tune` (which
  empties the edits) or an explicit discard also clears the native draft. Edits for the active kit
  restore after a reload with a visible status; edits recorded for a kit that is no longer active
  are reported and can be discarded, never applied. A peer-window write stops this window for an
  explicit keep/use-saved choice.
- Checks: desktop **419 tests / 86 files PASS** (shared tree includes unrelated concurrent work);
  new `design-edit-draft.test.ts` covers round trip, hostile/unsupported envelopes and blank-tuning
  emptiness. Typecheck **244 PASS**; Biome PASS; Rust fmt PASS; native Rust **21 tests PASS** with
  `design-edits` acceptance, project isolation and near-miss key refusal.
- Native `--design` on portable identity `27e326bab38f-344ee89c60b0`, bundled engine/checksums
  verified: **exit 0 / PASS**. `native-design-drafts.mjs` verified acknowledged storage, reload
  restore of an edited color, discard clearing native storage, and a seeded other-kit draft being
  reported without being applied, then discarded. Existing design scenarios still pass. The
  bundled engine was built from the shared working tree, which contained another agent's
  uncommitted `packages/core` and `packages/cli` edits; this run does not certify those.
- Not covered: full application restart, actual multi-window stress, atomic engine-side override
  writes, full repository release/coverage, hosted CI and installed-app replacement.

## Durable requirement resource inputs (2026-10-29)

- New `usePersistedFields` keeps small typed-but-not-submitted inputs in native project storage
  through `DurableFormDraft`. Values equal to the defaults store nothing, so a successful add/save
  that resets the inputs also clears the native copy. The codec accepts only the listed fields of
  one owner as bounded strings; a peer-window write requires an explicit keep/use-saved choice.
- Both requirement resource forms use it: the new-request editor under
  `requirement-resource-input:new` and the per-record append form under
  `requirement-resource-input:<reqi_ id>` (new Rust allow-list, same id validation as record
  drafts). `projectFormDraftStorage` was added to `platform.ts` and threaded through `ProjectSdd`.
- Checks: desktop **421 tests / 87 files PASS** (shared tree includes unrelated concurrent work);
  new `persisted-fields.test.ts` covers owner/field/size refusal. Typecheck **245 PASS**; Biome
  PASS; Rust fmt PASS; native Rust **21 tests PASS** with `new`/`reqi_` acceptance, project
  isolation and malformed-owner refusal.
- Native `--sdd` on portable identity `d59e54ae4177-344ee89c60b0`, bundled engine/checksums
  verified: **exit 0 / PASS**. `native-requirement-resource-input.mjs` typed a resource name and
  reference on a recorded intake, confirmed the acknowledged native copy, performed an actual UI
  process restart, found both values restored with a visible status, then the existing flow saved
  the resource and the native copy was cleared. All other requirement/SDD scenarios still pass.
  After that run the conflict group was changed from a `div role="group"` to a `fieldset` (Biome
  accessibility warning); this markup is not exercised natively. The bundled engine was built from
  the shared working tree with another agent's uncommitted core/cli edits.
- Not covered: native proof of the new-request resource inputs (unit/Rust only), multi-window UI
  stress, full repository release/coverage, hosted CI and installed-app replacement.

## Durable roster role documents (2026-10-29)

- `RosterDocument` keeps its in-window cache and now also stores unsaved text through
  `DurableFormDraft` under `roster-document:<sha256(['roster-document', role, kind, skill])>` in
  native project storage (new Rust allow-list prefix). The envelope records role, kind, skill, the
  stored text the edit started from and the edited text (1 MiB bounds). Codec/key logic lives in
  `roster-document-draft.ts`; the platform-bound controller lives in `roster-document-store.ts` so
  the codec stays unit-testable.
- On open without an in-window copy, parked text is restored with its original baseline; if the
  stored document differs from that baseline, the existing stored-text comparison opens
  immediately. Save success, "Use stored text" and "Discard document draft" clear both copies;
  "Keep draft and close" keeps them. A peer-window write requires keep/use-saved review.
- First native attempt failed on a test expectation only: role loaders trim document boundaries,
  so the stored text shown lacks the trailing newline written to disk. The product behavior
  (restore and immediate comparison) had already passed; the assertion now compares trimmed text,
  consistent with the component's documented trim contract. The first unit run also failed to load
  because the codec module imported the platform layer; it was split as above.
- Checks: desktop **423 tests / 88 files PASS** (shared tree includes unrelated concurrent work);
  new `roster-document-draft.test.ts` covers key separation, owner refusal and size bound.
  Typecheck **247 PASS**; Biome PASS; Rust fmt PASS; native Rust **21 tests PASS**.
- Native `--roster` on portable identity `4700df703def-344ee89c60b0`, bundled engine/checksums
  verified: **exit 0 / PASS**, including reload restore of an identity draft and the immediate
  comparison after an external `identity.md` change, then reviewed cleanup. All existing roster
  scenarios still pass. The engine was built from the shared tree with another agent's uncommitted
  core/cli edits.
- Not covered: runtime-override and role-input durability, full application restart for role
  documents, multi-window UI stress, full repository release/coverage, hosted CI and installed-app
  replacement.

## Durable roster runtime overrides and a stale-snapshot fix (2026-10-29)

- `RosterRuntimeEditor` stores its unsaved override and baseline through `DurableFormDraft` under
  `roster-runtime:<sha256(['roster-runtime', role])>` (new Rust allow-list prefix; pure codec in
  `roster-runtime-draft.ts`, controller in `roster-document-store.ts`). Restored drafts keep their
  baseline; saving still goes through the existing three-way `mergeRosterConfig` against the
  current store. Save success, "Discard runtime draft" and "Reload stored runtime" clear both the
  in-window and native copies.
- Found during native acceptance: opening the editor right after a save used the parent's roster
  snapshot, which can still predate that save. The existing merge then correctly refused the
  user's next edit as "changed elsewhere". This was a latent timing race; extra native IPC from
  draft autosave made it reproducible. Without an in-window draft the editor now reads
  `agent-roster.read-customization` itself on open and keeps its fields and save button disabled
  ("Reading stored runtime…") until that read or the native restore completes.
- Other native iterations: one failure came from the existing test expecting the old recovery
  sentence (the copy now says saving merges with the current runtime); one came from the new test
  expecting a number where the draft keeps form text (numbers are converted on save). A temporary
  diagnostic that reports the stored native value on timeout was kept in the test.
- Checks: desktop **425 tests / 89 files PASS** (shared tree includes unrelated concurrent work);
  new `roster-runtime-draft.test.ts`. Typecheck **248 PASS**; Biome PASS; Rust fmt PASS; native
  Rust **21 tests PASS**.
- Native `--roster` on portable identity `45a1ed3344e1-344ee89c60b0`, bundled engine/checksums
  verified: **exit 0 / PASS**, including the full existing runtime save/merge/conflict flow,
  role-document drafts and the new runtime-draft reload restore plus explicit discard. The engine
  was built from the shared tree with another agent's uncommitted core/cli edits.
- Not covered: role-input durability, full application restart for runtime drafts, multi-window UI
  stress, full repository release/coverage, hosted CI and installed-app replacement.

## Durable roster role text inputs (2026-10-29)

- Unsent per-role teach, improve, instruction and capture text in `ProjectAgentRoster` is kept
  through `DurableFormDraft` under the project form key `roster-inputs` (new Rust allow-list
  literal). Only roles with typed text are stored; capture results are not inputs. On open, saved
  text fills roles that have no text in this window; persistence follows the input state, so the
  existing clears after successful actions also clear the native copy. A peer-window write asks
  for keep/use-saved.
- Checks: desktop **427 tests / 90 files PASS** (shared tree includes unrelated concurrent work);
  new `roster-input-draft.test.ts` (keep-only-typed rule, envelope refusal including prototype
  keys and size). Typecheck **249 PASS**; Biome PASS; Rust fmt PASS; native Rust **21 tests PASS**.
- Native `--roster` on portable identity `eb233c0c12d0-344ee89c60b0`, bundled engine/checksums
  verified: **exit 0 / PASS** on the first run. The existing cross-project unsent-instruction case
  now also confirms the acknowledged native copy, restores it after a real renderer reload and
  verifies that clearing the field removes the native copy. The engine was built from the shared
  tree with another agent's uncommitted core/cli edits.
- Not covered: the role-creation dialog, full application restart, multi-window UI stress, full
  repository release/coverage, hosted CI and installed-app replacement.

## Diff-focused skill draft review (2026-10-29)

- The skill draft review panels (older edits against a changed file, and peer-window conflicts)
  now reuse the existing bounded Myers `DiffPreview` instead of two full-text panes: changed lines
  with context, added/removed counts, unified/side-by-side modes and "Show entire file". The
  now-unused `.skill-draft-compare` styles were removed.
- Checks: desktop **427 tests / 90 files PASS**; typecheck **249 PASS**; Biome PASS.
- Native `--skills` on portable identity `236f5103eeb4-344ee89c60b0`, bundled engine/checksums
  verified: **exit 0 / PASS**. The draft scenario now also asserts the removed `## External change`
  line and the added `## Parked edit` line in the review. Inspected
  `skills/native-skill-draft-review.png`: the difference is visible without scrolling.

## Line-range file references in the composer (2026-10-29)

- `ComposerFileReference` gains an optional inclusive 1-based `lines` range. The desktop-owned wire
  contract lists `- "path" lines A-B`, adds one sentence that ranges mark the relevant section (read
  beyond them when needed) only when a range exists, and keeps the original read contract as the
  final line, so older messages still parse. One reference per file; the last range wins.
  `splitReferenceMessage` now returns `references` (with ranges) beside `paths`; reversed, zero,
  fractional or oversized ranges make the block untrusted. Stop/edit, queue copy and restore paths
  now keep ranges; saved-draft validation accepts only valid ranges.
- New `ComposerReferenceChips` shows `path:A-B` chips with a range editor and a bounded 40-line
  preview read through the real `files.read`, reporting binary/too-large files and ranges past the
  end of file. Sent user messages show the same labels.
- Checks: desktop **428 tests / 90 files PASS** (reference model test extended for range roundtrip,
  labels, reversed-range refusal and bounds); typecheck **250 PASS**; Biome PASS (three
  pre-existing CSS specificity warnings in `composer-resources.css`).
- Native `--composer` on portable identity `caaaf17d0999-344ee89c60b0`, bundled engine/checksums
  verified: **exit 0 / PASS** on the first run. The resource scenario sets lines 1-2 on README.md,
  previews the real lines, keeps the range across a tab switch (native draft), finds
  `- "README.md" lines 1-2` in the prompt received by the fixture provider and shows
  `README.md:1-2` in the sent message. All other composer scenarios still pass.
- Not covered: snippet references, choosing a range from the file viewer, full application restart
  with a ranged reference, multi-window stress, full release/coverage, hosted CI and installed-app
  replacement.

## File-viewer line references (2026-10-29)

- The session's file viewer gains "Reference in conversation". It maps the current selection to an
  inclusive line range (textarea offsets in edit mode via the new `selectionLineRange`, or the
  `data-source-line` rows of the selection in read mode), attaches it to the owning conversation
  (one reference per file; a new selection replaces that file's range) and returns to chat. With
  no selection the whole file is referenced. A line range over unsaved editor text is refused,
  because the conversation reads the file from disk. The button keeps the page selection on press.
- Checks: desktop **431 tests / 91 files PASS** (new `selection-line-range.test.ts`: offsets to
  lines, trailing-newline boundary, reversed and empty selections); typecheck **250 PASS**; Biome
  PASS.
- Native `--composer` on portable identity `939217fff5ca-344ee89c60b0`, bundled engine/checksums
  verified: **exit 0 / PASS** on the first run. The resource scenario opens the session Files
  view, selects README line 1 in the real viewer, references it, returns to chat with the draft
  text intact and a `README.md:1` chip, then continues with the chip range editor (1-2) and the
  provider-prompt assertion. All other composer scenarios still pass.
- Not covered: snippet references, the edit-mode path and the unsaved-text refusal natively (unit
  only for the offset mapping), full application restart, multi-window stress, full
  release/coverage, hosted CI and installed-app replacement.

## Durable roster role creation and per-project field controllers (2026-10-29)

- The roster role-creation form now uses `usePersistedFields` under the project form key
  `roster-create` (new Rust allow-list literal): it restores after a reload with a visible status,
  and creating a role (which resets the form) or emptying it clears the native copy.
- Fix found while wiring it: `usePersistedFields` cached controllers by form key alone, so a fixed
  key such as `requirement-resource-input:new` opened in two projects in one window would reuse
  the first project's storage. Controllers are now cached per storage object, then per key.
- Checks: desktop **431 tests / 91 files PASS**; typecheck **250 PASS**; Biome PASS; Rust fmt PASS;
  native Rust **21 tests PASS**.
- Native on portable identity `98cccb64fbb7-344ee89c60b0`, bundled engine/checksums verified:
  `--roster` **exit 0 / PASS** (new create-draft reload restore and clear, plus all roster
  scenarios) and `--sdd` **exit 0 / PASS** (requirement resource inputs after the controller-cache
  change). Both on the first run. The two-project collision itself has no native case.
- Not covered: full application restart, multi-window stress, full release/coverage, hosted CI and
  installed-app replacement.

## Virtualized file tree and paged folder listing (2026-10-29)

- The Files directory tree is now `FileTreeView`: it flattens the expanded tree (or the search
  matches with their ancestors) in one pass and mounts only the rows in view plus overscan.
  Rows announce `aria-setsize`/`aria-posinset`; arrows, Home and End move by row position across
  the whole tree, scrolling the target into the window before focusing it.
- The folder listing beside the tree renders 200 entries at a time with a "Show N more · M not
  shown" control; a new folder, search or sort starts again at the first page.
- Checks: desktop **435 tests / 92 files PASS** (new `file-tree-rows` unit tests, including a
  20,000-entry single-pass case); typecheck **252 PASS**; Biome PASS on the changed files.
- Native `--files` on portable identity `38767aa2f284-344ee89c60b0`, bundled engine/checksums
  verified: **exit 0 / PASS** on the first run. The new scale scenario creates 3,000 files in one
  folder: 35 tree rows mounted, folder listing 200 then 400 rows after paging, End reaches the
  last row of the whole tree, Home returns, and search for the deepest file keeps only matches.
  The engine bundle was built from the shared tree and may include other in-progress core/cli
  edits.
- Not covered: very deep (not wide) trees, trees whose engine listing itself is truncated,
  screen-reader announcement checks, full application restart, full release/coverage, hosted CI
  and installed-app replacement.

## Quoted snippet references (2026-10-29)

- The session file viewer gains "Quote selection": the selected text itself (editor or read-only
  viewer, mapped from the rendered lines back to file offsets) is attached as a reference with a
  `snippet`, bounded to 8,000 characters (larger selections are refused with a message, never
  truncated). Line numbers are kept only while the text matches the disk; unsaved editor text can
  be quoted without them. The wire line is `- "path" lines A-B snippet "<JSON string>"` plus a
  note that the file on disk may differ; parsing refuses blank or oversized quotes, and saved
  composer drafts validate the field. Chips show a short summary and a quote view with
  "Reference whole file instead". One reference per file still applies.
- The changes landed inside the concurrent release commit `5d3381d1f` (made by another session
  while this increment was uncommitted); the history was left as is.
- Checks: desktop **440 tests / 93 files PASS** (new `snippet-references` tests: round trip with
  quotes, newlines and reference syntax inside the snippet, refusal of blank/oversized quotes,
  labels, offset mapping, editor quoting with and without unsaved text); typecheck **253 PASS**;
  Biome PASS on the changed files (one pre-existing `aria-label` warning on the range preview).
- Native on portable identity `db684e710b9b-a8c846e0049d`, bundled engine/checksums verified:
  `--composer` **exit 0 / PASS** on the first run: line 1 is selected in the real read-only viewer,
  quoted, shown in the quote view, and the provider prompt carries
  `- "README.md" lines 1-1 snippet "<line 1>"` with the snippet note; the human bubble shows the
  quote label. `--files` failed once at the existing git-hunk step ("Hunks refresh after staging
  timed out", unrelated code path) and passed on an unchanged rerun with the same bundle; the
  timeout is undiagnosed.
- Not covered: native quoting from the editor and from unsaved text (unit only), multi-line DOM
  selections in the viewer, full application restart, full release/coverage, hosted CI and
  installed-app replacement.

## Restart-safe mailbox compose drafts (2026-10-29)

- The project mailbox draft store now writes the unsent message to the native project form
  `mailbox-compose` (new Rust allow-list literal) through `DurableFormDraft` with a versioned,
  bounded envelope (`version: 1`, the seven draft fields only; body up to 200,000 characters,
  other fields up to 2,000; foreign shapes are refused). An empty window adopts the saved draft
  and says so; a window that already holds typed text keeps it. The saved copy is removed only
  after the engine confirms the send (newer edits are kept) or when the draft is discarded; a
  failed send keeps both. A version saved by another window stops autosave until the user keeps
  this window's message or uses the saved one. Load and save failures are shown with a retry.
- Checks: desktop **445 tests / 94 files PASS** (new `mailbox-draft-durable` tests: restart
  restore, failed then confirmed send, edits during a pending send, typed-before-load, both
  review choices including edits typed during review, envelope refusal); typecheck **254 PASS**;
  Biome PASS; Rust fmt PASS; native Rust **21 tests PASS** (allow-list and project isolation).
- Native on portable identity `83bf57d21b2c-b9af8f76b4a5`, bundled engine/checksums verified:
  `--mailbox` **exit 0 / PASS**: the refused broadcast draft is read back from native storage,
  restored after a renderer reload with its type and body, and the stored copy is gone after the
  confirmed send. `--roster` **exit 0 / PASS** (shared allow-list change). Both on the first run.
  The engine bundle was built from the shared tree and may include other in-progress edits.
- Not covered: the two-window review natively (unit only), a full application process restart
  for this form, full release/coverage, hosted CI and installed-app replacement.

## Restart-safe automation job drafts (2026-10-29)

- Unsaved automation job drafts (per job id, plus the new-automation draft) are now written to the
  native project form `automation-drafts` (new Rust allow-list literal) through `DurableFormDraft`.
  The envelope is versioned and bounded (50 drafts, 1 MB); a job draft is accepted only under its
  own job id and a new draft never carries a saved record. A new window restores the job that was
  open and says so; the other drafts return when their job is opened. Nothing is written until
  the saved drafts have been merged, so loading never erases them. A draft is removed after its
  engine save succeeds or after "Discard draft / reload saved". Another window's newer version
  stops autosave until this window's drafts or the saved ones are chosen. A draft whose job was
  saved again since it started now shows a stale-revision warning before the engine refuses
  the save.
- Checks: desktop **447 tests / 95 files PASS** (new `automation-draft` tests: project-scoped
  projection as a copy, round trip, refusal of foreign/mismatched/prototype/oversized envelopes);
  typecheck **256 PASS**; Biome PASS; Rust fmt PASS; native Rust **21 tests PASS**.
- Native on portable identity `32ceed56aeb1-b9af8f76b4a5`: `--automation` **exit 0 / PASS** on the
  first run. Both projects' drafts are read back from native storage separately; after a renderer
  reload the open Alpha job draft is restored with its notice and the new-automation draft
  returns; the existing stale-save refusal still holds; the explicit discard removes the job
  draft from storage. The engine was **not rebuilt** for this run: `build:engine` failed on
  another session's uncommitted `packages/webui-server` change (type errors in
  `conversation-operations.ts`), so the run reused the previous bundled engine `b9af8f76b4a5`
  (this change has no engine part).
- Not covered: the two-window review natively (unit-level behaviour comes from the shared
  `DurableFormDraft`), unapplied environment dialog text (durable only after Apply moves it into
  the job draft), a full application process
  restart, full release/coverage, hosted CI and installed-app replacement.

## Bulk move and delete in the Files folder listing (2026-10-29)

- The folder listing gains "Select items" (rows become toggle buttons with `aria-pressed`) and
  Ctrl/Cmd-click picking outside that mode. A toolbar shows the count with "Move selected…",
  "Delete selected…" and "Clear selection". The dialog lists the items, drops those already
  inside a selected folder, refuses items with unsaved editor text and moving a folder into
  itself, keeps dot-folders in the destination (`.github`), and runs one existing engine
  operation (`files.move` / `files.delete`) per item in order. Failures are recorded and the rest
  still run; "Stop after current item" leaves the remainder unattempted; the notice states
  exactly what moved or was deleted, failed or was not attempted. There is no multi-item
  atomicity. Open documents, the active file and the current folder follow moved items; the
  single rename/move/delete actions now share the same helpers.
- Checks: desktop **451 tests / 96 files PASS** (new `file-bulk` tests: ancestor folding,
  relocation, destination normalisation, failure recording, stop); typecheck **258 PASS**;
  Biome PASS on the changed files.
- Native `--files` on portable identity `f90534a62d27-b9af8f76b4a5`: **exit 0 / PASS** on the first
  run. Two files picked in selection mode are moved into another folder and checked on disk; a
  Ctrl-clicked file is deleted and checked on disk; the tree-scale and all existing file
  scenarios still pass. The engine was **not rebuilt**: `build:engine` still fails on another
  session's uncommitted `packages/webui-server/src/server/conversation-operations.ts` type
  errors, so the run reused bundled engine `b9af8f76b4a5` (this change has no engine part).
- Not covered: the unsaved-text and into-itself refusals natively (UI logic only), a failing item
  in a native batch, stop mid-run, and search-mode selections across folders.

## Restart-safe session model plan drafts (2026-10-29)

- Unsaved edits in the session "Agent model plan" dialog are written to a new native session
  draft part `plan` (`draftplan:<session>` settings row, revision-checked through the existing
  `draft.save` compare-and-set; new trusted read `draft.plan`; object-only, 512 KiB limit; an
  empty value removes it). The envelope keeps the plan together with the engine plan it was
  edited from, and re-checks the plan with the same projection used for engine replies.
- On open, a draft whose base still equals the engine plan is restored with a notice. A draft
  edited from an older plan is not applied: the dialog shows the current plan and offers
  "Use my older draft" or "Discard saved draft". Saving (verified readback), "Discard plan and
  reload" and "Discard plan and close" remove the stored draft; another window's version stops
  autosave until a choice is made. Draft storage starts only after the engine plan was read.
- Checks: desktop **453 tests / 97 files PASS** (new `session-agent-plan-draft` envelope tests);
  typecheck **260 PASS**; Biome PASS; Rust fmt PASS; native Rust **21 tests PASS** (the session
  draft test now covers plan object-only refusal, CAS conflict, per-session isolation and
  removal).
- Native `--composer` on portable identity `3335d8e24b8f-b9af8f76b4a5`: **exit 0 / PASS** on the
  first run. A lane label edit is read back from `draft.plan`, survives a renderer reload with
  the restore notice, and after the engine plan changes the older draft is offered instead of
  applied and is removed by "Discard saved draft"; all existing plan, composer and resource
  scenarios still pass. The engine was **not rebuilt**: `build:engine` still fails on another
  session's uncommitted `packages/webui-server/src/server/conversation-operations.ts`, so the
  run reused bundled engine `b9af8f76b4a5` (this change has no engine part).
- Not covered: "Use my older draft" and the two-window review natively, session deletion
  cleanup of the stored part (like the other session draft parts, it is not removed), full
  application restart, full release/coverage, hosted CI and installed-app replacement.

## Code paste hint with wrap and undo (2026-10-29)

- Pasting multi-line text into the composer that is mostly code-shaped (at least two non-empty
  lines, 60% code-like, no fence of its own, caret not inside an open fence) shows a hint. The
  paste happens normally; nothing changes until "Wrap in code block" is chosen. The fence is
  longer than any backtick run in the text, placed on its own lines, and names a language only for
  unambiguous JSON, Python, Rust, Go or shell. "Undo wrap" restores the exact previous draft while
  the draft still equals the wrapped result; editing the pasted text or dismissing removes the
  hint.
- Defect found by the native run: Windows clipboards supply CRLF while the textarea stores LF, so
  the "pasted text is still in place" check never matched and no hint appeared. Clipboard text
  is now normalised like the textarea before comparison (unit-tested).
- Checks: desktop **459 tests / 98 files PASS** (new `paste-code` tests: detection, language,
  prose/single-line/fenced refusal, fence state, CRLF normalisation, wrap range, fence length);
  typecheck **262 PASS**; Biome PASS on the changed files.
- Native `--composer` on portable identity `4cec30a177b8-29621d686286`, bundled engine/checksums
  verified (engine rebuilt from the shared tree): the first run **failed** on the CRLF defect
  above; after the fix **exit 0 / PASS**. A real system-clipboard paste of Python shows the
  hint, leaves the paste unchanged, wraps it as a `python` fence, undoes back to the exact paste,
  and a prose paste shows no hint. The test writes the system clipboard, like the existing
  copy/paste scenario.
- Not covered: paste replacing a selection natively, dismiss natively, very large pastes and
  non-Windows clipboards.

## Prompt journal month filter, window notice and export (2026-10-29)

- The prompt journal gains a month filter (the engine's existing `month` bound), so older history
  is reached month by month and narrowed further by date. When an engine read returns a full
  newest-N window for a category, the footer states that older entries exist and were not
  loaded. "Export JSONL" downloads the visible entries exactly as the engine returned them;
  "Export Markdown" writes a readable document whose prompt text is fenced with a fence longer
  than any backtick run, and records the scope, filters, search and any window truncation.
- Not implemented, by design: cursor paging past the newest window. `PromptJournalFilter` has no
  `before` bound, and adding one is a Core change that the snapshot hook blocks while another
  session's uncommitted `packages/core` work exists. Each engine read still scans the selected
  month/day files.
- Checks: desktop **462 tests / 99 files PASS** (new `journal-export` tests: JSONL round trip,
  fencing, metadata line, file name); typecheck **263 PASS**; Biome PASS on the changed files.
- Native `--composer` on portable identity `11c43f0c9ad3-5e3cca867eec`, bundled engine/checksums
  verified (engine rebuilt from the shared tree, which may include other in-progress edits):
  **exit 0 / PASS** on the first run. The current month shows the recorded prompt, `2000-01`
  shows the empty state, clearing restores it; JSONL and Markdown downloads land on disk, the
  JSONL lines are this session's engine records including the real recorded prompt, and the
  Markdown starts with the title and fences that prompt.
- Not covered: the truncation notice natively (needs more than 100 recorded prompts), very large
  journals, and project-scope exports.

## Prompt journal older-page loading (2026-10-29)

- Core: `PromptJournalFilter` gains an inclusive `until` timestamp. `getPromptJournalEntries`
  applies it per entry and, because the recorder names `<YYYY-MM>/<YYYY-MM-DD>` directories from
  the entry's own UTC timestamp (the only writer), skips month/day directories outside both
  `since` and `until` instead of reading them. The WebUI server passes the filter through
  unchanged; the core public API snapshot is refreshed by the pre-commit hook.
- Desktop: the journal reads 100 entries per category and keeps one cursor per category (its
  oldest returned timestamp while its page was full). "Load older entries" requests the next page
  of each category that has one, de-duplicates the inclusive bound by id, and stops a category
  that returns nothing new, so a host that ignores `until` cannot loop. Per-category cursors stop
  a sparse category from jumping a dense one past entries it has not returned. "Load a larger
  window" is removed; it re-read the newest window and discarded loaded older pages.
- Checks: new core `prompt-journal-paging` tests (paging across days and months with the
  inclusive bound, `since`+`until` together) plus the existing journal and recovery tests:
  **10 PASS**; desktop **465 tests / 100 files PASS** (new `journal-paging` tests); typecheck
  **264 PASS**; Biome PASS on the changed files; engine build (including declaration emit) PASS.
- Native `--composer` on portable identity `d88dbb062ed2-85f80316bf28`, bundled engine rebuilt
  from the shared tree with this change: **exit 0 / PASS** on the first run. 150 prompts seeded
  for this session in a January directory make the first page full; the footer reports older
  entries, one "Load older entries" page reaches the oldest seeded prompt, and the notice
  disappears once nothing older remains.
- Not covered: journals spanning many thousands of files, project-scope paging natively, and the
  older-host path (unit only).

## Refinement reviews kept across restart (2026-10-29)

- A completed refinement review (the refiner's refined/English text and provenance, the chosen
  version and any edits, plus the original, delivery mode, draft-at-open and fresh-context
  choice) is written to a new native session object part `refine` (`draftrefine:<session>`,
  4 MiB, object-only, revision-checked). The Rust object-part support added for model plans is
  generalised: one `draft.object` read with an explicit part replaces `draft.plan`. Only the
  reviewable reply fields are persisted.
- After a restart the composer offers "A refined prompt from … is waiting for review" with
  "Review refined prompt" (reopens it without a new refiner request) and "Discard refined
  prompt". The saved review is removed after Apply, a successful send, Keep original or the
  discard; a failed send keeps it. Closing a new request before its reply leaves an older saved
  review untouched. A request still waiting for the refiner cannot survive a restart.
- Found by the native run: sending immediately after a reload was refused while session history
  was syncing ("The session history is still syncing"), and the refinement error repeated "Your
  draft is kept." twice. "Approve & send" now shows "Syncing history…" and stays disabled until
  history is synced, and the suffix is added only when missing.
- Checks: desktop **468 tests / 101 files PASS** (new `refinement-draft` tests); typecheck
  **266 PASS**; Biome PASS on the changed files; Rust fmt PASS; native Rust **21 tests PASS**
  (refine part revision, unknown part refusal).
- Native `--composer` on portable identity `14c006b436ad-000e11e0b0af`, bundled engine
  `000e11e0b0af` built from the shared tree: the first run **failed** on the history-sync refusal
  above (diagnosed with a test that now reports the dialog's alert text); after the fix **exit 0
  / PASS**. The edited English review is read back from `draft.object`, restored after a renderer
  reload with its edit and chosen version and no extra refiner call, sent, and removed from
  storage; the attachment and topic-boundary refinement scenarios in the same scope still pass.
- Not covered: two-window review conflicts natively, discard natively, full application restart.

## Refinement comparison with the original (2026-10-29)

- The refinement review gains "Compare with original": a word-level comparison (words and the
  whitespace between them, so both texts are reproduced exactly) of the selected or edited
  version against the original draft, with added/removed word counts. The comparison trims the
  common prefix/suffix and is bounded (3,000 tokens per side and a 1M-cell table for the changed
  middle); larger texts show a message instead of stalling. A note marks versions that include
  the reviewer's own edits.
- Checks: desktop **471 tests / 102 files PASS** (new `word-diff` tests: exact reconstruction,
  marked words, identical input, size refusals); typecheck **268 PASS**; Biome PASS on the
  changed files.
- Native `--composer` on portable identity `5ba6874b09da-000e11e0b0af` (frontend-only change,
  bundled engine `000e11e0b0af` reused): **exit 0 / PASS** on the first run. After the real
  refiner reply, the comparison shows added words and the shared text; all refinement, restore,
  attachment and topic-boundary scenarios in the scope still pass.
- Not covered: the size-refusal message natively and screen-reader announcement of `ins`/`del`.

## Validated context editor for whole-message removals (2026-10-29)

- The context panel gains "Edit context…": the engine's `context.editor.open` snapshot is listed
  with role, preview, token estimate and warnings per message. Choosing a user message also
  removes the assistant replies the engine pairs with it (shown as such). "Check removal" sends
  the exact proposal (remaining messages plus the removal plan, against the snapshot revision)
  to `context.editor.validate` and shows the before/after message and request-token metrics,
  the protocol-repair preview, warnings, errors or a revision/run conflict. "Remove N messages"
  is enabled only after a passing check for the same selection; the panel then re-reads the
  snapshot. The transcript on disk is unchanged. Range edits inside a message are not offered.
- Engine defect found by the native run: `context.editor.validate` and `context.editor.apply`
  were missing from the session route's reply correlation, so their replies carried no
  `requestId` and a desktop request could never settle (the engine had actually accepted the
  plan). `packages/webui-server/src/server/session-routes.ts` now correlates both, with
  `context.editor.validation` as a reply type; a successful apply settles on the correlated
  `key.operation_result` while `context.editor.applied` stays a broadcast. New
  `session-route-correlation` case: **FAIL** on the previous file, **PASS** with the fix. The
  desktop also treats a refused plan (a rejected request carrying `ok: false`) as a validation
  result instead of a generic error.
- Checks: desktop **474 tests / 103 files PASS** (new `context-editor-model` tests); webui-server
  correlation/session-route/dispatcher/context tests **77 PASS**; a local proof against the real
  `validateContextEditorProposal` accepted the desktop proposal (4 → 2 messages); typecheck
  **270 PASS**; Biome PASS on the changed files.
- Native `--composer` on portable identity `8c112691755c-5390544472ff`, bundled engine rebuilt
  with the fix: earlier runs **failed** (first on a `role` that hid the validation region — a
  desktop markup mistake — then on the missing correlation above); with both fixes **exit 0 /
  PASS**. The oldest user turn is selected, apply stays disabled until the engine check passes,
  the check reports "Valid", the removal applies and `context.debug` shows exactly that many
  fewer messages; the existing inspector, repair and clear steps still pass.
- Not covered: conflict and run-active refusals natively, protocol-repair cases with tool
  pairs, very large contexts, and the WebUI editor (its listeners are not request-correlated;
  the added `requestId` is additive).
