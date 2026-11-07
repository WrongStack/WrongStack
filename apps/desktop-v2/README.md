# WrongStack Desktop v2

Native Tauri application for multiple projects and persistent WrongStack sessions.
It does not open or embed the WebUI app. The shell, conversations and desktop-only tools belong
to this application; the project surfaces it shares with the WebUI (SAGE memory, Kanban, Code
Atlas, agent office, Session Story, context and analytics dashboards, engine diagnostics, setup)
are compiled in from `@wrongstack/project-surfaces` and fed by desktop host adapters. Every screen
follows the profile's display language (`uiLocale`): English, Turkish, German, French, Italian,
Spanish or Brazilian Portuguese. The composer runs the engine's command catalog, so the TUI's
slash commands (`/git`, `/commit`, `/spawn`, `/acp`, `/tuneup` and more) work here; a command
that changes or deletes data runs only when the same draft is sent again.

## Install

Every GitHub release attaches one installer per platform. Each carries the application and the
bundled WrongStack engine, and installs them side by side:

| Platform | Download | Notes |
| --- | --- | --- |
| Windows x64 / arm64 | `wrongstack-desktop-<version>-windows-<arch>-setup.exe` | Per-user install, no administrator rights. Installs WebView2 if it is missing. |
| macOS Apple silicon / Intel | `wrongstack-desktop-<version>-macos-<arch>.dmg` | macOS 13 or later. Ad-hoc signed, not notarized: open it once with Control-click → Open. |
| Linux x64 / arm64 | `wrongstack-desktop-<version>-linux-<arch>.deb` or `.rpm` | Installs to `/usr/bin`; needs WebKitGTK 4.1 (Ubuntu 22.04+, Debian 12+, Fedora 39+). |

`DESKTOP-SHA256SUMS` lists every installer's checksum, and each has a GitHub build-provenance
attestation (`gh attestation verify <file> --repo WrongStack/WrongStack`). No AppImage is
published: the session host outlives the window and keeps running engines from the install
path, which an AppImage unmounts when the window closes.

## Build the installer

`bun run desktop:v2:build` compiles the engine for this machine's Rust target, bundles it as the
Tauri sidecar (`binaries/wrongstack-engine-<target-triple>`) and writes this platform's installer
under `src-tauri/target/release/bundle/` (Windows `nsis/`, macOS `dmg/`, Linux `deb/` and `rpm/`).
The installer settings live in `src-tauri/tauri.bundle.conf.json`, merged only for this build, so
`bun run desktop:v2` never needs a compiled engine. `.github/workflows/desktop.yml` runs the same
build natively on Windows, macOS and Linux (x64 and arm64) and checks that each installer carries
the engine.

The build also stages an immutable portable copy for local acceptance runs under
`dist-native/<ui-hash>-<engine-hash>/`, with `dist-native/latest.json` naming the newest one:

- `wrongstack-desktop-native[.exe]` — the application to open.
- `wrongstack-engine[.exe]` — the bundled WrongStack runtime; keep it beside the application.
- `SHA256SUMS` — checksums for both executables.

Bun, Node, repository files, and workspace packages are not required on the target machine; the
OS webview (WebView2, WKWebView or WebKitGTK) is the only runtime dependency. The engine uses the
canonical standalone bootstrap and daemon/script dispatch, with only backend runtime assets.
WebUI frontend bundles are excluded. Static WrongStack logos and canonical color tokens are
synchronized at build time; the shared surfaces read theme tokens generated from the WebUI
stylesheets inside their own frame, and no WebUI bundle or runtime stylesheet is loaded. The
executables carry no publisher signature yet. The native icons are owned original assets in `src-tauri/icons`; brand
synchronization does not require the legacy Electron application.
New builds leave binaries used by open sessions in place. Existing sessions remain on their
original host; an older host can run beside a newer project-service host without restarting them.

Context-price tier authoring uses the catalog's `tier.type=context` and `tier.size` format.
Add, reorder or remove tiers, review saved rates, distinguish explicit zero from unspecified prices,
and retain unknown/provider-specific metadata. Nested legacy over-200k schedules remain readable
and survive unrelated edits. Saved tier changes are compared exactly after readback. Tier metadata
is separate from the current-rate Usage & cost estimate; this editor does not implement tier billing.

Model editor forms are retained in native SQLite in the desktop profile context, with one parked
editor per verified profile and provider. The runtime identifies its actual profile config file with an\nopaque ownership ID; the ID is checked before model catalog reads and writes. Recovery is opt-in and keeps the original saved-definition baseline, reasoning
controls and unfinished price tiers. Autosave does not apply provider settings. Compare conflicting
window drafts before choosing; successful model save/readback or explicit discard uses acknowledged,
revision-checked cleanup. Project/session drafts use their own storage and are not involved. Earlier unassigned drafts have\na separate review/copy/discard flow. Explicit copying retains the source and does not apply model\nsettings; changed source revisions and occupied profile drafts are protected.
Targeted restart acceptance terminates the actual UI process and, separately, its isolated host
and engines. Fresh WebViews restore acknowledged drafts without applying settings, retain the
original model baseline, refuse stale model writes and keep confirmed discards cleared.

## Develop

Conversation Tools includes a dedicated Usage & cost workspace. It separates accumulated token
traffic, the last provider-reported request and the engine's current context snapshot; shows
per-provider cache traffic, optional TTL splits and a qualified cache-read discount estimate;
and offers live/manual refresh without disturbing the chat draft. Pricing distinguishes known,
partial and unavailable aggregate rates, including saved model overrides and explicit zero rates.
Current-rate estimates do not reconstruct historical model routing, tiers or TTL-specific bills.

With the pinned Bun version, Rust/MSVC, and WebView2 installed, from the repository root:

```powershell
bun install --frozen-lockfile
bun run build
bun run desktop:v2
```

The launcher supplies absolute Bun and desktop engine entry paths. The native shell does not
need `packages/webui/dist`. `engine/main.ts` reuses shared backend services and transport from
`@wrongstack/webui-server`, with an empty static directory and browser opening disabled.
That package supplies backend services, not UI.

```powershell
bun run desktop:v2:build
```

The build first compiles the backend dependency closure, packages a standalone engine, builds
the Tauri application, and stages the portable folder. The native host discovers the engine beside
the application, before copying itself into its persistent host directory. Development still
uses the Bun/script paths supplied by the launcher. `WRONGSTACK_DESKTOP_ENGINE` may select an
explicit engine executable. There is no fallback to `wstack --webui`.

## Implemented

- Native Git hunk review separates index-to-working-tree and HEAD-to-index changes, with
  explicit stage/unstage per server-generated hunk and stale-diff refusal. Worktree bytes stay
  untouched. Partial operations currently support modified regular UTF-8 text files; whole-file
  controls handle other cases. Review notes persist per project in native SQLite, survive reload,
  reject stale-window saves and support explicit saved-note reload; anchors describe the reviewed
  version rather than claiming to track subsequent line movements.
- Three-way UTF-8 merge-conflict review shows the common base, ours and theirs, offers explicit
  side selection and an editable result, and saves/stages only after the reviewed file/index
  revision still matches. Remaining conflict markers are refused. Dirty close requires an
  explicit discard; stale-save errors retain the merge draft. Resolving does not create a commit.
- Conflict review distinguishes absent base/ours/theirs entries, supports add/add and modify/delete,
  and offers explicit deletion. Binary or non-UTF-8 sides are represented by recorded blob identity
  and size, with byte-preserving side selection instead of a text editor. Rename/rename conflicts
  are resolved per actual unmerged path; other paths are retained until explicitly handled. The
  selected side's executable index mode is preserved. Symlink/submodule and oversized blobs still
  require Git outside this resolver; binary blobs and working files are bounded to 2 MiB.
- Prompt refinement profile settings provide review-on-submit, preferred language, saved model
  catalogs, independent provider/model inheritance and named refiner profiles. Explicit sample
  previews report the actual provider/model without creating a conversation. Saving checks route
  and profile-chain conflicts; referenced profiles cannot be removed. The composer initially
  selects the preferred available language and still requires explicit approval to send.
- Refinement retry supports a searchable current-profile model picker without switching the chat
  model or changing profile defaults. Engine refusals retain recovery metadata for timeout,
  unusable output and provider guidance, explicit retry windows and suggested fallback actions.
  Model selection alone sends nothing; retry remains an explicit action and reports the actual
  model that completed the rewrite. Custom provider/model fields and configured-route reset remain.
  Config hot-reload preserves the active model's catalog/custom capabilities when rebuilding
  credentials, including vision and output limits after editing a custom refiner definition.
- Execution permission settings expose Standard, YOLO and YOLO+ as one explicit profile choice,
  with the canonical nine destructive-operation categories. Normal YOLO retains fixed trusted-state
  and credential prompts; YOLO+ clearly states that it bypasses the per-kind map while explicit
  deny rules still apply. Saves treat the two mode flags together, preserve independent category
  edits and reject stale mode changes. These defaults remain separate from existing session options.
- Dedicated Brain policy settings with explicit save/readback for risk and escalation, deterministic
  heuristics, decision quality/cache, monitor response, council thresholds and ledger/trace policy.
  Read configured rules, model references, effective council seats/judge and evidence locations.
  Drafts survive section navigation; changed-field preflight refuses stale edits and optional
  overrides can return to engine defaults. Profile runtime policy and session decision history
  have separate ownership. The model/council editor supports saved catalogs and custom model IDs,
  ordered fallback or round-robin pools, voting seats with server-published/custom lenses,
  optional weights and inherited/explicit veto, plus configured or derived judges. Target resets
  return to engine inheritance; mixed policy/target saves retain both sets of reviewed changes.
  A separate ordered seat-default rotation edits server-published/custom lenses and tri-state veto
  without replacing explicit voter models. Explicit voter preferences take precedence; missing
  preferences use the rotation. Add, reorder, remove or restore the built-in executor/skeptic/auditor
  defaults with stale-edit refusal and verified disk/readback persistence.
  Monitor settings include per-signal controls, failure/storm/stall/churn thresholds and windows,
  cooldown and custom file-edit tool matching. Replay trace exposes its destination and actual
  open-record capacity, including automatic destination reset. Signal writes retain other live
  switches. Brain section shortcuts and settings-search terms reduce navigation through the form.
  Monitor inheritance has a reviewed reset with default preview and undo before Save. Reset removes
  the whole monitor override group, rejects intervening monitor changes and preserves other Brain
  policies and independent trace edits; saved readback confirms that overrides were removed.
- Fleet & companions profile settings: concurrent-agent capacity without an arbitrary desktop
  ceiling, shared fleet-chat detail, Memory/Explore/Skill Companion eligibility and next-step
  prediction/tool availability. Explicit save/readback, draft discard and stale-field conflict
  refusal use the shared profile workflow. Companion toggles preserve existing budgets, signals
  and other nested configuration. These preferences do not assert a running companion instance.
- Session Side effects under Tools, with readable operation cards and recorded-input/outcome
  inspection, kind/search/sort controls, retained-runtime counts and an explicit latest-50 window.
  Copy or download the visible records as spreadsheet-safe CSV. Reads are session-owned and do
  not grant permissions or execute tools. Background shell launches record their audit entry
  before the streaming executor closes the final response.
- Project Live fleet with actual registered runtimes/agents, verified native session names,
  searchable runtime cards and a React Flow session-membership map. Inspect heartbeat/process and
  agent counters, explicitly read recent journal activity, and review session instructions with
  kind/priority/subject or cooperative interruption requests. Delivery receipts remain distinct
  from execution; the role catalog stays in Agent Roster. Request drafts are window-local and
  isolated by session and request kind.
- MCP resource/template/prompt browsing in profile settings, with explicit reads, typed prompt
  arguments, source-labelled Markdown previews and attributed text copy. Remote connections save
  the actual HTTP transport and explicit private-network policy; tool counts accept canonical tool
  names. Connection editing merges only reviewed changed fields, preserves hidden credentials and
  policy, and refuses competing edits to the same field. A real loopback MCP native test covers
  this workflow with zero projects and sessions.
- MCP content is also available from the composer's options menu: choose a connection, explicitly
  read a resource or resolve prompt arguments, review, then append attributed text to the existing
  saved draft. Remote role labels remain text and non-text omissions are explicit. Selection
  does not send a message or invoke a tool; normal submission and delivery controls remain in use.
- Session-owned MCP task receipts with search/status filters, independent metadata refresh,
  observer recovery and reviewed canonical cancellation. Reads do not create remote work;
  session permissions still apply. Native proof covers actual task invocation, isolation,
  UI reload, cancellation, polling-error recovery and a native task question/answer,
  rather than seeded task records.
- Session-owned process inspection with command/PID/tool/start-time details, background/protected
  status, registered output tails and reviewed single-process termination. A fresh registry check
  refuses a changed process identity before sending termination; native terminal tabs remain separate.
- Automation template review, typed reusable environments (setup/services/health/cache/ports),
  credential references and GitHub event filters; profile-aware job model choices and window-local
  drafts isolated per job/project. A run inspector presents independent verification, environment
  receipts, logs and patches, with canonical PR prepare/publication/CI/follow-up controls. Actual
  Docker execution and external GitHub publication remain separate validation gates.
- Project-owned Agent Roster with searchable role catalog, custom roles and an inheritance graph;
  readable resolved runtime details and typed model, budget, availability and capability overrides.
  Identity/directive editors, learning evidence, capture, skill affinity/pins/addenda and consolidation
  workflows use actual project files and engine services without a conversation. Writes preflight
  competing edits and verify readback; unsaved role forms are retained within the current window.
- Native project registry, project/session navigation, fleet wall, search, history, attention
  filters, activity timeline, command palette, and separate native project windows.
- Multiple agent and terminal sessions per project, persisted in SQLite.
- A project tree can expand several projects at once. The overview groups sessions by project;
  open session labels retain their project identity. Focused work removes repeated hero/session
  headings. Chat, files, and review stay close; project knowledge and configuration have their
  own workspaces rather than becoming conversation tabs.
- Native appearance settings provide System/Light/Dark modes and all 13 canonical WrongStack color pairs.
  SQLite stores the preference; a local cache avoids a mismatched initial paint. System mode
  follows device changes, and open xterm terminals update their colors without restarting PTYs.
- A dedicated session workbench replaces the fleet cards while working. Native session tabs
  survive UI restart; closing a tab detaches without killing the session. Unsent text drafts are
  stored per session in the native registry and restored after UI restart, together with attachment
  data, project file references and delivery mode. Concurrent draft writes are revision checked;
  conflicts preserve local work and show both versions before an explicit choice of which to keep.
  Returning to the fleet keeps the open tabs available.
- Dedicated desktop chat/composer, streamed messages, grouped session activity and readable approval
  cards with command arguments, edit previews and remembered policy scopes; completed-turn next
  steps can be selected and added to a draft. File review, skills reader,
  native provider/key onboarding, session model selection, reported token usage,
  and estimated cost.
- WrongStack Model visibility manages profile exclusions and favorites with an explicit draft/save
  cycle. Disabling reviews matching favorite/default/named-fallback removals; enabling explains
  shared bare-ID rules. Orphaned exclusion rules remain editable. Saves use current-value conflict
  checks and verified readback. Open session model pickers read current profile catalogs and rules,
  update favorites/provider/model exclusions while open, and recheck exclusions before an explicit
  switch. Session effort, draft and identity remain session-owned; broader live runtime policy
  synchronization remains open.
  Provider-wide exclusions have their own reviewed draft action, retain favorites/routes/credentials,
  and preserve individual model rules when re-enabled. Orphaned provider exclusions remain editable.
- Provider settings offers engine-discovered subscription sign-in methods, reviewed default/new
  account targets, reconnect, browser/device-code guidance and transient manual callback input.
  Attempt identities fence late status updates and stale cancellation. Successful replies trigger
  saved-credential readback; local credential removal uses the existing verified key lifecycle
  and does not revoke remote browser sessions. Live account authentication still needs acceptance.
- The session composer keeps model/effort beside one delivery-mode selector. BTW reaches the current
  leader without interrupting; persistent queued prompts belong to the engine. Stop-and-steer waits
  for the actual turn boundary and refuses ambiguous pending-queue ordering. Prompt refinement uses
  a focused original/refined/English review dialog, explicit approval, editing/retry and the real
  refine-before-send preference. See the [chat checklist](../../docs/desktop-v2-chat-parity.md) for
  the action-level inventory and remaining work.
  Advanced composer options include a session-owned Agent model plan: reusable parallel lanes,
  role overrides, labels, reasoning overrides, tier/fallback references and the current-profile
  model picker. Follow-session-model retains lane pins; disabling retains the plan. Explicit saves
  check for competing plan edits and verify readback. Profile routing, active chat model and chat
  drafts are preserved. Stored plans are journaled by the engine; unsaved editor forms are local.
  Canonical topic advice offers keep-draft/same/fresh context on idle normal sends. A fresh choice
  reaches the user turn only after any refinement approval; existing visible history is retained.
- The compact composer adds `@` project file references and canonical `$skill-name` completion,
  with keyboard insertion and caret restoration that never submits. Reference chips and drafts
  remain isolated across session tabs. Up/Down recalls prompts while retaining the unsent draft;
  native slash commands open actual desktop workspaces or acknowledged engine operations.
- Prompt library and journal are project-owned, available before creating a conversation. Templates
  support search/categories/favorites/recent, required/default/enum/multiline variables, Markdown
  preview, append-to-draft/copy and verified creation with an unsaved-close guard. The dedicated
  composer journal shortcut exposes real original/final records, filters and append reuse.
- The session context inspector separates current calibrated token estimates from billed usage,
  reads effective instructions explicitly and offers repair, normal/aggressive compaction and
  guarded provider-context clear. Clearing retains the native session and disk conversation.
- The composer accepts image/PDF picker, paste and drop, with local image normalization, explicit
  file/count/transport limits, thumbnails, named PDF cards and per-session draft retention. Binary
  files survive refinement and real queue persistence; running Message/BTW with files visibly queues
  a new turn. Canonical engine refusal retains the draft. Conversation images open a local preview;
  stop/edit restores the previous prompt and files. Draft media is stored locally across app restart.
- Desktop-owned Markdown chat supports headings, tables, lists, inline/fenced code, message/code
  copy controls, and project-file links through the engine. HTTP(S) links open through a validated
  native OS boundary. Raw HTML is skipped; images are represented by explicit links rather than
  automatically fetching remote content. Reading older messages pauses automatic scrolling.
- Session Tools opens a dedicated History & recovery workspace: recorded event search/filtering,
  file/tool activity and reviewed prompt checkpoints. Rewind refuses active runs and changed
  reviewed journals, reports file restoration errors, replaces the displayed transcript and keeps
  the separate composer draft. This does not provide a complete project backup or a Git checkout.
- Project tools provides a separate Session history library, also reached with `/sessions`.
  It filters recorded summaries, reads/searches retained messages without resuming an agent,
  pages long text with revision checks, shows tool/reasoning/document evidence, verifies name
  changes, appends selected text to an existing draft and returns to an identity-matched open
  desktop conversation. Explicit Resume and Continue a copy actions open an agent tab only after
  reviewing the journal/workspace behavior. Resume keeps the recorded identity; a copy inherits
  history into a separate journal. Both use current project files and send no prompt automatically.
  Hosts using an older bundled engine must release their conversations and restart before these
  actions are available. `/history` remains the prompt journal shortcut.
  The canonical catalog pages 50/100/200 summaries with counts and revision-checked navigation,
  including records beyond the legacy 1000-record list limit. Summary filters apply to the
  visible page. Search across conversations scans retained text across the project catalog,
  independently of that page, with progress, stop, role filters and excerpts. Selecting a result
  locates its actual catalog page and rechecks the transcript revision before opening the message.
  Membership/order changes require a fresh scan; unreadable records are reported. Legacy file
  stores explicitly report a partial catalog at their 10,000-record scan budget. Older runtimes
  without paging refuse the request. Reads do not resume an agent or load binary attachments.
  Summary filters, page size, the selected record and an unselected page's first-row anchor
  persist in the native project store. Restoration resolves exact identities against a fresh
  catalog instead of reusing saved offsets or revisions. Missing records return to the first
  page with a notice; a saved provider filter remains visible when absent from that page.
  Preference writes merge only the explicitly changed fields with revision-checked retries;
  other windows' independent filter changes are retained. Storage failures leave browsing
  available and expose an explicit retry.
- Native structured input cards support grouped questions, single/multiple choices, write-ins,
  recommendations, explicit delegation, required-answer validation, and cancellation. The form
  stays pending until the engine resolves it. Pending forms replay after UI reload/restart;
  unsubmitted answer drafts survive session-tab switches within the current UI process.
  Pending questions receive the main chat area, with a separate conversation-review control;
  the composer returns when the request resolves.
- Provider settings load the engine catalog and saved connections, accept preset API keys or a
  custom OpenAI-compatible endpoint/model, and wait for correlated engine acknowledgements.
  Provider secrets use the existing encrypted engine vault; saved keys are masked. First-run
  sessions offer setup inside desktop before enabling message submission.
- Model definitions have structured advanced controls for effort vocabularies, toggle/budget
  reasoning options, interleaved replay fields, lifecycle/experimental status and per-model SDK/
  API metadata. Additional cache-duration, audio, reasoning and long-context prices use labelled
  numeric inputs. Existing explicit runtime reasoning policy takes precedence; switching to
  catalog controls explicitly removes that override. Unknown fields and price tiers are preserved.
  Explicit runtime policy authoring covers defaults, disabling, tri-state effort support and
  documented levels, plus thinking retention. Contradictory combinations are refused; returning
  to catalog controls removes the explicit override without deleting the underlying options.
  Saved advanced behavior is readable in the inspector. Edits retain stale-definition preflight,
  schema validation and structural saved-value verification, including arrays of option objects.
- Existing WrongStack providers, tools, permissions, context, and agent execution behind the
  native transport. Desktop controls do not bypass the engine's permission gates.
- A bounded native HTTP bridge reaches backend feature APIs while retaining the private token
  and origin in Rust. Calls use their owning project/profile/session runtime, refuse redirects, and cannot select
  arbitrary origins or frontend resources. Desktop owns project/workdir/session lifecycle.
- Project workspaces work with zero desktop sessions: SAGE has a React Flow map of stored relationships, direct counts, lightweight previews and an optional library,
  real topic/file relationships, retention/evidence/audience editing, review proposals, named
  Doctor repairs, retrieval scoring, explicit deletion and recovery. Applicability authoring
  includes a statement and up to four project-file/literal checks, with verified stored readback.
  An explicit current-source review uses the engine's canonical bounded checker and shows literal
  found/missing/unknown results, memory revision, time and source fingerprints. It does not mark
  the whole memory valid or change its lifecycle. Source review is transient and remains separate
  from live injection tracing. Vector storage has its
  own status/search surface. Kanban has
  boards, task editing, labels/priorities, drag/drop and managed transitions; Code Atlas indexes
  actual project code and drills from packages to files and symbols with source preview,
  three layouts, explorer, minimap, centrality, relationship filters, guided tour, directed
  dependency paths, anchored SAGE evidence and file history. The Subsystems boundary map opens
  and collapses indexed groups, keeps direction and relation types distinct, and shows recorded
  reference counts and summed weights. Expanded members use the existing node inspector and
  package/file/symbol navigation; current filters apply before aggregation.
- Files provides a directory tree, folder browser, multiple document tabs, text editing,
  acknowledged save/readback, external-change conflict handling, image preview and actual
  create/rename/move/delete operations. The resizable bottom panel contains file overview,
  diff, canonical structure, Chronicle activity, SAGE anchors and Code Assist.
  Unsaved text edits persist in the native project registry, separately from project files.
  Recovery lists metadata for up to 500 recent drafts and loads content only when opened. Restored
  edits retain their original disk baseline; unavailable source files do not delete the draft.
  Ordered revision-checked saves refuse stale windows; a side-by-side comparison offers explicit
  stored/local recovery. Disk save and discard first check the current stored draft revision.
  The native form payload limit is 2 MiB including both draft text and its original baseline.
  Content search runs in the project engine and returns literal UTF-8 line matches, file paths and
  source-line navigation. Folder/case/ignored-source controls, omission counts and explicit partial
  results distinguish bounded scans from complete results. It reads up to 1 MiB per file, 32 MiB
  total, 5,000 files/20,000 entries or five seconds, returning up to 200 matching lines in the UI.
  Conversation-side Files/Review/Skills use the owning project service too; they do not depend
  on the conversation engine's feature version or require its restart. Links retain the
  conversation workdir while documents share the project's file identity.
- Changes provides unified/split line diffs, review notes, stage/unstage, commit/discard,
  branch/tag history, commit metadata/parents, changed files and committed diffs.
- Project Chronicle provides bounded timeline queries, time/file/event/outcome/actor/model filters,
  cursor pagination, summary totals, event details, stored evidence relationships and collector
  health. Code Assist in Files and Atlas uses the engine's dedicated analysis run/abort contract.
- Project and profile skill libraries separate writable owned skills from bundled/foreign sources.
  Discovery/filtering, Markdown instructions/editing/preview, creation, validation, save/readback,
  draft-leave protection, supporting files/references, Git lifecycle controls and export use the
  canonical engine handlers. Files can explicitly reveal Git-ignored source directories while
  preserving the shared project-containment policy and default tree filtering.
- Project Mailbox provides threaded correspondence, actor receipts, composition, live event refresh,
  registered agents and confirmed retention controls without a conversation.
- Project Kit reads reusable project capabilities without importing executable source. Guides,
  recursive typed inputs, output contracts, tests and verification history support revision-pinned
  requests that append to a same-project conversation draft only after an explicit action.
- Project TechStack provides dependency inventory, analysis jobs, observed version/source facts,
  evidence and model interpretation, workspace filters, trends, reviewed remediation and report/SBOM
  controls. Setup-mode onboarding is not offered as an analysis model.
- Project Dead Code provides scope/confidence/category filters, selected exact diffs, confirmed
  cleanup and verification results, retained in-process operations and conflict-aware backup restore.
- Project Design Studio renders real light/dark kit previews, saves scoped colors and semantic
  tuning, writes project theme files with readback and displays signal-qualified design scans.
- Project Chimera Reviews lists reports across originating core sessions, separates citation
  verification from reviewer confidence, and provides finding/report decisions, journals, notes,
  claimed/observed evidence and explicit follow-up draft preparation. Project Kit, TechStack,
  Dead Code, Design Studio and Chimera are grouped in the compact Project tools navigation.
  Unsent review notes autosave in native SQLite under their project/report identity and recover
  after UI reload. Competing versions receive an explicit local/saved comparison, with a fresh
  revision check before choosing or posting. Choosing a draft never posts a report note. Only an
  acknowledged report note clears its draft; failed saves/submissions retain local text.
- WrongStack settings work before adding any project. Provider/model configuration, execution,
  context/reasoning, capabilities, named fallback profiles/ordered chains, role/phase model routes,
  cost tiers, optional resource limits, Chimera/continuous review policy, logs and MCP connections use human-readable controls
  and acknowledged saves with readback. Independent nested edits are retained and detected
  same-field conflicts preserve the operator draft. Desktop Appearance remains a separate preference surface.
- Project automation management and model-access test results. Generic JSON/action-form pages
  have been removed from navigation. The broader capability catalog is an acceptance inventory;
  it is not full feature parity;
  see the [acceptance inventory](../../docs/desktop-v2-feature-parity.md).
- Rust host owns PTYs, backend processes, and persistent engine connections. Closing a pane
  detaches; restarting only the UI preserves the same live core session and PTYs.
- Append-only PTY transcripts and engine journals replay after UI reload/restart. Host crashes
  and machine reboots terminate processes; recovered records are marked **interrupted**.
- Binary terminal output with one 64 KiB frame in flight; xterm acknowledges parsing before
  another frame is sent. Unattached output stays on disk.
- Authenticated non-HTTP loopback host protocol, OS election locks, bounded frames/concurrent
  clients, private endpoint permissions, and canonical project containment checks. Engine
  transport tokens and backend URLs never enter the renderer.
- Native localhost preview windows with DevTools and zero host IPC capability. These preview
  project output; they never host project/session UI.

Default data is `WrongStack/desktop-v2-native` under the per-user data root: `%LOCALAPPDATA%` on
Windows, `~/Library/Application Support` on macOS, `$XDG_DATA_HOME` (else `~/.local/share`) on Linux.
`WRONGSTACK_DESKTOP_DATA` selects an isolated directory for tests. Earlier prototype data under
`desktop-v2` and its active sessions remain untouched. On Windows, hosts run from a private
executable copy so they do not lock the UI binary against subsequent builds; macOS and Linux run
the installed executable, which an update can replace while the host runs. There the host and
each engine lead their own process group, so closing the launching terminal does not stop
sessions and stopping a session reaches the tools its engine started.

Workdirs currently stay inside a registered project. External linked worktrees can be registered
as projects until workdir overlays land. Read-oriented feature panels are not full control parity.

## Verify

```powershell
bun run --filter @wrongstack/desktop-v2 typecheck
bun run --filter @wrongstack/desktop-v2 test
bun run --filter @wrongstack/desktop-v2 test:native
bun run --filter @wrongstack/desktop-v2 check:native
```

With `bun run --filter @wrongstack/desktop-v2 dev:web` running:

```powershell
cargo build --manifest-path apps/desktop-v2/src-tauri/Cargo.toml
bun run --filter @wrongstack/desktop-v2 test:native-ui
```

To verify the actual portable output without a dev server:

```powershell
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --companion
# Focused composer scope; does not replace the full native suite:
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --composer
# Focused project and provider scopes; each records its own native-result.json:
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --mcp
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --mcp-tasks
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --processes
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --fleet
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --roster
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --automation
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --files
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --settings
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --usage
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --sage
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --sdd
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --models
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --model-draft-restart
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --model-profiles
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --mailbox
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --kit
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --techstack
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --deadcode
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --design
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --chimera
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --recovery
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --history
bun apps/desktop-v2/tests/native-smoke.mjs --release --bundled --history --companion
bun run --filter @wrongstack/desktop-v2 test:engine-concurrency
```

The Windows smoke exercises real Tauri/WebView2, ConPTY, SQLite, and the production backend. It
creates two projects and three concurrent PTYs, checks resize/input/output, reloads and restarts
the UI, checks host identity, starts a native agent session, requests real core stats, reads a
project file inside desktop, switches native panels, restarts the UI again, and asserts the same
core session identity. It asserts that no WebUI window exists and the endpoint method is absent.
It covers navigation and an 800 px layout. Bundled mode verifies the portable checksums, copies
both executables outside the repository, removes the development engine overrides and Bun/Node
from PATH, and checks persisted tabs and per-session draft isolation. An isolated loopback model
fixture exercises native onboarding, provider/key saves, a backend refusal, streamed chat,
encrypted configuration, credential-free engine journals, and saved-provider use from a new
engine process. It also exercises Markdown/copy controls, an actual project-file link, and the
engine's real `clarify` tool: submit, cancel, required fields across groups, UI reload while waiting,
and draft isolation across session switches. Appearance checks exercise mode/palette persistence,
system changes, compact settings, and live terminal colors. Project checks exercise memory
create/delete/recover and isolation, Kanban create/edit/drag, real indexing and Atlas/source
drilldown with zero sessions. Profile checks save preferences and configure/remove a disabled MCP
connection. They also exercise global instructions (Markdown, draft retention, stale-revision
refusal, guarded reload and empty saves), real tool enable/disable with on-disk profile checks,
and provider/model availability windows with invalid-timezone refusal, overnight semantics and
allow-only behavior. The companion variant exercises an independent project-service host beside the
session host. Neither variant uses a WebUI frontend.
Developer-shell credentials are removed from the test environment; no external
LLM request is sent. Test processes/data are
removed; screenshots remain in `.temp_files/desktop-v2-native/`.

The detached-PTY proof found ConPTY waiting for its first cursor-position response. The host now
consumes/answers that handshake without a renderer and omits it from replay. Unit tests cover
split reads and preservation of subsequent queries.

Validation results are recorded by the current run; the native smoke writes its final
`native-result.json` only after behavior checks and isolated test cleanup succeed. A unit pass
or a navigation mapping is not native workflow certification. The provider fixture uses the
OpenAI-compatible protocol locally; paid/external provider authentication and live model quality
are outside that proof.

See the dated [validation report](../../docs/desktop-v2-validation.md) for observed results,
the host request-pool change, earlier failures, and retained test-cleanup limitations.

## Remaining release work

The native application has dedicated project workflows, but complete production parity is still
open. The action-level acceptance inventory tracks the remaining work: richer tool/media viewing,
compressed/large-history acceptance and redo, language-aware editing,
per-line staging/unsupported partial-file cases, automatic rename grouping, larger/symlink/submodule conflict cases and worktrees, selective multi-window draft merging, provider OAuth
and full vault lifecycle, agent roster/topology and fleet controls, linked Kanban/Goal/SDD execution
and verification, historical SDD runs, automation environments/credentials/Docker/GitHub,
SAGE injection traces and recovery/backfill, vector mutation/maintenance, advanced review policy
and durable secondary forms, MCP OAuth/advanced policy and binary content, usage dashboards,
batch process/browser controls, and Atlas scale/flow
exploration. Preview profile isolation, window geometry, migration, signed updates/installers and
the full release matrix also remain. The portable payload includes the complete Bun engine;
installer size and performance budgets still need measurement against the original targets.

The [analysis](../../docs/desktop-v2-analysis.md) originally proposed WebUI frontend reuse. The
product owner's explicit requirement on 2026-10-25 supersedes that: G5 now requires desktop-owned
UI directly reaching the motor and surviving UI restart. Three concurrent PTYs are tested; the
3 × 10k lines/s/no-dropped-frames benchmark, long-scrollback QA, preview DevTools gate, startup/RAM
budgets, full coverage, and hosted CI are not certified. Electron release distribution is unchanged.
