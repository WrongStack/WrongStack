import type { AgentTimelineEntry } from '@wrongstack/core/coordination';
import type { StatuslineItem as StatuslineItemSource } from './components/statusline-picker.js';

/**
 * Maximum mission-queue rows rendered in the right sidebar. Shared contract:
 * SidebarContent (components/sidebar-content.tsx) caps the rendered rows at
 * this value, and computeMaxSidebarScroll (reducers/workspace-panels.ts)
 * reserves this many rows in the ↑↓ scroll clamp. Keeping both on this single
 * constant prevents the clamp from silently drifting out of sync with the
 * rendered layout.
 */
export const SIDEBAR_MISSION_ROWS = 8;

/**
 * Minimum inner-content width (cols) at which a routed F-panel sidebar twin
 * renders its `⟦ … ⟧` status pill on the title row's right edge. Below this
 * threshold the pill is bumped to a second status row so the title (and the
 * right-side state) can both fit without truncation. Centralized here so the
 * workspace/task sidebar twins and the SidebarPanelFrame don't drift.
 */
export const PILL_MIN_INNER_WIDTH = 22;

/**
 * Minimum inner-content width (cols) at which a routed F-panel sidebar twin
 * starts rendering per-row "metric" columns (latency, diff, elapsed, agent
 * count, relative time). Below this threshold the row keeps its identity
 * label only; the secondary metric is dropped to preserve the title.
 * Centralized so the F twins in `sidebar-panels-workspace.tsx` and
 * `sidebar-panels-task.tsx` stop hand-rolling the literal `24`.
 */
export const METRIC_MIN_BODY_WIDTH = 24;

/**
 * Maximum outer height of the /settings picker, including its border. Small
 * terminals still use their smaller available-height budget; large terminals
 * stop growing here instead of allowing the picker to fill the screen.
 */
export const SETTINGS_PICKER_MAX_HEIGHT = 24;

/**
 * Field index where the per-panel-position rows begin. The first 46
 * indices (0–45) are the legacy auto-rebuilt Settings surface; rows 46+
 * are the per-panel position rows (one per PanelId in PANEL_IDS order).
 * Centralized so the reducer, label array, sections, and tests stay in
 * lock-step when a new panel id is added.
 */
export const PANEL_POSITION_FIELD_START = 46;

/**
 * Maximum number of sidebar panel slots. When more than this many panels
 * are set to 'sidebar', the sidebar renders the first N in `PANEL_IDS` order
 * and surfaces a "+N more" hint rather than overflowing the viewport.
 */
export const SIDEBAR_PANEL_LIMIT = 6;

/**
 * Maximum rows reserved for one wrapped routed-panel worklist label at the
 * minimum 16-column content width. The right-sidebar scroll clamp in
 * `reducers/workspace-panels.ts#computeMaxSidebarScroll` multiplies this by
 * the per-panel item count when sizing its `sidebarTwinRowCount` reservation,
 * so it must move in lockstep with `SIDEBAR_TWIN_HEIGHT_BY_PANEL` in
 * `app-ui-state.ts` (which also multiplies by `SIDEBAR_TWIN_MAX_WRAP_LINES`).
 * Keep this value width-blind on purpose — over-estimation is safe because
 * `RightSidebar` still owns viewport clipping.
 */
export const SIDEBAR_TWIN_MAX_WRAP_LINES = 10;

/** Where to render a given F-key panel: lower region (F-key) or right sidebar. */
export type PanelPosition = 'bottom' | 'sidebar';

/**
 * Canonical identifiers for every F-key panel tracked in the position map.
 * Each entry corresponds to one row in the Settings picker and one row in
 * the right sidebar when set to 'sidebar'. Order matters — it determines
 * the render order of sidebar panels top-to-bottom.
 *
 * NOTE: this is a closed set. When a new F-key panel is added, register it
 * here AND in `DEFAULT_PANEL_POSITIONS`, the Settings picker, and the
 * `app-view.tsx` sidebar renderer.
 */
export const PANEL_IDS = Object.freeze([
  'projectPicker', // F1
  'fleet', // F2
  'agents', // F3
  'worktree', // F4
  'plan', // F5
  'todos', // F6
  'queue', // F7
  'processList', // F8
  'goal', // F9
  'sessions', // F10
  'coordinator', // F11
  'kanban', // F12
  'connections', // Ctrl+N
] as const);

export type PanelId = (typeof PANEL_IDS)[number];

/** Total field count = legacy 46 + per-panel positions + the two
 *  WrongProxy / WrongTrace fields (master switch + URL). Derived at
 *  runtime from `PANEL_IDS.length` + 2 to keep the surface in sync. */
export const TOTAL_SETTINGS_FIELD_COUNT =
  PANEL_POSITION_FIELD_START + PANEL_IDS.length + 2;

/** Map of every tracked panel → its current placement. */
export type PanelPositionMap = Readonly<Record<PanelId, PanelPosition>>;

/** Default placement for every panel — all 'bottom' (i.e. F-key behavior). */
export const DEFAULT_PANEL_POSITIONS: PanelPositionMap = Object.freeze({
  projectPicker: 'bottom',
  fleet: 'bottom',
  agents: 'bottom',
  worktree: 'bottom',
  plan: 'bottom',
  todos: 'bottom',
  queue: 'bottom',
  processList: 'bottom',
  goal: 'bottom',
  sessions: 'bottom',
  coordinator: 'bottom',
  kanban: 'bottom',
  connections: 'bottom',
} as const);

/**
 * Coerce a persisted per-panel position map (or partial) into a valid
 * PanelPositionMap. Unknown panel ids are dropped; missing panels fall
 * back to {@link DEFAULT_PANEL_POSITIONS}. Invalid position values
 * default to 'bottom'.
 *
 * This is the single canonical coercion — all read sites should call this
 * rather than re-implementing the mapping to avoid divergent defaults.
 */
export function coercePanelPositionMap(
  v: Partial<Record<PanelId, PanelPosition>> | undefined,
): PanelPositionMap {
  const out: Record<PanelId, PanelPosition> = { ...DEFAULT_PANEL_POSITIONS };
  if (!v) return out;
  for (const key of PANEL_IDS) {
    const value = v[key];
    if (value === 'bottom' || value === 'sidebar') out[key] = value;
  }
  return out;
}

export interface AgentTranscriptReader {
  getTranscript(subagentId: string, limit?: number): AgentTimelineEntry[];
}

export interface AutonomyOption {
  mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  label: string;
  description: string;
  color: string;
}

export interface ProviderOption {
  id: string;
  family: string;
  models: string[];
  modelsLabel?: string | undefined;
}

export type RefineFailureDecision =
  | { kind: 'retry' }
  | { kind: 'fallback' }
  | { kind: 'pick'; providerId: string; model: string }
  | { kind: 'original' }
  | { kind: 'edit' };

export interface RefineFailureModel {
  providerId: string;
  model: string;
  label?: string | undefined;
}

export interface HelpEntry {
  name: string;
  description: string;
  category: string;
  aliases?: string[] | undefined;
  argsHint?: string | undefined;
}

export interface McpPickerItem {
  name: string;
  enabled: boolean;
  status: string;
  transport: string;
  description?: string | undefined;
  toolCount: number;
  lazy?: boolean | undefined;
}

export interface PluginPickerItem {
  name: string;
  enabled: boolean;
  risk: 'low' | 'medium' | 'high';
  summary: string;
  lockable?: boolean | undefined;
}

export interface ToolPickerItem {
  name: string;
  owner: string;
  category: string;
  enabled: boolean;
  exposure: 'direct' | 'lazy' | 'disabled';
  mutating: boolean;
  permission: string;
  descMode: 'extend' | 'simple';
  description: string;
}

export interface ShadowState {
  activeId: string | null;
  running: boolean;
  model: string;
  intervalMs: number;
}

export interface ProjectPickerItem {
  key: string;
  label: string;
  subtitle?: string | undefined;
  meta?: string | undefined;
  kind: 'project' | 'action';
}

export interface PromptPickEntry {
  slug: string;
  title: string;
  description: string;
  category: string;
  source: string;
  content: string;
  favorite: boolean;
}

export type ResourceMenuId =
  | 'fallback'
  | 'profile'
  | 'provider-status'
  | 'memory'
  | 'worktree'
  | 'git';

export interface ResourceMenuDetail {
  label: string;
  value: string;
}

export interface ResourceMenuAction {
  key: string;
  label: string;
  command: string;
  /** Destructive or session-changing actions require a second y/n keypress. */
  confirm?: boolean | undefined;
}

export interface ResourceMenuItem {
  id: string;
  label: string;
  status?: 'good' | 'warn' | 'bad' | 'muted' | undefined;
  summary?: string | undefined;
  details: ResourceMenuDetail[];
  body?: string | undefined;
  actions?: ResourceMenuAction[] | undefined;
}

export interface ResourceMenuSnapshot {
  id: ResourceMenuId;
  title: string;
  subtitle?: string | undefined;
  emptyText?: string | undefined;
  items: ResourceMenuItem[];
}

export type SendMode = 'queue' | 'btw' | 'steer';

export type StatuslineItem = StatuslineItemSource;

export interface ChipMeta {
  key: StatuslineItem;
  shownAt: number;
  expiresIn?: number;
}

export interface WorktreeRow {
  branch: string;
  ownerLabel: string;
  status: string;
  insertions: number;
  deletions: number;
  files: number;
  allocatedAt: number;
  conflictFiles?: string[] | undefined;
}

export interface ModeOption {
  id: string;
  name: string;
  description: string;
  family: 'lite' | 'deep' | 'balanced' | 'custom';
  isActive: boolean;
}

export interface LiveAgentEntry {
  id: string;
  name: string;
  status: string;
  currentTool?: string | undefined;
  iterations: number;
  toolCalls: number;
  lastActivityAt: string;
}

export interface LiveSessionEntry {
  sessionId: string;
  projectName: string;
  projectSlug: string;
  projectRoot?: string | undefined;
  workingDir: string;
  gitBranch?: string | undefined;
  status: string;
  pid: number;
  startedAt: string;
  agentCount: number;
  agents: LiveAgentEntry[];
}
