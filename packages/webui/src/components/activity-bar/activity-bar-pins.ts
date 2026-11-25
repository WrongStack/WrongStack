/**
 * Pin model for the activity bar.
 *
 * The rail is a narrow vertical column: only so many icons fit before the
 * rest has to move into the "…" overflow menu. `ACTIVITY_BAR_MAX_ICONS` is
 * the single source of truth for that budget — the customize dialog, the
 * render path and the capacity math all read it, so "how many icons fit on
 * the left menu" is never a guess.
 *
 * The customize dialog edits a *draft* (a pure data structure) and writes it
 * to the persisted store on save. The rail renders from the stored pin
 * selection, so a save is reflected on the bar immediately.
 */

import type { Activity, ActivityBarOrder, View } from '@/stores/ui-store-types';
import { ACTIVITY_BAR_FIXED_PANEL_IDS, ACTIVITY_BAR_MAX_ICONS } from '@/stores/ui-store-types';
import {
  applyLockedAnchors,
  CALM_BAR_VIEW_COUNT,
  moveItemId,
  PANELS,
  resolveActivityOrder,
  VIEWS,
} from './activity-bar-items.js';

export { ACTIVITY_BAR_FIXED_PANEL_IDS, ACTIVITY_BAR_MAX_ICONS };

export type PinGroup = 'panels' | 'views';

const PANEL_IDS: ReadonlySet<string> = new Set(PANELS.map((panel) => panel.id));
const VIEW_IDS: ReadonlySet<string> = new Set(VIEWS.map((view) => view.id));
const FIXED_PANEL_IDS_SET: ReadonlySet<string> = new Set(ACTIVITY_BAR_FIXED_PANEL_IDS);

/** The editable state of the customize dialog. */
export interface PinDraft {
  /** Full order of every panel id (pinned + unpinned). */
  panels: string[];
  /** Full order of every view id (pinned + unpinned). */
  views: string[];
  /** Ids the user pinned, per group. */
  pinnedPanels: string[];
  pinnedViews: string[];
}

/** Ids that can never be unpinned. */
export function isFixedPanelId(id: string): boolean {
  return (ACTIVITY_BAR_FIXED_PANEL_IDS as readonly string[]).includes(id);
}

/**
 * The icons the rail shows when the user has not pinned anything yet.
 * `calm` keeps the compact default (the first four views); `full` fills the
 * icon budget with the highest-priority views.
 */
export function defaultPinnedIds(chromeLevel: 'calm' | 'full'): {
  panels: string[];
  views: string[];
} {
  const panels = PANELS.map((panel) => panel.id);
  const budget = Math.max(0, ACTIVITY_BAR_MAX_ICONS - panels.length);
  const views = VIEWS.slice(0, chromeLevel === 'calm' ? CALM_BAR_VIEW_COUNT : budget).map(
    (view) => view.id,
  );
  return { panels, views };
}

/**
 * Build a draft from the persisted order. The full order (pinned + unpinned)
 * comes from the stored order; the pin membership comes from the stored
 * selection, falling back to the default set.
 */
export function createPinDraft(
  order: ActivityBarOrder | null,
  seed: { panels: string[]; views: string[] },
): PinDraft {
  const panelOrder = applyLockedAnchors(PANELS, order?.panels, FIXED_PANEL_IDS_SET).map(
    (panel) => panel.id,
  );
  const viewOrder = resolveActivityOrder(VIEWS, order?.views).map((view) => view.id);
  const pinnedPanels = Array.from(
    new Set([...ACTIVITY_BAR_FIXED_PANEL_IDS, ...seed.panels.filter((id) => PANEL_IDS.has(id))]),
  ).slice(0, ACTIVITY_BAR_MAX_ICONS);
  const viewBudget = Math.max(0, ACTIVITY_BAR_MAX_ICONS - pinnedPanels.length);
  const pinnedViews = Array.from(new Set(seed.views.filter((id) => VIEW_IDS.has(id)))).slice(
    0,
    viewBudget,
  );
  return {
    panels: panelOrder,
    views: viewOrder,
    pinnedPanels,
    pinnedViews,
  };
}

/** Pinned ids in rail order (taken from the full order). */
export function pinnedOrder(draft: PinDraft, group: PinGroup): string[] {
  const order = group === 'panels' ? draft.panels : draft.views;
  const pinned = new Set(group === 'panels' ? draft.pinnedPanels : draft.pinnedViews);
  return order.filter((id) => pinned.has(id));
}

/** Unpinned ids in rail order. */
export function unpinnedOrder(draft: PinDraft, group: PinGroup): string[] {
  const order = group === 'panels' ? draft.panels : draft.views;
  const pinned = new Set(group === 'panels' ? draft.pinnedPanels : draft.pinnedViews);
  return order.filter((id) => !pinned.has(id));
}

/** How many icons the draft puts on the rail. */
export function pinnedCount(draft: PinDraft): number {
  return draft.pinnedPanels.length + draft.pinnedViews.length;
}

/** True when the draft already fills the icon budget. */
export function isAtBudget(draft: PinDraft): boolean {
  return pinnedCount(draft) >= ACTIVITY_BAR_MAX_ICONS;
}

/**
 * Pin or unpin an id. Fixed panels are never unpinned; pinning is refused
 * once the icon budget is full.
 */
export function togglePin(draft: PinDraft, group: PinGroup, id: string): PinDraft {
  if (group === 'panels') {
    if (!PANEL_IDS.has(id) || isFixedPanelId(id)) return draft;
    if (draft.pinnedPanels.includes(id)) {
      return { ...draft, pinnedPanels: draft.pinnedPanels.filter((entry) => entry !== id) };
    }
    if (isAtBudget(draft)) return draft;
    return { ...draft, pinnedPanels: [...draft.pinnedPanels, id] };
  }
  if (!VIEW_IDS.has(id)) return draft;
  if (draft.pinnedViews.includes(id)) {
    return { ...draft, pinnedViews: draft.pinnedViews.filter((entry) => entry !== id) };
  }
  if (isAtBudget(draft)) return draft;
  return { ...draft, pinnedViews: [...draft.pinnedViews, id] };
}

/**
 * Move a pinned id one slot up (-1) or down (+1) inside the pinned list. The
 * unpinned ids keep their relative order — only the pinned ones swap.
 */
export function movePinned(
  draft: PinDraft,
  group: PinGroup,
  id: string,
  direction: -1 | 1,
): PinDraft {
  const order = group === 'panels' ? draft.panels : draft.views;
  const pinned = pinnedOrder(draft, group);
  const index = pinned.indexOf(id);
  const neighbor = pinned[index + direction];
  if (index < 0 || neighbor === undefined) return draft;
  if (group === 'panels' && (isFixedPanelId(id) || isFixedPanelId(neighbor))) return draft;
  const next = moveItemId(order, id, neighbor);
  if (next === order) return draft;
  return group === 'panels' ? { ...draft, panels: next } : { ...draft, views: next };
}

/** The store payload the draft saves to. */
export function draftToOrder(draft: PinDraft): ActivityBarOrder {
  return {
    panels: draft.panels.filter((id): id is Activity => PANEL_IDS.has(id)),
    views: draft.views.filter((id): id is View => VIEW_IDS.has(id)),
    pinned: {
      panels: draft.pinnedPanels.filter((id): id is Activity => PANEL_IDS.has(id)),
      views: draft.pinnedViews.filter((id): id is View => VIEW_IDS.has(id)),
    },
  };
}
