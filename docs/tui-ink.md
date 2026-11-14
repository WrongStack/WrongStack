# TUI Ink Screen — Comprehensive Technical Report

> **Package:** `@wrongstack/tui` (version from its manifest)<br>
> **Frameworks:** Ink and React (declared ranges in `packages/tui/package.json`)<br>
> **Entry:** `runTui()` → `<App>` via Ink's `render()`<br>
> Source/test counts are intentionally omitted; use the live source tree and test inventory.

---

## 1. Overview

WrongStack's TUI (Terminal User Interface) is an interactive, full-screen rendering layer built on top of **Ink 8** (React for CLIs). It is **lazy-loaded** by the CLI package — the `@wrongstack/cli` package only imports Ink and React when the user passes the `--tui` flag. Plain-REPL users pay zero startup cost for those dependencies.

The TUI presents a multi-region terminal layout:

The main chat column and sidebar each keep the terminal's current height.
When the composer or a picker grows, history clips inside the main column;
the sidebar's title and top border stay anchored. Startup also rechecks the
terminal size after subscribing to resize events, covering changes during mount.

```
╭──────────────────────────────────────────────────────────────────────╮
│  ◆ WrongStack  // TERMINAL AI ENGINE          ● READY v1.2.1        │
│                                                                      │
│          WRONGSTACK ASCII wordmark (7 rows × 10 letters)             │
│  ━━━━━━━━ BUILT ON THE WRONG STACK. SHIPPED ANYWAY. ━━━━━━━━━━━━━━━ │
│                                                                      │
│  ◆ ROUTE     anthropic › claude-opus-4                              │
│  ◇ FAMILY    anthropic                                              │
│  ⌁ WORKSPACE /workspace/wrongstack                                  │
│  ⌘ COMMANDS  /help · F1 projects · F10 sessions · /exit            │
╰──────────────────────────────────────────────────────────────────────╯
  user> refactor auth.ts to async/await
  ⠋ thinking… (4 tools · 4.2k tokens · 1.3s)
  …
  > █                                                ⚠ YOLO
  ───────────────────────────────────────────────  ctx ████░░ 47%
```

Command discovery adapts to the main-column viewport: `/help` uses split panes at 76 columns, stacks details on narrower tall terminals, and keeps only the command list on short terminals. PgUp/PgDn scroll wrapped help lines; `/` and `@` pickers keep the focused result visible, show its position, and follow the active theme. Long file paths retain their filename, with matching query text emphasized. Below six rows or 32 columns, these pickers use a borderless focus view: one row keeps Esc inline, two rows give the label full width with measured controls underneath, and three rows add context. Command/file controls include Enter run/attach when space permits; help remains informational. Zero available rows or columns render nothing.

### 1.1 Architecture Diagram

```
runTui()  ·  src/run-tui.ts
  └─ <App>  ·  src/app.tsx   →   useAppController()   →   <AppView>  ·  src/app-view.tsx
       ├─ AppMainColumn     src/app-main-column.tsx     chat column layout (width/rows, flex-end)
       ├─ AppStatusRegion   src/app-status-region.tsx   status bar + bottom-region panels
       ├─ AppViewPickers    src/app-view-pickers.tsx    picker overlays
       ├─ AppViewPrompts    src/app-view-prompts.tsx    confirm/prompt overlays
       └─ AppViewSidebar    src/app-view-sidebar.tsx    sidebar panels
```

`<App>` owns the `useReducer` state machine, subscribes to the EventBus, manages
the agent lifecycle and hosts every panel/overlay. Inside the main column
`src/app-view.tsx` renders the inspect overlay, `ScrollableHistory`, the
background strip, the composer (`src/components/input.tsx`), the pickers and the
status bar (`src/components/status-bar.tsx`).

---

## 2. Core Architecture

### 2.1 State Management

The TUI uses a single **`useReducer`** pattern with a pure reducer function (no React/Ink dependencies). The `State` type lives in `src/app-state.ts`, the `Action` union in `src/app-action-type.ts`, and the reducer entry point in `src/app-reducer.ts`.

**Key files:**
- `src/app-state.ts` — `State` type; supporting types are split across `src/app-state-core-types.ts`, `src/app-state-fleet.ts`, `src/app-ui-state.ts`, `src/app-view-state.ts` and `src/app-panel-state.ts`
- `src/app-action-type.ts` — discriminated `Action` union
- `src/app-reducer.ts` — reducer entry point; delegates every action to a `src/reducers/*` module
- `src/reducers/*` — reducer modules (composer, panel pickers, workspace panels, settings values, fleet, activity, dialogs, chat search, conversation, message jump)
- `src/app-initial-state.ts` — `createInitialState()` factory with full defaults
- `src/reducers/fleet.ts` — subagent state reducer (separated for clarity)
- `src/reducers/helpers.ts` — panel close helpers, stream retention caps

**Action categories:**
- Agent lifecycle (running, streaming, aborting, done)
- Entry management (push, batch push, replace)
- Picker states (file, slash, model, autonomy, project, plugin, MCP, tools, prompt, etc.)
- Panel toggles (F2=F12 fleet, agents, brain, worktree, help, queue, etc.)
- Settings (statusline, animation style, thinking word, token saving)
- Input buffer management
- Fleet/subagent events
- Collaboration debug events (bug.found, refactor.plan, critic.evaluation)
- SDD board lifecycle
- Worktree operations
- Stream/scroll position
- Autonomy/eternal stage tracking
- Session resume

### 2.2 Entry Point: `runTui()`

`src/run-tui.ts`

The `runTui()` function:
1. Enters the alternate screen buffer and sets up bracketed paste mode
2. Installs signal handlers (SIGINT ladder: first Ctrl+C → abort, second → exit)
3. Enables/disables mouse tracking (SGR protocol)
4. Starts the animated terminal title
5. Calls `render(<App {...props} />, { exitOnCtrlC: false, stdin })` — Ink's entry point
6. Hooks raw stdin `'data'` listener to catch F-keys, Home/End, Backspace, mouse events
7. Installs terminal resize handling for the managed viewport
8. On every exit path, unmounts Ink and restores the normal screen buffer

### 2.3 Ink Shim: `ink.tsx`

`src/ink.tsx`

A **pastel-aware shim** over Ink's `<Text>` and `<Box>` components. Ink resolves bare color names (`color="red"`) against the terminal's 16-color palette (typically dark and harsh). Instead of rewriting ~300 hardcoded color attributes, the shim intercepts every `color` / `backgroundColor` / `borderColor` prop at runtime and routes it through `softColor()` to remap to Catppuccin Mocha pastel hexes.

Key design decisions:
- Wraps Ink's `Text` as a function component, not a forwardRef (Text never needs one)
- Wraps Ink's `Box` with `forwardRef` so `measureElement()` (used by Scrollable History) works
- Re-exports all other Ink exports unchanged (hooks, Static, etc.)
- `exactOptionalPropertyTypes`-safe: only attaches color props when they resolve to a value
- Catches both static literals AND dynamic values (syntax-highlight tokens, per-subagent colors, status-chip ternaries) with a single import swap per component

---

## 3. Display Regions

### 3.1 History Panel

**Components:**
- `src/components/scrollable-history.tsx` — default bounded, virtualized history viewport
- `src/components/history/index.tsx` — legacy `<History>` renderer and history component exports
- `src/components/history/entry.tsx` — discriminated union renderer for 11 entry kinds
- `src/components/history/assistant.tsx` — `AssistantBody` (markdown + code blocks), `AssistantTail` (8-row constant-height streaming tail)
- `src/components/history/banner.tsx` — startup banner with ASCII "W" logo + wordmark
- `src/components/history/code-block.tsx` — `CodeBlock`, `DiffBlock`, `DiffFileBlock` with syntax highlighting
- `src/components/history/tool-card.tsx` — tool call entry with expandable body
- `src/components/history/types.ts` — all entry type definitions
- `src/components/history/replay.ts` — session replay engine
- `src/components/history/utils.tsx` — formatting utilities (tokens, duration, bytes, path shortening)

**Entry kinds:**
| Kind | Description | Border Color |
|------|-------------|-------------|
| `user` | User message | `theme.user` (yellow) |
| `assistant` | AI response + parsed next-steps | `theme.assistant` (cyan) |
| `thinking` | Model reasoning block | `theme.brandAccent` (pink) |
| `tool` | Tool call with args + output + optional diff | per-tool glyph color |
| `info` | Slash-command output (raw ANSI preserved) | dimColor |
| `warn` | Warning messages | `theme.warn` (yellow) |
| `error` | Error messages | `theme.error` (red) |
| `turn-summary` | Turn statistics summary | `theme.textMuted` |
| `brain` | Brain decision log | `theme.monitor.agents` (magenta) |
| `banner` | Startup banner | brand orange |
| `confirm` | Permission confirm prompt | `theme.warn` |
| `subagent` | Delegated subagent result | per-agent color |

**Tool entry rendering** is a highlight: file-mutating tools (edit/write/patch/replace) get a Claude-Code-style mutation header:
```
● Update(src/foo.ts)  ·  12ms
  ⎿  Added 2 lines, removed 2 lines
```
With inline diff previews using dark green/red background washes (`#1e4620`/`#5a1e1e`) for the `useColor` path, or marker-only fallback when truecolor is unavailable.

### 3.2 Scrollable History (Managed Viewport)

`src/components/scrollable-history.tsx`

The TUI uses `<ScrollableHistory>` by default. It renders retained entries into
a **fixed-height, scrolled viewport**, preventing unbounded terminal scrollback.
Wheel, `PgUp`/`PgDn`, and `Ctrl+U`/`Ctrl+D` work in every mode; full mouse mode
adds scrollbar drag and clickable UI.

**Scrolling mechanism:**
- Parent Box: `height={viewportRows}`, `overflowY="hidden"`, `justifyContent="flex-end"`
- Content Box: `marginBottom={scrollOffset}` pushes content up by that many rows
- At offset 0, newest output naturally aligns to bottom (pinned)
- Ink's output clipper handles over/underflow while preserving ANSI styling

**Performance bounding:**
- At most 400 recent entries and 1 MiB of serialized display data are retained
- Older entries are replaced by an omission marker; the full session stays on disk
- Height-cache windowing mounts only the relevant viewport slice

**Scrollbar:**
- Right-edge 1-column track
- `scrollbarThumb()` computes thumb top/size from offset, total lines, and viewport rows
- Thumb rendering: `█` (thumb) / `│` (track), colored with `theme.accent` when scrollable
- `scrollOffsetForTrackRow()` inverts the thumb calculation for mouse click-to-scroll

**Streaming tails:**
- Assistant tail: constant 8 rows (newest pinned to bottom, blank padding on top)
- Tool stream box: constant-height box for live tool output
- Both participate in the scrolled content and auto-follow when pinned

### 3.3 Composer / Input

`src/components/input.tsx`

The composer is a multi-line input buffer with extensive terminal compatibility handling.

**`ComposerTopRail`** — isolated component with its own activity-icon timer:
- Animated icon: `. o O o .` cycling at 250ms while working
- Fixed icon: `◆` (brand diamond) when idle
- Right-aligned `ComposerStatusChip` for status
- Exact column accounting for left/right labels to preserve both corners
- `frameRuleParts()` for split border with reserved chip slot

**Key event handling** uses a dual-listener strategy:
1. **Ink's `useInput`** — primary handler for most keys
2. **Raw stdin `'data'` listener** — catches keys Ink misses (especially on Windows Terminal):
   - **Home/End**: CSI `H`/`F`, `1~`/`4~`, `OH`/`OF`, `7~`/`8~`
   - **Backspace/Delete**: `\x7f` (Unix DEL), `\x08` (Windows BS), `\x1b[3~` (Delete)
   - **Ctrl+Left/Right**: CSI `1;5D`/`1;5C` and `5D`/`5C` variants
   - **Meta+Backspace (Alt+Backspace/Opt+Backspace)**: `\x1b\x7f` and `\x1b\x08` → Ctrl+Backspace (delete word)
   - **Mouse reports**: SGR protocol (`\x1b[<...M`) — also filters leaked reports from Ink's useInput
   - **F-keys (F1-F12)**: raw CSI sequence decoding
   - **Escape buffering**: 10ms window to distinguish bare Esc from Escape-prefixed sequences (arrows, Home/End, Alt+key)

**Key suppression**: raw-stdin sets suppression refs so Ink's `useInput` doesn't fire duplicate events (critical for Backspace on Windows Terminal — would delete two characters).

**Layout:**
- `layoutInputRows()` converts text + cursor + prompt into `InputCell[]` rows
- Each row rendered as `<Text>` with coalesced style spans (prompt/chip/plain)
- Cursor rendered as single inverse cell
- `hidden` mode: renders empty Box of same height (keeps listeners alive so overlays remain closable)
- Footer: `frameRule(cols, hint, '', 'bottom')` for the ╰─╯ border

### 3.4 Status Bar

`src/components/status-bar.tsx` + `src/components/powerline-rail.tsx`

The status bar is the most visually rich component, composed of multiple lines:

**Line structure:**
- **Line 1-2**: Powerline-style segmented rail — model, provider, context %, YOLO chip, spinner, etc.
- **Line 3** (optional): Brain status, mailbox activity, enhance status, debug stream stats
- **Line 4** (optional): Subagent fleet overview — `agents ▶3` with per-agent context bars
- **Line 5** (optional): Goals, autonomy stage
- **Bottom rule**: context window meter (sub-cell-precise Unicode block)

**PowerlineRail** — full-cell status segments:
- Each segment has a background color from `RAIL_BACKGROUNDS` array (5 alternating Catppuccin surface tones)
- Powerline-style transitions: `◖` start, `▶` between segments, `◗` end
- Unicode profile: font-safe half-circles/triangles
- Nerd Font profile: canonical Powerline private-use glyphs (``, ``, ``)
- Full-width background filler: extends last segment's bg color to edge
- Monochrome mode: dim-color `[` `›` `]` transitions
- Overflow: `+N` indicator when segments exceed budget

**`ThinkingChip`** — renders the working state label with animation:
- 5 animation styles + `cycle` meta-mode (see §4 Animation System)
- `rainbow`: per-glyph hue from 12-stop Catppuccin wheel
- `wave`: sinusoidal brightness sweep, peach accent
- `pulse`: cosine-based whole-text brightness modulation
- `dots`: trailing `.` `..` `...` cycling
- `breathe`: braille spinner prefix, flat text

**Context meter** uses sub-cell-precise Unicode fractions:
```ts
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
```
Each terminal cell is 1/8 resolution, so the bar grows smoothly token-by-token.

### 3.5 Contextual Shortcut Hints

There is no standalone shortcut-bar component: each panel, picker and surface owns its own hint string and renders it inside its own frame.

- Panels and overlays define their hint themselves — e.g. `src/components/auth-panel.tsx` (`↑/↓ select · Enter open · Esc close`), `src/components/brain-panel.tsx`, `src/components/audit-panel.tsx` (`Esc close · Alt+PgUp/PgDn scroll`), `src/components/chat-search-bar.tsx`, `src/components/design-picker.tsx`, `src/components/checkpoint-timeline.tsx`
- Pickers receive theirs as a `hint` prop from `src/app-view-pickers.tsx` (`hint={state.modelPicker.hint}`, and the same for the other pickers) and render it inside their own border
- The composer hint is a separate path: `src/components/input.tsx` declares the `hint` prop, defaults `footerHint` to `Enter send · @ file · / commands · $ skill`, and renders `bottomHint = modeLabel + (pointer.notice || hint || footerHint)` in the bottom frame
- `src/app-view.tsx` fills that prop with `selectionModeError || (bashMode ? BASH_HINT : inputHint)`, where `inputHint` is derived in `src/app-view-state.ts` (e.g. `slash command — Enter to dispatch` while an idle buffer starts with `/`)
- `src/app-status-region.tsx` gives the status bar its own hint: `state.copiedNotice || renderRunningTools(state.runningTools) || state.hint`

### 3.6 Startup Banner

`src/components/history/banner.tsx`

The startup banner is a responsive component that renders differently based on terminal width:

**Full layout (≥56 cols):**
- 3×5 ASCII "W" logo: `██` blocks, orange (#FD9F02) columns 0,2,3,4 and pink (#FE2E5F) column 1
- 10-letter "WRONGSTACK" wordmark in 7-row block glyphs, each letter defined as 7-row arrays
- Orange→pink gradient across letters (W:#FD9F02 → K:#FE2E5F, 4-stop linear gradient)
- Orange→pink gradient separator line
- 2-column fact grid: FAMILY + KEY (left) · WORKSPACE + COMMANDS (right)

**Compact layout (<56 cols):**
- Inline `[ WrongStack ]` badge with orange background
- Single-column fact rows
- Shortened tagline

### 3.7 Markdown Renderer

`src/markdown.tsx` + `src/markdown-table.ts`

A lightweight markdown renderer for assistant prose:

**Inline parsing:**
- `**bold**`, `*italic*` (single `*` only — `**` handled first), `` `code` ``, `~~strike~~`
- LRU cache (5,000 entries) for repeated lines
- `_` underscores are intentionally NOT treated as italic — prevents mangling snake_case and file_names
- Unterminated markers emitted literally (no text ever lost)

**Block constructs:**
- ATX headings: `#` through `######`
- Bullet lists: `-`, `*`, `+` with indentation
- Numbered lists: `1.`, `2.`, etc.
- Blockquotes: `>` lines, dim-colored
- Box-drawing characters (U+2500-U+257F): character-by-character rendering to avoid East Asian Width mis-measurement

**Tables:**
- GitHub-flavored markdown tables → Unicode box-drawing rendering
- `detectTable()` scans for consecutive table lines
- `renderTable()` generates `` ┌──┬──┐ `` / `` ├──┼──┤ `` / `` └──┴──┘ `` grids
- Cells wrap within column widths
- Column alignment: left/default, right (`-:`), center (`:-:`) via header dash analysis
- Table width sized to `tableBudget` parameter for proper panel containment

---

## 4. Animation System

`src/components/animation-style.ts`

The TUI has a sophisticated animation subsystem shared between the status bar's `ThinkingChip` and the composer's `ComposerStatusChip`.

### 4.1 Style Catalog

| Style | Visual Effect | Mechanism |
|-------|--------------|-----------|
| `rainbow` | Per-glyph hue cycling | Each char colored from 12-stop Catppuccin Mocha wheel, phase shifts per tick |
| `wave` | Single-color brightness sweep | Sinusoidal brightness wave across characters, interpolating DIM→ACCENT |
| `pulse` | Whole-text breathing | Cosine-based modulation, entire chip dims/brightens in unison |
| `dots` | Growing/shrinking ellipsis | Appends `.` → `..` → `...` → `..` → `.` → (empty) cycle |
| `breathe` | Braille spinner prefix | 10-frame braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) + static text |

### 4.2 `cycle` Meta-Mode

The `cycle` meta-style rotates through `wave → pulse → dots → breathe` (excluding `rainbow`, the canonical default), switching every 12 seconds (`CYCLE_INTERVAL_SECONDS`). The `CYCLE_ORDER` is indexed via `styleForCycleTick(tick)`:
```ts
const idx = Math.max(0, Math.floor(tick / CYCLE_INTERVAL_SECONDS));
return CYCLE_ORDER[idx % CYCLE_ORDER.length];
```

### 4.3 `ComposerStatusChip` Animation Invariants

The composer chip has two hard invariants:
1. **Isolation** — owns its OWN spinner/cycle timers so per-frame re-renders stay local; must never be inlined into `<Input>` (whose `React.memo` and keyboard listeners would churn at ~4 Hz)
2. **No jitter** — every render is padded to exactly `reservedWidth` columns via `composerStatusReservedWidth()`, so the growing dots ellipsis and rolling word can never push the right corner around

### 4.4 Color Utilities

- `mixHex(a, b, t)`: linear RGB interpolation, `t ∈ [0,1]`
- `waveColor(i, phase, len)`: per-character sinusoidal color for wave style
- `pulseColor(phase)`: cosine-based whole-text color modulation
- `stripTrailingDots(text)`: ensures the `dots` style doesn't double-up on user's label

---

## 5. Theme System

`src/theme.ts`

### 5.1 Color Palette

Base palette: **Catppuccin Mocha** (soft pastels)

| ANSI Name | Pastel Hex | Usage |
|-----------|-----------|-------|
| `black` | `#11111b` | — |
| `red` | `#f38ba8` | Errors, critical risks |
| `green` | `#a6e3a1` | Success, added diff lines |
| `yellow` | `#f9e2af` | Warnings, user messages |
| `blue` | `#89b4fa` | — |
| `magenta` | `#cba6f7` | Brain, subagents, agents monitor |
| `cyan` | `#94e2d5` | Accent, assistant, tool names |
| `white` | `#cdd6f4` | Primary text |
| `blackBright` | `#585b70` | Border default |

The `softColor()` function resolves a color in three steps and passes hex/rgb/unknown values through unchanged:

1. `syntax.<role>` resolves against the **active** theme (see `SYNTAX_TOKEN`).
2. A bare ANSI name listed in `ANSI_TOKEN` — `cyan`, `yellow`, `green`, `red`,
   `magenta`, `white` — resolves to the **active** theme's matching semantic
   token (`accent`, `warn`, `success`, `error`, `brand`, `textPrimary`). This
   covers 172 of the ~179 remaining bare-name call sites, so selecting a preset
   recolors them too. Each of these six is byte-identical to its `pastel` entry
   on Catppuccin, which is what makes the mapping a no-op on the default theme.
3. Anything else — `gray`, `blue`, the `*Bright` variants — falls back to the
   frozen `pastel` map. These have no exactly-equal token on Catppuccin, so
   mapping them would shift the default theme; they stay pinned deliberately.

### 5.2 Semantic Theme Tokens

```ts
interface Theme {
  textPrimary: string;      // #cdd6f4 — main readable text
  textSecondary: string;    // #bac2de — supporting labels
  textMuted: string;        // #6c7086 — quiet metadata
  brandPrimary: string;     // #FD9F02 — WrongStack orange
  brandAccent: string;      // #FE2E5F — WrongStack pink
  surface: string;          // #181825 — panel surface
  surfaceRaised: string;    // #1e1e2e — focused chrome
  accent: string;           // cyan — prompts, links, tool names
  user: string;             // yellow — user label
  assistant: string;        // cyan — assistant label
  success/green: string;    // green
  warn/yellow: string;      // yellow
  error/red: string;        // red
  dim: true;                // true → Ink's dimColor
  borderDefault: string;    // #585b70
  borderActive: string;     // yellow
  brand: string;            // magenta
  monitor: { fleet, agents, worktree, phase };
  diffAddBg: string;        // #1e4620
  diffDelBg: string;        // #5a1e1e
  supportsBackground: boolean; // truecolor detection
}
```

### 5.3 Truecolor Detection

`detectSupportsBackground()` checks:
1. `isTTY` — non-TTY → false
2. `NO_COLOR` set → false
3. `COLORTERM=truecolor|24bit` → true
4. `TERM` contains `truecolor`/`24bit` → true
5. `TERM` contains `256color` → true
6. Falls back to `true` (most modern terminals)

Both `env` and `isTTY` are overridable for testability.

---

## 6. Glyph System

`src/ui-glyphs.ts`

### 6.1 Three Profiles

| Profile | Activate With | Usage |
|---------|--------------|-------|
| `unicode` | automatic fallback or `WRONGSTACK_TUI_ICON_STYLE=unicode` | Portable Unicode set, no special fonts needed; base of the width-safe `browser` profile used in [browser terminals](./tui-browser-terminals.md) |
| `nerd` | automatic local detection or `WRONGSTACK_TUI_ICON_STYLE=nerd` | Rich Nerd Font icons (requires Nerd Font installed and selected in the terminal) |
| `ascii` | `--ascii` or `WRONGSTACK_TUI_ICON_STYLE=ascii` | Pure ASCII — CI captures, basic terminals |

The glyph set covers only the named chrome glyphs. In ASCII mode every other symbol is converted as well: box drawing, arrows, bullets, spinners, emoji, Nerd Font icons and typographic punctuation. The `Text` wrapper in `src/ink.tsx` converts text before Ink measures it, and bordered `Box`es switch to Ink's `classic` border. stdout/stderr are wrapped too (width-preserving) for the plain REPL and one-shot output (`@wrongstack/core` `utils/ascii-fallback.ts`). Letters and digits in any script are left alone. Measured in a real pseudo-terminal: the TUI's first screen plus the command palette went from 8,143 non-ASCII characters to 0.

**Browser-hosted terminals never auto-select `nerd`.** xterm.js-family emulators paint with a client-side CSS font stack and implement no image protocol, so `detectTerminalHost()` suppresses the server-side font scan (portable `unicode` profile) and clamps `graphicsProtocol` to `halfblock`/`none`. See [TUI in browser-hosted terminals](./tui-browser-terminals.md) for detection markers, overrides, and tests.

### 6.2 42 Semantic Glyphs

Including but not limited to:
- `brand`: ◆ / 󰚩 / `*`
- `prompt`: ❯ / ❯ / `>`
- `success/failure`: ✓/× / same / `+`/`x`
- `running/idle/pending`: ▶/●/○ / same / `>`/`o`/`.`
- `fleet/brain/mail/bug`: ◈/✦/✉/◇ / 󰓾/󰧑/󰇮/󰃤 / `%`/`*`/`m`/`b`
- `segmentStart/Transition/End`: ◖/▶/◗ / // / `[`/`>`/`]`

Loaded once at module init via `glyphSet(resolveIconStyle())`.

---

## 7. Terminal Width Utilities

`src/terminal-width.ts`

Essential for correct visual layout since JavaScript `.length` counts UTF-16 code units, not terminal cells.

| Function | Purpose |
|----------|---------|
| `displayWidth(str)` | Grapheme-aware terminal cell width: emoji=2, combining marks=0, wide CJK=2, private-use=1 |
| `stripAnsi(str)` | Remove ANSI escape sequences |
| `truncateDisplay(str, maxWidth)` | Truncate with `…` at display width |
| `padDisplayEnd(str, width)` | Right-pad to exact display width |
| `frameRule(w, left, right, edge)` | Build ╭─{left}─{fill}─{right}─╮ border line |
| `frameRuleParts(w, left, reserved, edge)` | Split border into head/gap/tail for animated chip insertion |

Uses `Intl.Segmenter` for grapheme segmentation (available in Node.js 22+).

---

## 8. Pickers

The TUI has an extensive picker system for interactive selection:

### 8.1 Slash Command Picker
- Triggered by `/` at the start of the input buffer
- Fuzzy matches against registered slash commands
- Renders in a bordered panel below the input

### 8.2 File Picker
- Triggered by `@` in the input buffer
- Fuzzy file search across the project directory
- Shows file path + type icon

### 8.3 Model Picker
- Triggered by `Ctrl+M`
- Two-step flow: select provider → select model
- Shows available models per provider

### 8.4 F-Key Panel Picker (`/f`)
- Unified launcher for all F-key panels (F1-F12)
- Shared metadata source `F_KEY_ENTRIES` to prevent shortcut drift

### 8.5 Other Pickers
- Autonomy picker (off/suggest/auto/eternal/eternal-parallel)
- Mode picker (teach/brief/code-reviewer/etc.)
- Design picker (kits by stack)
- Prompt picker (categorized prompt library)
- Resume session picker
- Settings picker (statusline mode, animation style, thinking word, token saving, etc.)
- Statusline picker (hide/show individual chips)
- Plugin picker, MCP picker, Tools picker
- Project picker, Send-mode picker

---

## 9. Panels & Overlays

### 9.1 Fleet Panel (F2 / Ctrl+F)
- Real-time subagent fleet monitor
- Per-agent status: idle/running/success/failed/timeout/stopped
- Streaming text, tool calls, iterations, cost
- Budget warnings, extension counts, context pressure
- Per-subagent transcript paths
- Fleet cost and token totals

### 9.2 Agents Monitor (F3 / Ctrl+G)
- Per-agent context bars (sub-cell-precise)
- Timeline with agent events
- Leader context tracking

### 9.3 Worktree Monitor (F4 / Ctrl+T)
- Git worktree status (handle, branch, path)
- Live upsert/remove events

### 9.4 Brain and autonomy views
- Brain decision log with risk levels (low/medium/high/critical)
- Per-seat voting status
- Settings management

### 9.5 Other Panels
- **Plan Panel (F5)**: task plan overview
- **Todos Monitor (F6)**: session todo list overlay
- **Queue Panel (F7)**: queued prompts
- **Process List (F8)**: background process registry
- **Goal Panel (F9)**: session goals
- **Sessions Panel (F10)**: live terminal sessions
- **Coordinator Monitor (F11)**: autonomous coordinator state
- **Kanban Panel (F12)**: project task board; `/statusline` opens chip controls separately
- **Help Overlay (?)**: keyboard shortcuts reference
- **Shadow Panel**: background shadow agent controls
- **Audit Panel**: side-effect audit trail
- **Phase Monitor**: goal execution status
- **SDD Board**: structured development board overlay
- **Collaboration Session**: BugHunter/RefactorPlanner/Critic results
- **Checkpoint Timeline**: session checkpoint history
- **Mailbox Panel (Ctrl+B?)**: inter-agent message center
- **Kanban Panel**: task board management
- **Settings Panel (Ctrl+S)**: full settings editor with filter
- **Auth Panel**: provider/local model configuration
- **Help Panel**: extended help pages

---

## 10. Terminal Integration

### 10.1 Signal Handling
- **SIGINT Ladder**: first Ctrl+C → abort current turn; second Ctrl+C → exit
- **SIGTERM**: graceful shutdown of Ink instance
- **Raw Ctrl+C reader**: on Windows Terminal (ConPTY) Ctrl+C arrives as data on stdin, never as a signal — caught by the raw stdin handler

### 10.2 Mouse Mode
- SGR protocol (`\x1b[<...M / m`) for precise pixel/scroll tracking
- Wheel tracking stays active for managed history; full pointer mode is optional
- `parseMouseEvents()` in `mouse.ts`
- Wheel events → scroll offset changes
- Click events → scrollbar track → `scrollOffsetForTrackRow()`
- Leaked mouse reports (Ink inserts as text) filtered in `Input.tsx`

### 10.3 Resize Handling
- Window resize → `\x1b[J` erase from cursor to end of screen
- Prevents ghost artifacts (reflow leaves stale rows below cursor)
- Does NOT home cursor (`\x1b[H`) — that would reposition the live region to the top of viewport
- Ink immediately re-renders at the new width

### 10.4 Terminal Title
`src/terminal-title.ts`

Animated tab/window title via OSC-0 sequence (`ESC ] 0 ; <text> BEL`):
- Thinking state: `⠋ thinking… · WrongStack`
- Tool running: `⠋ ▸ bash · WrongStack`
- Idle: scrolling marquee of app name
- 130ms interval (unref'd to not keep event loop alive)
- Disable with `WRONGSTACK_NO_TITLE=1`
- Also off under `WRONGSTACK_REDUCED_MOTION=1` (see 10.5)

### 10.5 Reduced motion
`src/motion.ts`

The `static` animation style (Settings → animation) means no decorative
motion anywhere: the working label, the status-bar and composer spinners,
the tool-stream spinner and the fast color clock all stop. Color-moving
clocks (~8 fps) run only for `rainbow`, `wave`, `pulse` and `cycle`.
`WRONGSTACK_REDUCED_MOTION=1` forces `static` and disables the animated
terminal title for the process without changing saved settings — useful for
screen readers, screen recordings, slow remote terminals and CI. Elapsed
timers, countdowns and progress indicators keep updating.

---

## 11. Thinking Word System

`src/thinking-word.ts`

The configurable label shown during agent processing (e.g., "thinking", "pondering", "conjuring"):

**Pool** (24 words): pondering, cogitating, ruminating, noodling, brewing, conjuring, percolating, scheming, tinkering, vibing, crafting, wrangling, summoning, finagling, marinating, hatching, juggling, spelunking, contemplating, bamboozling, alchemizing, incubating, doodling, mulling

**Validation:**
- Max 16 characters
- Single token (alphanumeric + `_` `-` only)
- Falls back to `"thinking"` on invalid values

**Random mode** activates when the user leaves the default or explicitly sets `"random"`. `pickRandomTuiThinkingWord(previous)` avoids repeating the last-used word when possible.

---

## 12. Fleet & Subagent Integration

### 12.1 Fleet State Management
- `reduceFleetState` in `src/reducers/fleet.ts` handles subagent events from the FleetBus
- Per-agent fields: id, name, provider, model, status, streaming text, iterations, tool calls, cost, context pressure, budget warnings, extensions, transcript path
- `fleetBatch` action coalesces high-frequency events (agent status updates at ~150ms) into a single reducer pass to prevent React thrash

### 12.2 Leader Tracking
- Leader iteration/tool call counters
- Current tool tracking (`tool.started` / `tool.executed` events)
- Fleet cost and token totals

### 12.3 Agents Monitor
- Per-agent context bars with sub-cell-precise meters
- Timeline visualization of agent lifecycle events
- Agent transcript reader integration

---

## 13. Collaboration Debug System

The TUI integrates with the `collab-debug` subsystem:

- **BugHunter events** (`collabBugFound`): sessionId, bugId, severity, description
- **RefactorPlanner events** (`collabPlanEmitted`): sessionId, planId, riskScore, phaseCount
- **Critic evaluations** (`collabEvalComplete`): sessionId, evalId, verdict, score
- **Session lifecycle** (`collabSessionDone`, `collabSubagentSpawned`)
- Rendered in the FleetPanel and AgentsMonitor as structured entries

---

## 14. Mailbox Integration

The TUI includes a full mailbox panel with:

- Live message polling (10s interval when panel is open)
- Event-driven message/agent registration from `mailbox.received` and `mailbox.agent_registered` events
- Agent list with status/source/session tracking
- Message display (from, subject, timestamp, read/completed status)
- Up to 50 messages, 30 agents in-memory

---

## 15. Autonomy & Eternal Mode

The TUI supports all autonomy modes:
- `off` — fully manual
- `suggest` — suggests next actions
- `auto` — auto-proceeds with countdown
- `eternal` — continuous autonomous operation
- `eternal-parallel` — parallel autonomous runs

Eternal mode integration: the TUI drives `runOneIteration()` from the post-slash hook to prevent race conditions between the engine and the TUI on the shared Context. Subscriptions for per-iteration events and stage transitions power the live status bar.

---

## 16. Key Bindings

| Key | Effect |
|-----|--------|
| `Enter` | Submit |
| `Shift+Enter` | Insert newline |
| `Ctrl+C` (once) | Abort current turn |
| `Ctrl+C` (twice) | Exit |
| `Ctrl+D` (empty buffer) | Exit |
| `↑` / `↓` | History nav (buffer empty) |
| `@` | File picker |
| `/` (at start) | Slash command picker |
| `?` (empty prompt) | Help overlay |
| `F1` | Project switcher |
| `Ctrl+F` / `F2` | Fleet monitor |
| `Ctrl+G` / `F3` | Agents monitor |
| `Ctrl+T` / `F4` | Worktree monitor |
| `F5` | Plan panel |
| `F6` | Todos overlay |
| `F7` | Queue panel |
| `F8` | Process list |
| `F9` | Goal panel |
| `F10` | Sessions panel |
| `F11` | Coordinator monitor |
| `F12` | Kanban board panel |
| `Ctrl+S` | Settings |
| `Esc` | Close picker/dialog/panel |
| `Ctrl+L` | Clear screen |

---

## 17. Test Infrastructure

- **Framework:** Vitest
- **Config:** `vitest.config.ts` — `@wrongstack/core` resolved to source (not dist)
- **Timeout:** 60 seconds (both test and hooks)
- **Max workers:** 2 in watch mode, 4 for a single run (shared cap in `vitest.workers.ts`)
- **Setup:** `../../vitest.setup.ts`
- **Ink testing:** `ink-testing-library` ^4.0.0 for component-level tests

### 17.1 Test Coverage Highlights

| Area | Key Test Files |
|------|---------------|
| **Input & Composer** | `input-top-rail.test.ts`, `input-tokens.test.ts`, `input-editing-baseline.test.ts`, `input-history-reducer.test.ts`, `input-paste-false-positive.test.ts` |
| **Status Bar** | `status-bar.test.ts`, `status-bar-overflow.test.ts`, `status-bar-rail-order.test.ts`, `status-bar-separators.test.ts`, `status-bar-sgr.test.ts` (truecolor pins, dedicated config), `powerline-rail.test.tsx` |
| **Animation** | `animation-style.test.ts`, `composer-status-chip.test.ts`, `thinking-word.test.ts` |
| **History & Entries** | `assistant-body.test.ts`, `assistant-body-width.test.ts`, `banner.test.ts`, `entry-next-steps.test.ts`, `replay.test.ts` |
| **Scroll** | `scroll-reducer.test.ts`, `scrollbar.test.ts`, `history-stream-cap.test.ts` |
| **Fleet** | `fleet-reducer.test.ts`, `fleet-monitor.test.ts`, `fleet-panel.test.ts`, `fleet-chat-coalescer.test.ts` |
| **Markdown** | `markdown-inline.test.ts`, `markdown-table.test.ts` |
| **Pickers** | `model-picker.test.ts`, `mode-picker.test.ts`, `file-search.test.ts`, `tools-picker-render.test.tsx`, `tools-picker-reducer.test.ts`, `plugin-picker-component.test.ts`, `plugin-picker-reducer.test.ts`, `project-picker-reducer.test.ts`, `mcp-picker-reducer.test.ts` |
| **Settings** | `settings-filter.test.ts`, `settings-slash.test.ts`, `settings-thinking-word.test.ts`, `settings-value-set.test.ts`, `token-saving-tier-settings.test.ts` |
| **Statusline** | `statusline-picker.test.ts`, `statusline-picker-integration.test.ts`, `statusline-hidden-sync.test.ts`, `statusline-navigation-order.test.ts` |
| **Terminal** | `terminal-width.test.ts`, `terminal-title.test.ts`, `supports-background.test.ts`, `mouse.test.ts`, `hit-test.test.ts` |
| **F-Keys** | `fn-keys.test.ts`, `f-key-panels.test.ts`, `f-key-adjacent-render.test.ts`, `f-key-monitors-render.test.ts`, `f1-flow.test.ts` |
| **App Integration** | `app.test.ts`, `app-mount.test.ts`, `app-resume-render.test.ts`, `app-initial-state.test.ts`, `app-integration-submit-history.test.ts`, `reducer.test.ts` |
| **Monitors** | `agents-monitor.test.ts`, `monitor-shell.test.ts`, `worktree-monitor.test.ts`, `active-strip-fixed-height.test.ts`, `live-tail-fixed-height.test.ts` |
| **Panels** | `brain-panel-reducer.test.ts`, `auth-panel.test.tsx`, `auth-panel-model.test.ts`, `auth-panel-reducer.test.ts`, `enhance-panel.test.ts`, `help-overlay.test.ts`, `coordinator-reducer.test.ts`, `confirm-prompt.test.ts`, `continue-confirm-panel.test.ts`, `shell-command-warning.test.ts` |
| **Misc** | `clipboard.test.ts`, `paste-accumulator.test.ts`, `git-info.test.ts`, `heap-watchdog.test.ts`, `highlight.test.ts`, `steering-preamble.test.ts`, `tool-glyph.test.ts`, `tool-format.test.ts`, `tool-entry-render.test.ts`, `diff-block-render.test.ts`, `detect-at-token.test.ts`, `prune-tool-input.test.ts`, `run-tui-guard.test.ts`, `silence-terminal.test.ts` |

---

## 18. Source File Index

Paths are relative to `packages/tui/`. File sizes change with every refactor, so the live source tree is the source of truth.

| File | Purpose |
|------|---------|
| `src/app.tsx` | `<App>` wrapper: runs `useAppController`, renders `<AppView>`; re-exports public types and helpers |
| `src/app-view.tsx` · `src/app-main-column.tsx` · `src/app-status-region.tsx` · `src/app-view-pickers.tsx` · `src/app-view-prompts.tsx` · `src/app-view-sidebar.tsx` | View composition: root view, chat-column layout, status region, picker overlays, prompt overlays, sidebar column |
| `src/app-state.ts` · `src/app-state-core-types.ts` · `src/app-state-fleet.ts` · `src/app-ui-state.ts` · `src/app-view-state.ts` · `src/app-panel-state.ts` | `State` and supporting type modules |
| `src/app-action-type.ts` | Discriminated `Action` union |
| `src/app-reducer.ts` | Reducer entry point; delegates each action to a `src/reducers/*` module |
| `src/reducers/*` | Reducer modules: composer, panel pickers, workspace panels, settings values, fleet, activity, dialogs, chat search, conversation, message jump |
| `src/app-initial-state.ts` | `createInitialState()` factory |
| `src/run-tui.ts` | Ink bootstrap, signals, mouse, terminal title |
| `src/components/input.tsx` | Multi-line composer with raw stdin handling |
| `src/components/status-bar.tsx` · `src/components/powerline-rail.tsx` · `src/components/composer-status-chip.tsx` | Multi-line status rail, segmented powerline chips, isolated animated composer chip |
| `src/components/scrollable-history.tsx` | Managed viewport with scrollbar |
| `src/components/history/index.tsx` · `src/components/history/entry.tsx` · `src/components/history/types.ts` · `src/components/history/assistant.tsx` · `src/components/history/banner.tsx` | `<History>` renderer, discriminated entry renderer (11 kinds), history entry types, assistant body + streaming tail, startup banner |
| `src/markdown.tsx` · `src/markdown-table.ts` | Lightweight markdown + inline renderer; GitHub table → Unicode box-drawing |
| `src/theme.ts` · `src/ui-glyphs.ts` · `src/components/animation-style.ts` | Catppuccin Mocha pastel palette + theme, 3-profile icon system, 5 animation styles + cycle meta-mode |
| `src/terminal-width.ts` · `src/terminal-title.ts` · `src/ink.tsx` · `src/thinking-word.ts` · `src/mouse.ts` | Grapheme-aware cell measurement, animated window/tab title (OSC-0), pastel-aware Ink shim, working label + 24-word pool, SGR mouse event parser |
| `src/hooks/*` · `src/components/*` | Custom React hooks; all UI components + pickers + panels |

---

## 19. Recent Notable Changes

Based on mailbox broadcast activity during this session:

- **Composer top rail fix**: Preserved exact terminal width and both corners for long thinking/agent labels; switched background-agent label to ASCII `agents >N`; bounded all status frames; animated lead icon as `. o O o .`
- **PowerlineRail**: Added full-width background filler — after the last rendered chip, remaining terminal width is filled with spaces using the last segment's background color
- **Composer animation**: Four stored frames `['.', 'o', 'O', 'o']` looping yields `. → o → O → o → .`
- **Council Phase 0/1/2**: Ongoing addition of council orchestration system (not TUI-specific but affects TUI-brain integration)

---

## 20. Known Issues & Maintenance Notes

### 20.1 Codebase Notes (from `TUI_TASKS.md`)
1. Extract shared F-key panel metadata to eliminate drift between HelpOverlay, F-key picker, and README
2. Harden F-key launcher behavior for special-case panels (statuslineOpen)
3. Reduce duplicated panel-close logic across `app.tsx` and overlay helpers
4. Add drift tests for documentation alignment
5. Add panel-local shortcut hints for panels that own keyboard input

### 20.2 Design Considerations
- **No font installation**: WrongStack never silently installs or changes system fonts; it detects an existing local Nerd Font and uses the Nerd profile automatically. SSH cannot expose the client font, so remote sessions require an explicit `WRONGSTACK_TUI_ICON_STYLE=nerd` override. Browser-hosted terminals are treated the same way, and a web terminal that reports no marker can be pinned with `WRONGSTACK_TUI_TERMINAL=browser` (or forced back with `=native`).
- **Alternate screen**: The TUI owns a full alternate buffer, so terminal-native scrollback is unavailable while it is visible; the normal shell screen is restored on exit
- **Performance**: `React.memo` on history/input prevents keystroke churn; display retention is capped at 400 entries / 1 MiB; height-cache windowing, markdown LRU caching, and `fleetBatch` coalescing bound hot paths
- **Ghost artifacts**: Resize handler erases from cursor to end-of-screen to prevent reflow ghosts
- **Panel close mechanism**: Overlays rendered above the input keep the input `hidden` but mounted (not unmounted) so keyboard listeners for F-key/Esc remain active and panels remain closable

---

*Report generated 2026-10-25 from live source inspection of `packages/tui/`. Source and test counts are omitted on purpose — use the live source tree and test inventory.*
