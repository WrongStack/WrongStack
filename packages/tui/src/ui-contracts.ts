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

/** Total field count = legacy 46 + per-panel positions. Derived at
 *  runtime from `PANEL_IDS.length` to keep the surface in sync. */
export const TOTAL_SETTINGS_FIELD_COUNT = PANEL_POSITION_FIELD_START + PANEL_IDS.length;

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
