# Desktop v2 design audit and redesign specification

Review period 2026-11-26 to 2026-11-27. Desktop source version 1.7.22, base commit `780c0ecbd7` with the working checkout read in place. The review includes the shared project-surface components and the in-progress Desktop settings changes present at capture. Runtime values in the visual fixtures are synthetic.

## Design decision

Build a square-corner workbench around the current conversation. Give the project explorer, reading surface, and inspector distinct jobs and make their hierarchy visible through alignment, spacing, and surface lightness. Use the existing WrongStack mark, Geist, Cascadia Code, and configurable palettes. Reserve the selected palette's accent for the current destination, keyboard focus, and a primary action where one is required.

The initial reference is a wide conversation, its 800 × 600 layout, and Profile settings. These three surfaces exercise the shell, reading rhythm, dense forms, two levels of navigation, selections, menus, dialogs, and focus. The [interactive workbench prototype](../.temp_files/desktop-v2-design-audit-20261126/workbench-prototype.html) includes the rail, model picker, Ctrl+K, inspector, and New session. Its data and writes are confined to the preview. The [side-by-side comparison](../.temp_files/desktop-v2-design-audit-20261126/design-comparison.html) pairs the current and proposed layouts.

## Evidence and limits

- [Chromium screenshots](../.temp_files/desktop-v2-design-audit-20261126/current), [initial measurements](../.temp_files/desktop-v2-design-audit-20261126/captures-before-workbench-css.json), and [19 later workbench captures](../.temp_files/desktop-v2-design-audit-20261126/captures-current-shell.json). The visual harness uses React components with fixture Tauri IPC, profile, and project data. Its version badge is fixture data. The broad initial pass opened all 26 profile settings and 23 of 24 project routes, with major shell/control families shown in English plus a Turkish subset. The focused recheck also opened Live fleet. The Model catalog was captured in its unverified-profile state. Other catalog, project, and integration states can also be sparse with these fixtures.
- [Source inventory](../.temp_files/desktop-v2-design-audit-20261126/source-inventory.md) and [machine-readable occurrences](../.temp_files/desktop-v2-design-audit-20261126/source-inventory.json). The parser read all 837 TS/TSX files in scope and identified 77 dialog declarations/usages, 328 select/disclosure/menu occurrences, 1,792 icon render or reference occurrences, 624 form-control occurrences, and 646 literal copy candidates. Some entries refer to the same component or shared WebUI code. Dynamic, native, and indirectly composed UI still requires an activation path and review.
- [Desktop locale inventory](../.temp_files/desktop-v2-design-audit-20261126/desktop-copy-inventory.json). All seven catalogs contain the same 8,392 English-base keys in the later source snapshot. This measures key parity. Copy can still come from shared code, provider data, dynamic message templates, or literals. String quality, truncation, and mixed-language rendering need their own checks.
- [Prototype acceptance](../.temp_files/desktop-v2-design-audit-20261126/prototype/verification.json). Chromium checks passed at 1440 × 900 dark, 800 × 600 light, and 390 × 700 dark. The checks cover scope navigation, inspector layout, model search/selection, approvals, command palette, dirty/save state, dialog actions and focus return, message entry, and the visible Send and Create targets. Axe and console checks returned zero violations and zero page errors for the conversation state exercised in the test.
- Native WebView2, Windows system dialogs, actual provider OAuth, and populated live data are outside this evidence. The production acceptance matrix below records how to cover them.

The workbench styling and title changes from concurrent work in `main` appeared during the broader capture. The later focused pass loaded the current stylesheet import order and matched the selected shell source hashes before and after measurement. At 1440 × 900 both Send and Create received a hit at their center. At 800 × 600 neither did on initial display. Send was centered at roughly `(696, 562)` under the clipped conversation and status area. Create was at `y=644`, below the dialog viewport. These are the first two production acceptance targets. [Later shell snapshots](../.temp_files/desktop-v2-design-audit-20261126/current-shell).

### First implementation increment

The compact inspector opens from the session rail without changing transcript geometry or the saved desktop pane width. Escape dismisses it and returns focus to the opening control. The New session dialog uses a scrollable body and an independent action footer, and the composer action row wraps at narrow widths. In the 800 × 600 fixture the Send target moved to `y=463` and Create agent session to `y=503`. Both receive pointer input on first display. [Implemented conversation](../.temp_files/desktop-v2-design-audit-20261126/implemented/en-light-800-conversation.png), [implemented dialog](../.temp_files/desktop-v2-design-audit-20261126/implemented/en-light-800-new-session.png), [focused capture measurements](../.temp_files/desktop-v2-design-audit-20261126/captures-implemented.json).

The compiled frontend passed the same pointer and keyboard checks in Chromium at 1440 × 900, 800 × 600, and 390 × 800 against synthetic Tauri IPC. The workbench and inspector browser suites passed eight light/dark viewport cases each, including the workbench terminal dock flow. The inspector fixture emitted the ResizeObserver warning also present in its 2026-11-20 log. The Desktop test suite reported 1,493 passing tests. Typecheck and the frontend build completed. Windows WebView2 package acceptance remains open.

### Conversation reading and search

Top-level conversation prose uses a 76ch measure, with the full transcript row available for code, tables, and run activity. The default Markdown text uses 15px and 1.7 line height. Compact density still supplies its own type settings.

The command palette opens on its search field and groups commands, projects, and sessions. Arrow navigation retains text focus and reveals the active option. Enter opens it and an empty search result has a localized status. The model picker shares the same search field styling, supports arrows between search and model results, and accepts a single filtered match on Enter. Closing after a successful model change returns focus to the launcher once it becomes enabled. [Grouped listbox reference](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/examples/listbox-grouped/).

The workspace layout title comes from the same localized key in the palette, Desktop menu, and dialog. The compiled frontend passed English dark 1440 × 900, Turkish light 800 × 600, and English dark 390 × 800 against synthetic Tauri IPC. The workbench browser matrix passed eight light/dark viewport cases, the palette's scoped Axe checks, and the terminal dock flow. The package suite reported 1,494 passing tests, and the later title change passed the focused palette and shell localization suites, typecheck, and a fresh build. [Turkish command palette](../.temp_files/desktop-v2-design-audit-20261126/reading-pickers/tr-light-800-palette.png), [compact model picker](../.temp_files/desktop-v2-design-audit-20261126/reading-pickers/en-dark-390-models.png), [wide conversation](../.temp_files/desktop-v2-design-audit-20261126/reading-pickers/en-dark-1440-conversation.png).

## What the current interface shows

| Surface | Observation | Redesign |
| --- | --- | --- |
| Mission control | The first four metrics have similar weight. The attention count is repeated as a link in the next row. Each project has a separate New session button in addition to the global action. | Use a prominent attention queue driven by blocked and failed sessions, with a small summary above it. Keep session lists sortable and grouped by project. Put project-specific creation on the group header and make its scope explicit. |
| Shell | At 1440 × 900 the rail and explorer occupy 271 CSS px. Several dark surfaces are close in color and repeated horizontal dividers do much of the hierarchy work. | Use a 48 px rail, a 208–248 px explorer, and distinct canvas/rail/overlay colors. Give the title bar a single breadcrumb and put window and application actions at the far edge. |
| Project overview | The project name appears in the window bar, project context bar, and hero. Project tools are available in a launcher and a long grid of cards that repeats navigation. | Use the project name in the breadcrumb and let the page heading describe the view. Place active sessions and recent work first, with one compact project-tools index and descriptive text in the overview. |
| Conversation | At 1440 px the session rail shows a Leader summary and five agent rows beside a wide transcript. In the initial 800 × 600 fixture, the inspector occupied 180 px above the transcript, which had a 160 px viewport. The composer extended 34 px beyond the bottom of the main shell. | Limit prose to 68–78 characters per line. Keep wide code/diffs in their own scroll region. Give the composer and run status a shared baseline. Use a temporary inspector at narrow widths and keep Send in the initial viewport. |
| Transcript | Speaker labels and chronological tool placements already give the conversation structure. The broad user surface and per-message icon row draw attention away from the assistant reply. | Distinguish the user with a quieter inset surface, leave assistant prose on the canvas, and keep message actions available on keyboard focus and pointer hover. Keep tool activity beside the turn that produced it, with collapsed outcome, duration, and explicit expand action. |
| Composer | Model, effort, run mode, approvals, attachment, dictation, context-related controls, message type, and Send compete on one toolbar. The upper-right chevron is visually detached from the main row. | Keep model, current execution/approval state, Attach, and Send visible. Put secondary input controls in a named menu. Reveal high-impact exceptions such as bypassed approvals or a separate message destination directly beside Send. Fold effort into a clearly named model settings section. |
| Inspector | The leader card repeats a transcript excerpt. Agent rows repeat task and output text at the same visual weight, and long names lose useful information when clipped. | Put leader destination in the composer. Lead each agent row with name and state, then current task. Surface output and timeline when selected. Pair truncated rows with focus-accessible full names. |
| Project tools | One shared catalog gives launcher and overview the same labels and icons. The wide launcher uses five groups across two columns and obscures much of the page from the explorer edge. | Keep the catalog. Show a searchable grouped surface aligned to the trigger, with a single column at narrow widths. Use one interaction model for the launcher and distinct card semantics for overview links. |
| Appearance | Theme, contrast, chat density, sounds, palettes, language, and typography controls already exist. Their scope differs from profile execution and integrations. | Keep a direct Appearance shortcut and add a unified settings entry. Clearly mark app appearance controls and profile preferences, with an immediate live sample for theme, text, and density. |
| New session | The 800 × 600 initial dialog kept its fields scrollable, with the primary action below the visible part of the dialog. The heading `A fresh session.` uses different copy from its opener. | Use `New session` for both and keep Cancel/Create Agent Session or Create Terminal Session in a fixed footer outside the scrolling form body. |

## Target workbench

| Window size | Navigation and reading layout |
| --- | --- |
| 1440 × 900 and larger | Explorer and inspector can coexist with a 720–800 px reading column. Main content in Files, Changes, Atlas, and Board can use the full center width. Keep inspector width adjustable and respect the user's saved choice. |
| 1024 × 768 | Retain the explorer when the primary content can fit. Use a temporary inspector attached to its rail or toolbar entry. Preserve selection and focus across changes in width. |
| 800 × 600 | Keep the global rail and one main surface visible. Open explorer, inspector, or tool list as an explicitly named overlay. Keep the composer input, Send, and approval state reachable within the main viewport. |
| 800 × 600 at 150–200% text zoom | Put one main navigation control, content, and the primary action in view with a closeable overlay for secondary UI. Dialogs scroll their content independently while keeping the primary footer reachable. |

### Foundations

| Decision | Specification |
| --- | --- |
| Surfaces | Dark prototype uses charcoal canvas, slightly lifted workbench chrome, and a distinct overlay. Light uses warm paper, a neutral toolbar, and white input surfaces. Build semantic tokens for canvas, chrome, inset, raised, overlay, border, text, muted text, focus, and selection over the current palette contract. Set state colors by purpose and test every shipped palette. |
| Type | Geist for UI, Cascadia Code for technical values. Proposed scale 12 px metadata, 13–14 px controls, 15–16 px body, 20 px section heads, 26 px page title. Transcript paragraph line-height 1.6–1.7. Tabular numerals for times and measurements. Retain existing font/zoom overrides. |
| Geometry | Square corners, a 4 px spacing grid, 8–12 px gaps within a row, 16–24 px between related groups, 24–32 px between sections. Use dividers between unrelated regions, an overlay shadow for elevation, and an inset border for editable panels. |
| Controls | Aim for a 32 px desktop target and 36 px main action or input. Icon glyph sizes 16 px default, 18 px primary navigation, 20 px prominent empty state only when it communicates the actual feature. Use 2 px focus treatment with visible separation from selection. |
| States | Define default, hover, focus, selected, pressed, disabled, unavailable with reason, loading, validation, saved, rejected, and destructive states. Show clear empty states with a next action where one is available. Treat interrupted, error, waiting for approval, running, and completed as separate states with a label or shape as well as color. |
| Motion | Use short, interruptible fades for overlay appearance and quick transitions for control feedback. Keep resize and layout changes immediate. Honor reduced motion, including active-agent indicators. Avoid moving the user's reading position or focus when new output arrives. |

Use the Windows design guidance for command placement and keyboard behavior, and the W3C patterns for the specific interaction each popup implements. [Windows command bar](https://learn.microsoft.com/en-us/windows/apps/design/controls/command-bar), [Windows keyboard interaction](https://learn.microsoft.com/en-us/windows/apps/design/input/keyboard-interactions), [W3C ARIA patterns](https://www.w3.org/WAI/ARIA/apg/patterns/).

## Project workspaces

These changes preserve the current navigation destinations and feature behavior. See the current [route list](../apps/desktop-v2/src/useDesktop.ts#L17), [project workspace](../apps/desktop-v2/src/ProjectWorkspace.tsx), and [tool catalog](../apps/desktop-v2/src/project-tools.ts).

| Page | Design treatment |
| --- | --- |
| Overview | Breadcrumb, project summary, attention items, active sessions, grouped tools. Use compact stats only when they link to their underlying records. |
| Files | Explorer, document, and optional outline. Group navigation/search, file operations, and save state separately. Put long paths in a copyable breadcrumb and keep editor and file selection when switching views. |
| Changes | File list first, diff second, hunk review in the main panel. Keep stage/revert scope, current branch, and unsaved document conflicts visible. |
| Memory | Search and filters above results. Lead each result with title, provenance, and age; show evidence, related records, and edit controls on selection. |
| Kanban | Board picker, swimlane controls and primary create action share one toolbar. Use a task inspector for details; preserve card identity during filtering, reorder, run, and review. |
| Goals | Lead with goal outcome and current phase. Use a sequence for progress and a distinct block for failed checks and evidence. Keep run, pause, and revert actions tied to the goal. |
| SDD | Put current spec stage and pending decisions above the task graph. Show structural commands in a toolbar and evidence in the relevant stage. |
| Code Atlas | Canvas fills the center with a tool strip for search, fit, and depth. Use an inspector for selected node, dependency types and source links. |
| Automations | List rows for schedule, last run and next run. Use a detail panel for history and configuration, with a dedicated comparison view for two runs. |
| Chronicle | One timeline with grouped dates and query controls. Put event provenance on the detail panel and exports in the page toolbar. |
| Mailbox | Message list plus selected message. Distinguish unread, reply recipient, and related session with labels and make compose/refresh independent actions. |
| Worktrees | Branch, canonical path, current status, and active-session count in a table. Scope create/switch/remove to the named branch and path. |
| Project Kit | Group capabilities by type and show installed/draft/published state. Keep launch parameters with the chosen capability and preview created artifacts. |
| TechStack | Category filters, package status, and version/license columns. Show manifest location and details in an inspector. |
| Dead Code | Findings table with confidence, path and scope. Keep evidence and exclusion controls near the selection. |
| Design Studio | Make source → extraction → editable brief → handoff explicit. Keep a preview alongside the current artifact and surface resumable work in the page header. |
| Chimera Reviews | Show review status and summary first, grouped findings next, and evidence/history in a contextual panel. Keep follow-up tied to the originating report. |
| Session history | Show project, model, timestamp and state in rows. Use a detail view for transcript and secondary actions, with restore/delete scope spelled out. |
| Agent Roster | Use Overview, Learning, and Skills as true subtabs. Keep identity and runtime summary visible while editing the selected agent. |
| Live Fleet | Use an agent list with current task, runtime and outcome. Make broadcast recipients and stop targets explicit; show per-agent results without leaving the group view. |
| Agent Office | Keep the office composition as an optional visual view with a compact accessible roster and status key. Use motion to explain activity, with a stable reduced-motion view. |
| Engine diagnostics | Connect health, queue, and recent errors to affected projects/engines. Put detailed logs behind a filterable stream and label recovery actions with their exact scope. |
| Analytics | Use date range, selected project, and units above charts. Separate zero from unavailable and provide accessible values. |
| Skills | Searchable library with role, permissions and source. Open an editor with preview, draft state, and consistent cancel/save actions. |

## All profile settings sections

Use one page header for title, profile scope, and navigation. Use 2-column label/control rows for simple fields and full-width list/detail editors for models, rules, and ordered chains. Keep failure near the field and put aggregate save feedback at the bottom. Apply, Discard, and immediate preferences have different labels and appropriately different behavior. Source [section registry](../apps/desktop-v2/src/WrongStackSettings.tsx#L99) and [simple fields](../apps/desktop-v2/src/settings-fields.ts#L32).

| Setting section | What to design and verify |
| --- | --- |
| Quick setup | Show connection and default model as distinct steps. Explain why a provider is unavailable and give the next action. Keep local, API key and OAuth paths easy to distinguish. |
| Providers & models | Use provider list and detail. Separate credentials, catalogs, OAuth state, and active models. Treat a stored secret as a state with explicit Replace/Remove. |
| Model catalog | Search and filters above the table. Put provider and model identity first, use quiet capability metadata, and expose current/default/custom status. Keep edit/new draft close to the record. |
| Model visibility | Use a provider/model tree with visible/hidden and effective state. Show impacted defaults before applying changes. Keep search, bulk actions and undo context distinct. |
| Model availability | Rule summary shows model/provider, action, schedule, time zone, and active state. Edit one rule at a time. Preview next occurrence and overnight/week rollover beside the schedule. |
| Fallbacks & agent defaults | Display the effective default first, ordered fallback chain second, timeouts/cache in an advanced section. Accessible reordering and a sample resolution explain precedence. |
| Model routing | Show profiles/rules in execution order. Preserve separate provider/model keys and inherited/manual references. Put matched conditions, resulting model, and order on each row. |
| Cost tiers | Compare tiers in a compact table. Show currency/units, configured limits, active status, and engine default. Provide a separate editor for a tier's thresholds. |
| Execution & permissions | Make continuation mode and permission scope visible at top. Group budgets, delay, circuit breaker and reset, next-step requirements, and filesystem permission separately. Name the effect of weaker approvals next to the relevant control. |
| Prompt refinement | Separate activation trigger, gate and model override. Group execution timing and decision visibility. Preview the effective policy for one example request. |
| Context & reasoning | Put context profile/strategy first, automatic compaction and token saving together, then reasoning effort and preservation. Clarify the scope of agent identity and global/project instructions. |
| Global instructions | File path and scope header above editor. Pair save/discard with draft status and keep error near the affected document. |
| Resource limits | Group tokens, budget, time and concurrency by unit. Show inherited value, entered override, and validation range next to each control. |
| Review policy | Show stages from trigger to reviewer and evidence. Put explicit cost/permission implications beside the action or toggle where they apply. |
| Capabilities | Group memory, skills, MCP and plugins, code indexing and symbol reads, and memory injection. Show dependencies when a toggle is unavailable. |
| Tool availability | Group by tool family and show the effective rule per tool or set. Report consequences of bulk changes before saving. Keep project overrides distinct from profile policy. |
| Fleet & companions | Show role defaults, concurrency, and companion configuration separately. Render the resolved runtime for a representative agent with inherited values. |
| Brain policy | Separate strategy, pool, council voters, and seats. Give voters stable rows for model, role/lens, weight, veto, and reorder. Show effective choices before save. |
| Profile skills | Use the same library controls as project Skills with a visible Profile scope and edit rights. Avoid a second visual vocabulary for the same skill state. |
| Connected tools | Integrations list shows type, reachable state, and scope. Put connection config, capability tests, network access and unlink actions in the selected detail. |
| HQ, proxy & Telegram | Use group headers and scopes for three integrations. Surface which events are sent, what content is shared, endpoint, and credential state. Put test connection and secret replacement beside the affected integration. |
| Provider diagnostics | Add provider filters, last checked time, result and retry. Expand raw details on request. Distinguish credential, transport, timeout, and upstream failures. |
| Plan quota | Show remaining/used values with unit, reset time, and refresh state. Distinguish unknown from zero. Apply data ownership and provider names consistently. |
| Model tests | Lead with model and prompt input, then actionable pass/error results. Group optional parameters and show timing and detailed response on completion. |
| Terminal display | Add an interactive preview for CLI title, swarm panel, command exit behavior, status line, thinking word, animation, reasoning, countdown and multi-diff. Explain the scope of each control. |
| Logs & diagnostics | Place log detail, audit detail and stream diagnostics in one labeled group. Show where output is available and the current save/load status. |

### Application and session settings

| Scope | Treatment |
| --- | --- |
| Theme, contrast, palette | Put them together with a preview covering foreground, focus, and status chips. Label System preference resolution. Keep a text label on the selected swatch. |
| Density, sounds | Provide a transcript sample for density and a manual sound preview. State which event plays a sound. |
| Language | Use language autonyms and retain selection after reload. Check Turkish and German labels with long values as well as English. |
| Typography and zoom | Include UI font, code font, custom family, zoom, and ligatures in one section. Show examples for prose, file path, and code. Support system and custom fallbacks. |
| Conversation display and shortcuts | Group transcript detail, local display preferences, and keyboard shortcuts under the current application/profile scope. Render a small preview that reacts to the chosen settings. |
| Pane layout | Label each of Explorer, document tree, and inspector with current width/collapsed setting. Offer a reversible default reset and a live layout map. |
| Console and session quick controls | Label scope beside ACP agent/runtime, context mode, model, approval and execution changes. Confirm actual applied state when an engine rejects or delays a change. |

## Dialogs, pickers, and controls

| Family | Current entries to review | Design rule |
| --- | --- | --- |
| Application | New session, command palette, preview URL, pane layout, shortcuts, workspace tools | New session uses project/type first, optional name and working directory after that. Palette starts in its search field and groups commands/project/session hits. Shortcuts use a searchable reference surface. Preview describes destination and DevTools. |
| Project and session management | Add/remove/rename project, session actions, stop processes, session recovery, session history | For each irreversible operation show the named object, consequence and specific verb. Put export/filter/import in contextual screens when records need inspection. Keep recovery choices tied to the current saved state and live process. |
| Conversation tools | Attachment/image action, context inspection/editor, branch/plugins, model picker, MCP browser/tool runner/task and connection editor, prompt library/refinement, saved questions, permission rules, agent plan | Use anchored surfaces for a quick choice; a side inspector for persistent reading; a dialog for bounded edits or validation; a full tool workspace for reviewing long results. Maintain composer draft, reading position, and triggering scope. |
| Files and review | Search, bulk operation, draft conflict, file action confirmation, hunk review, merge conflict | Put search and inspection inside the workspace where context matters. Compare draft/current values side by side when space permits. Require explicit resolution or confirmation with the target path and resulting state. |
| Project tooling | Automation configuration/env/run inspection/comparison, Kanban board/contract, Mailbox compose, roster runtime/document, Fleet broadcast, Chimera | Routine edits get a sheet or bounded dialog. Comparisons and evidence get a wide split view. Keep the primary CTA and pending outcome visible without horizontal scroll. |
| Profile and integrators | Model catalog/drafts/visibility, provider OAuth and visibility, integration configuration, shared setup and wrappers | Reuse scope header, status feedback, provider/model identifier treatment, draft recovery and footer. For OAuth keep code/link, expiry, browser handoff and retry in one view. |
| Native | OS file/folder picker, system credential/provider browser interactions, native window affordances | Match interaction language around the OS handoff. Test cancel and focus recovery in WebView2. |

- **Dialog** uses a semantic name, predictable initial focus, keyboard dismissal when valid, visible focus, and focus return to the opener. Long content scrolls independently. Confirmations use an explicit action label and identify the target and impact. `Modal.tsx` already provides `showModal()`, Escape, and opener restoration. Verify raw dialogs and shared wrappers against the same behavior. [Current native dialog wrapper](../apps/desktop-v2/src/Modal.tsx), [W3C dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
- **Action menu** starts on a valid item, supports arrow keys, Home/End, Escape, and returns focus on close. Use a menu for Workbench, session overflow, and project actions. Use a disclosure with ordinary buttons for a small group of independent controls and a popover panel for interactive filters and notifications. [Workbench menu source](../apps/desktop-v2/src/WorkbenchMenu.tsx), [W3C menu button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/).
- **Select** retains native keyboard navigation for short enumerations such as effort, time range, and small settings lists. Keep the existing customizable picker enhancement with a native fallback. Show selected value, default/inherited state, and long labels without making options unreadable. [Desktop form CSS](../apps/desktop-v2/src/controls.css).
- **Searchable combobox** uses model, provider, project, time zone, or other longer lists. Show primary name and concise identity metadata. Keep selected state and Arrow/Enter/Escape behavior consistent. Support an explicit manual entry action where legacy or custom values are valid. Exercise empty, loading, unavailable, pending, and older saved values. [Model catalog combobox](../apps/desktop-v2/src/CatalogCombobox.tsx), [W3C combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).
- **Toggle, radio, and control row** make binary changes identifiable and small exclusive sets easy to scan. Display numeric units next to values. Put a persistent help or error line beneath a disabled/invalid value when the cause affects the user's next action. Show profile versus session scope for saved policy changes.

## Icon and copy decisions

| Existing semantic collision or copy issue | Treatment |
| --- | --- |
| Palette icon appears for both Appearance and Design Studio. | Reserve `Palette` for Appearance. Give Design Studio a creation/artboard icon and a visible label in the project list. |
| `Brain` appears for Memory and Brain policy. | Use a memory/archive glyph for retrieved project memory. Reserve Brain for the decision policy and monitoring entry. |
| Gauge appears for quota and engine diagnostics. | Keep Gauge for quota/usage. Use Activity or a diagnostics glyph for health and queue work. |
| Folder icons cover project context and file navigation. | Use folder for the project tree, file/code for editor navigation, and branch diff for Changes. |
| Rows carry several icons for actions such as Pin, Clear, Stop, and Delete. | Show a stable first action where appropriate and move secondary actions into a labeled overflow. Retain the full accessible names and targets for icon-only controls. |
| Heading, group, status and breadcrumb text repeat current scope. | One page title, one scope label where it affects behavior, and short independent descriptions. Replace generic `Overview`, `System`, and `No data` where the specific subject improves orientation. |
| Unset, default, infinite, disconnected, empty and unavailable have different effects. | Use the precise state and when applicable include source, reason and next action. Example `Profile default · 30 iterations`, `No provider connected`, `Connection lost · Retry`. |
| Profile, session, project and native settings use superficially similar names. | Use visible but quiet scope labels only when outcome depends on scope. Explain where the value is applied. |
| Acronyms and destinations can be unclear in menus. | Keep product names such as SAGE, ACP and MCP. Add helpful descriptions at first use, accessible titles for truncated identifiers, and preserve names in translations. |
| The current command palette uses `Find your next move.` while its trigger says `Find anything`. | Use `Find anything` as the heading and apply the functional prompt `Search commands, projects, and sessions` inside the field. |

## Delivery and acceptance

1. Implement shell and conversation foundations against the prototype. Capture Mission control, project view, populated conversation, active tool run, pending approval, failed run, composer menus, and pane transitions. Verify saved layout and conversation return behavior with existing browser tests.
2. Implement shared dialogs and selectors, then migrate the highest-frequency callers first. Verify focus restoration, keyboard-only use, resize with open overlays, and state visibility. Verify forms with existing drafts and custom values, rejected writes, unavailable options, and long labels.
3. Apply settings information architecture and field layout to all 26 profile sections plus application and session preferences. Start with Providers & models, Model availability, Execution & permissions, then cover populated and narrow states for every section.
4. Migrate the 24 project routes to the agreed workspace patterns. Give Files/Changes, Goals/Kanban, roster, review, and Design Studio individual workflow checks before applying the foundations to the remaining pages.
5. Test 1480 × 960, 1024 × 768 and 800 × 600 in Windows WebView2 with light/dark, high contrast, 100/150/200% text zoom, long strings, keyboard and reduced motion. Cover seven locales with catalog checks and long-label screenshots. Measure normal text contrast at 4.5:1 and control/focus indicators at 3:1 where applicable. Record zero critical clipping, reachable primary actions, and the same reading/focus restoration on return. Run Desktop Vitest, typecheck and build on pinned Bun, then native journeys on the same current package.
