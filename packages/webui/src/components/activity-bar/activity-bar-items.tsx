import {
  Bot,
  Boxes,
  BrainCircuit,
  ChartNoAxesCombined,
  Columns3,
  FlaskConical,
  FolderOpen,
  Gauge,
  GitCompare,
  GitFork,
  GitPullRequest,
  Mail,
  MessageSquare,
  Network,
  PackageOpen,
  Palette,
  Rocket,
  ShieldAlert,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import type { MainView } from '@/lib/view-navigation';
import type { Activity } from '@/stores';

// ── Activity definitions ───────────────────────────────────────────────
//
// Two icon groups with two distinct behaviours:
//  - TOP icons each own one side-panel (open / switch / close-on-reclick)
//    and always steer the matching main surface.
//  - BOTTOM icons toggle a standalone main view (Phases, Flow, Settings)
//    and collapse the side-panel so stale secondary content does not linger.

export interface PanelDef {
  id: Activity;
  icon: ReactElement;
  label: string;
}

export interface ViewDef {
  id: MainView;
  icon: ReactElement;
  label: string;
}

export const PANELS: PanelDef[] = [
  { id: 'chat', icon: <MessageSquare size={16} />, label: 'Session' },
  { id: 'files', icon: <FolderOpen size={16} />, label: 'Files' },
  { id: 'changes', icon: <GitCompare size={16} />, label: 'Changes' },
  { id: 'mailbox', icon: <Mail size={16} />, label: 'Mailbox' },
  { id: 'skills', icon: <Sparkles size={16} />, label: 'Skills' },
  { id: 'design', icon: <Palette size={16} />, label: 'Design Studio' },
];

// Worktree lanes and the Fleet/Office Map moved out of the bar: worktrees is
// a tab inside the Changes panel (Ctrl+Shift+W still lands there), the map is
// the 'officemap' tab of the Agent Roster view (F11). Settings lives in the
// "…" utilities menu (Ctrl+9 / palette unchanged) — its standalone icon was
// redundant with that menu's full Settings section.
// Default views prioritize daily work: agents, goals, tasks, and memory,
// then specification and project tools. Diagnostics come last.
// Prompt Journal lives beside the chat input.
// Order also decides what stays visible on short viewports — the first N
// views keep their slot, the rest fall into the "…" overflow menu.
export const VIEWS: ViewDef[] = [
  { id: 'roster', icon: <Bot size={16} />, label: 'Agent Roster' },
  { id: 'goal', icon: <Rocket size={16} />, label: 'Goal' },
  { id: 'kanban', icon: <Columns3 size={16} />, label: 'Kanban' },
  { id: 'memory', icon: <BrainCircuit size={16} />, label: 'Memory' },
  { id: 'sddhub', icon: <Wand2 size={16} />, label: 'SDD' },
  { id: 'project-kit', icon: <PackageOpen size={16} />, label: 'Project Kit' },
  { id: 'automation', icon: <Rocket size={16} />, label: 'Automations' },
  { id: 'codemap', icon: <Network size={16} />, label: 'CodeMap' },
  { id: 'history', icon: <GitFork size={16} />, label: 'Repository History' },
  { id: 'github', icon: <GitPullRequest size={16} />, label: 'GitHub' },
  { id: 'chronicle', icon: <ChartNoAxesCombined size={16} />, label: 'Chronicle' },
  { id: 'chimera', icon: <ShieldAlert size={16} />, label: 'Chimera Reviews' },
  { id: 'techstack', icon: <Boxes size={16} />, label: 'TechStack' },
  { id: 'provider-test', icon: <FlaskConical size={16} />, label: 'Provider Test' },
  { id: 'provider-quota', icon: <Gauge size={16} />, label: 'Plan Quota' },
];

export const DESKTOP_CORE_PANEL_IDS: readonly Activity[] = ['chat', 'files', 'changes', 'mailbox'];

/**
 * How many main views the compact (calm) rail keeps when the user has not
 * pinned any icons explicitly. The Tools launcher carries the rest.
 */
export const CALM_BAR_VIEW_COUNT = 4;

export const DESKTOP_PANEL_PRIORITY: readonly Activity[] = [
  ...DESKTOP_CORE_PANEL_IDS,
  'skills',
  'design',
];

// h-11 icons, taller brand area with project name.
export const FULL_RESERVED_PX = 165;

export const FULL_SLOT_PX = 46;

export function calculateDesktopActivityCapacity(viewportHeight: number): number {
  const max = PANELS.length + VIEWS.length;
  const height = Number.isFinite(viewportHeight) ? viewportHeight : 720;
  const slots = Math.floor((height - FULL_RESERVED_PX) / FULL_SLOT_PX);
  return Math.max(DESKTOP_CORE_PANEL_IDS.length, Math.min(max, slots));
}

export function splitDesktopActivityBarItems(
  capacity: number,
  orderedPanels: readonly PanelDef[] = PANELS,
  orderedViews: readonly ViewDef[] = VIEWS,
): {
  visiblePanelIds: Activity[];
  overflowPanelIds: Activity[];
  visibleViewIds: MainView[];
  overflowViewIds: MainView[];
} {
  const max = orderedPanels.length + orderedViews.length;
  const slots = Math.max(DESKTOP_CORE_PANEL_IDS.length, Math.min(max, Math.floor(capacity)));
  const visiblePanelCount = Math.min(orderedPanels.length, slots);
  // Visibility membership is *priority-based* (core panels always visible on
  // short viewports) so locked anchors cannot be displaced; only the *order*
  // of the returned ids follows the effective list passed in.
  const visiblePanelSet = new Set(DESKTOP_PANEL_PRIORITY.slice(0, visiblePanelCount));
  const visiblePanelIds = orderedPanels
    .map((def) => def.id)
    .filter((id) => visiblePanelSet.has(id));
  const overflowPanelIds = orderedPanels
    .map((def) => def.id)
    .filter((id) => !visiblePanelSet.has(id));
  const visibleViewCount = Math.max(0, slots - visiblePanelIds.length);
  // Views: first N of the effective (possibly user-customized) order — so a
  // user-prioritized view stays visible on short viewports.
  const visibleViewIds = orderedViews.slice(0, visibleViewCount).map((def) => def.id);
  const visibleViewSet = new Set(visibleViewIds);
  const overflowViewIds = orderedViews.map((def) => def.id).filter((id) => !visibleViewSet.has(id));
  return { visiblePanelIds, overflowPanelIds, visibleViewIds, overflowViewIds };
}

// ── User-customized order (drag & drop) ────────────────────────────────
//
// Only a few icons stay fixed ("yerleri sabitlemesek bir kaçı hariç"): the
// core workflow panels that the responsive split guarantees visible on
// short viewports and that have keyboard shortcuts 1-4. Everything else
// (skills/design + all main views) is reorderable via the edit-mode drag.
//
// Locked items are anchors: they keep their default indices, and the
// reorderable items fill the remaining slots in the user's order. Drop
// targets on locked items are ignored.

/** Reorder `defaults` to follow `custom` (ids), dropping unknown entries and
 *  appending anything from `defaults` that `custom` omitted. New icons
 *  added to `defaults` after the user saved their order automatically
 *  appear at the end. */
export function resolveActivityOrder<T extends { id: string }>(
  defaults: readonly T[],
  custom: readonly string[] | null | undefined,
): T[] {
  if (!custom || custom.length === 0) return defaults as T[];
  const byId = new Map(defaults.map((def) => [def.id, def] as const));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of custom) {
    const def = byId.get(id);
    if (def && !seen.has(id)) {
      out.push(def);
      seen.add(id);
    }
  }
  for (const def of defaults) {
    if (!seen.has(def.id)) out.push(def);
  }
  return out;
}

/** Render `defaults` with the items listed in `locked` occupying their
 *  original indices, and the rest of the items filled in the custom order
 *  (filtering out unknown ids, deduping). Locked anchors cannot move. */
export function applyLockedAnchors<T extends { id: string }>(
  defaults: readonly T[],
  custom: readonly string[] | null | undefined,
  locked: ReadonlySet<string>,
): T[] {
  const movable = resolveActivityOrder(
    defaults.filter((def) => !locked.has(def.id)),
    custom ? custom.filter((id) => !locked.has(id)) : undefined,
  );
  const out: T[] = [];
  let mi = 0;
  for (const def of defaults) {
    if (locked.has(def.id)) {
      out.push(def);
    } else if (mi < movable.length) {
      out.push(movable[mi++]!);
    }
  }
  return out;
}

/** Move `fromId` to the position currently held by `toId`. Returns the
 *  original ids when either id is missing. */
export function moveItemId<T extends string>(ids: readonly T[], fromId: string, toId: string): T[] {
  if (fromId === toId) return ids as T[];
  const from = (ids as readonly string[]).indexOf(fromId);
  const to = (ids as readonly string[]).indexOf(toId);
  if (from === -1 || to === -1) return ids as T[];
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

// ── Component ──────────────────────────────────────────────────────────

export function readViewportHeight(): number {
  if (typeof window === 'undefined') return 720;
  return window.visualViewport?.height ?? window.innerHeight;
}

export function useDesktopActivityCapacity(): number {
  const [height, setHeight] = useState(readViewportHeight);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setHeight(readViewportHeight());
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);
  return calculateDesktopActivityCapacity(height);
}
