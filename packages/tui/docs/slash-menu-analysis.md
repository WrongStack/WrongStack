# Slash Command Menu Analysis — TUI Interface

> **Date:** 2026-07-06
> **Scope:** `packages/cli/src/slash-commands/` (70+ commands), `packages/tui/src/` (panel/picker infrastructure)
> **Goal:** Identify which `/` commands could gain an interactive TUI menu instead of the current text output

---

## 1. Current State: Existing Panels & Pickers

The TUI already has **18 panels/pickers**. Each one follows a three-part architecture: an `ink` React component, state in `app-state.ts`, reducer cases in `app-reducer.ts`, and a bridge entry in `on-panel-open.ts`.

### ✅ Commands That Already Have a Panel/Picker

| Command | Panel/Picker | State Type | Interaction |
|-------|-------------|------------|-----------|
| `/` (bare) | `SlashMenu` | `slashPicker` | Type/search → Enter to run |
| `/settings` | `SettingsPicker` | `settingsPicker` | ←/→ cycle value, `/` search, 37 fields |
| `/mode` | `ModePicker` | `modePicker` | ↑↓ → Enter to select |
| `/plugin` | `PluginPicker` | `pluginPicker` | ↑↓ → Enter/←/→ toggle |
| `/auth` | `AuthPanel` | `authPanel` | Provider list → OAuth flow |
| `/model` | `ModelPicker` | `modelPicker` | 2-step: provider → model |
| `/autonomy` | `AutonomyPicker` | `autonomyPicker` | Mode selection |
| `/design` | `DesignPicker` | `designPicker` | Kit list → stack selection |
| `/prompt` | `PromptPicker` | `promptPicker` | Category filter + select |
| `/resume` | `ResumePicker` | `resumePicker` | Session list → resume |
| `/statusline` | `StatuslinePicker` | `statuslinePicker` | Chip toggle |
| `/fleet` | `FleetPanel` | `monitorOpen` | Live subagent monitor |
| `/kanban` | `KanbanPanel` | `kanbanPanelOpen` | Board + task view |
| `/goal` | `GoalPanel` | `goalPanelOpen` | Goal progress |
| `/sessions` | `SessionsPanel` | `sessionsPanelOpen` | Session list |
| `/audit` | `AuditPanel` | `auditPanelOpen` | Audit log viewer |
| `/autophase` | `PhasePanel` | `autoPhase` | Phase graph board |
| `/worktree` | `WorktreePanel` | `worktrees` | Worktree list |
| `/plan` | `PlanPanel` | `planPanelOpen` | Plan view |
| `/agents` | `AgentsMonitor` | `agentsMonitorOpen` | Subagent monitor |
| `/todos` | `TodosMonitor` | `todosMonitorOpen` | Todo chip list |
| `/queue` | `QueuePanel` | `queuePanelOpen` | Queue management |
| F-keys (F1-F12) | Various panels | Various | Function key shortcuts |

### Panel/Picker Architecture (3 Layers)

```
packages/tui/src/
├── app-state.ts             # State types + Action union (809-1290)
├── app-reducer.ts           # Reducer case for each action
├── components/<name>.tsx    # Ink React component
├── on-panel-open.ts         # Slash → dispatch bridge
└── hooks/use-picker-keys.ts # Shared ↑↓/Enter/Esc handler
```

**Pattern for adding a new panel** (6 steps):
1. `app-state.ts` → add state shape + Action type
2. `app-reducer.ts` → add reducer cases
3. `components/<name>.tsx` → add Ink component
4. `app.tsx` → render when `state.open`
5. `on-panel-open.ts` → add bridge action string
6. `cli/src/slash-commands/<name>.ts` → call `onPanelOpen.current(...)`

---

## 2. Commands That Could Gain Menus

### 🔴 PRIORITY (High interaction, text CRUD, clear menu potential)

#### 1. `/mcp` — MCP Server Management
- **Current:** Text CRUD through `manage.ts` (add/remove/enable/disable/restart)
- **Menu potential:** ⭐⭐⭐⭐⭐
- **Proposal:** `McpPicker` — a PluginPicker-like list with a toggle, status indicator, and restart button for each MCP server
- **State:** `mcpServers: { open, servers: McpServerRow[], selected, busy }`
- **Actions:** `mcpPickerOpen`, `mcpPickerClose`, `mcpPickerMove`, `mcpPickerToggle`, `mcpPickerAdd`, `mcpPickerRemove`
- **Files:** `packages/cli/src/slash-commands/mcp.ts` (already has an `opts.onMcp` callback, 350 lines)

#### 2. `/tools` — Tool Blacklist & Tier Management
- **Current:** Text list + enable/disable by tool name
- **Menu potential:** ⭐⭐⭐⭐⭐
- **Proposal:** `ToolsPicker` — a SettingsPicker-like list that groups tools into categories (TIER1/TIER2/TIER3) and toggles enable/disable
- **State:** `toolsPicker: { open, items: ToolPickerItem[], selected, filter }`
- **Note:** `packages/cli/src/slash-commands/tools.ts` is 220+ lines and already emits categorized text output, making it a strong candidate for a list component

#### 3. `/brain` — Brain Arbiter Settings
- **Current:** Text subcommands (ask, status, risk, log)
- **Menu potential:** ⭐⭐⭐⭐
- **Proposal:** `BrainPanel` — 3 panes: risk slider, recent decisions log, question input
- **State:** `brainPicker: { open, riskLevel, log: BrainLogEntry[], selected }`
- **Note:** `packages/cli/src/slash-commands/brain.ts` is 100+ lines; a visual risk scale would fit nicely

#### 4. `/fleet` (extended) — Fleet Management
- **Current:** FleetPanel monitor exists, but management actions (kill, retry, log, concurrency) are text-based
- **Menu potential:** ⭐⭐⭐⭐
- **Proposal:** Add a sub-action toolbar to FleetPanel (Status/Kill/Retry/Logs/Terminate)
- **Note:** There is already a `toggleMonitor` panel action, so this can be extended

#### 5. `/shadow` — Shadow Agent Config
- **Current:** Text start/stop/status/config
- **Menu potential:** ⭐⭐⭐
- **Proposal:** `ShadowPanel` — interval slider, provider/model picker, status indicator
- **Note:** `packages/cli/src/slash-commands/shadow.ts` — not heavily used, but it has real configuration state

---

### 🟠 MEDIUM PRIORITY (Text works, menu is nice to have)

#### 6. `/doctor` — Diagnostics
- **Current:** Automatic diagnostic report
- **Menu potential:** ⭐⭐⭐
- **Proposal:** `DoctorPanel` — progress indicator + category-based health checks (config, providers, network, permissions)
- **Note:** Most users may still prefer text output

#### 7. `/dev` — Developer Utilities
- **Current:** Mixed text output
- **Menu potential:** ⭐⭐⭐
- **Proposal:** `DevPanel` — action list (repl, test, typecheck, build, lint)
- **Note:** `packages/cli/src/slash-commands/dev.ts` — rarely used

#### 8. `/coordinator` — Coordinator Control
- **Current:** Text start/stop/status/tasks/claim
- **Menu potential:** ⭐⭐⭐
- **Proposal:** `CoordinatorPanel` — goal input, task queue, progress bars
- **Note:** There is already coordinator state and callbacks, so it is close to being panel-ready

#### 9. `/memory` — Memory Management
- **Current:** Text list + search + forget
- **Menu potential:** ⭐⭐
- **Proposal:** `MemoryPanel` — searchable memory list, tag filter, delete
- **Note:** Low-traffic feature

#### 10. `/telegram-settings` — Telegram Config
- **Current:** Text config view/edit
- **Menu potential:** ⭐⭐
- **Proposal:** Could be integrated into SettingsPicker as a "Telegram" section

---

### 🟢 LOW PRIORITY (Current text output is enough; menu is unnecessary)

| Command | Reason |
|-------|-------|
| `/help` | The slash menu already has a categorized list |
| `/yolo` | Single toggle, already present in SettingsPicker |
| `/next` | List + select; current form is enough |
| `/suggest` | Same as `/next` |
| `/setmodel` | ModelPicker already exists |
| `/collab` | Special workflow; text report is enough |
| `/fix` | Error input → diagnosis; text output is the right format |
| `/clear` | Single action, menu would be pointless |
| `/interrupt` | Single action |
| `/compact` | Single action |
| `/context` | Already present in SettingsPicker |
| `/enhance` | Already present in SettingsPicker |
| `/hq` | Rarely used; text is enough |
| `/mailbox` | Debug tool; text is enough |
| `/project` | CLI subcommand; text CRUD is enough |
| `/security` | Specialized scanner; text report |
| `/review` | Text report |
| `/sdd` | SDDBoardOverlay already exists |
| `/worktree` | WorktreePanel already exists |
| `/delegate` | Managed through Fleet |
| `/supervisor` | Managed through Fleet |

---

## 3. Implementation Cost Estimate

| Panel | Estimated Time | New File | Changed Files |
|-------|-------------|------------|---------------|
| `McpPicker` | 3-4 hours | `mcp-picker.tsx` | app-state, app-reducer, app.tsx, on-panel-open, mcp.ts |
| `ToolsPicker` | 3-4 hours | `tools-picker.tsx` | app-state, app-reducer, app.tsx, on-panel-open, tools.ts |
| `BrainPanel` | 4-5 hours | `brain-panel.tsx` | app-state, app-reducer, app.tsx, on-panel-open, brain.ts |
| `CoordinatorPanel` | 4-5 hours | `coordinator-panel.tsx` | app-state, app-reducer, app.tsx, on-panel-open, coordinator.ts |
| `DevPanel` | 2 hours | `dev-panel.tsx` | app-state, app-reducer, app.tsx, on-panel-open, dev.ts |
| `ShadowPanel` | 2 hours | `shadow-panel.tsx` | app-state, app-reducer, app.tsx, on-panel-open, shadow.ts |

---

## 4. Recommended Order

```
──────────────────────────────────────────────────────
 1. /mcp   (McpPicker) — Highest interaction
 2. /tools (ToolsPicker) — SettingsPicker-like UI
 ─────────────────────────────────────────────────────
 3. /brain (BrainPanel) — Visual risk scale
 4. /fleet (extended)  — Add toolbar to existing panel
 ─────────────────────────────────────────────────────
 5. /shadow (ShadowPanel) — Config panel
 6. /coordinator (CoordinatorPanel) — Task queue visualization
 7. /memory (MemoryPanel) — Searchable memory list
──────────────────────────────────────────────────────
```

**First target:** `/mcp` and `/tools`, because:
- The current text CRUD interfaces are the most interactive commands
- Existing `PluginPicker` / `SettingsPicker` components can be used as references
- The `onPanelOpen` bridge mechanism is ready (only a new action string needs to be added)
- Both commands already have `opts` callbacks in their slash command implementations

---

## 5. Architectural Notes

### Existing Panel/Picker Pattern (Template to Copy)

```typescript
// app-state.ts — state shape
toolsPicker: {
  open: boolean;
  items: ToolPickerItem[];
  selected: number;
  filter?: string;
  lastField?: number;  // SettingsPicker mirror
};

// Action types
| { type: 'toolsPickerOpen'; items: ToolPickerItem[] }
| { type: 'toolsPickerClose' }
| { type: 'toolsPickerMove'; delta: number }
| { type: 'toolsPickerToggle'; name: string }

// on-panel-open.ts
case 'toolsPickerOpen':
  dispatch({ type: 'toolsPickerOpen', items: await loadItems() });
  return true;

// slash-command.ts
if (opts.onPanelOpen?.current) {
  opts.onPanelOpen.current('toolsPickerOpen');
  return { message: '' };
}

// app.tsx — render
{state.toolsPicker.open && <ToolsPicker ... />}
```

### Key Points
- The 37-field `SettingsPicker` in **settings-picker.tsx** is the most complex example: fuzzy search (fzf-like), ←/→ cycle, Ctrl+Letter jump chords
- **plugin-picker.tsx** is the best reference for a toggle list
- **mode-picker.tsx** is the simplest example (3 actions, 3 reducer cases)
- `use-picker-keys.ts` provides the ↑↓/Enter/Esc handler shared by all pickers
