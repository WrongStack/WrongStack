import { MOD_KEY_LABEL } from '@/lib/platform';
import { type Activity, useUIStore, type View } from '@/stores/ui-store';

/**
 * A view that is PAIRED with an activity-bar side panel: opening the panel
 * steers the main area here, and vice versa.
 */
export type PanelMainView = 'chat' | 'files' | 'skill' | 'changes' | 'mailbox' | 'design-gallery';

/**
 * A standalone main view with its own activity-bar icon (or a slot in the "…"
 * utilities menu). Selecting one collapses the side panel.
 */
export type MainView =
  | 'goal'
  | 'kanban'
  | 'sddhub'
  | 'settings'
  | 'memory'
  | 'roster'
  | 'codemap'
  | 'techstack'
  | 'chronicle'
  | 'intake'
  | 'prompts'
  | 'chimera';

/**
 * A view with no bar affordance at all — reached from the command palette, a
 * deep link, or another view's action. Diagnostics and drill-downs live here.
 */
export type UnlistedView =
  | 'sessions'
  | 'session-inspect'
  | 'setup'
  | 'context'
  | 'debug'
  | 'refresh-debug'
  | 'analytics'
  | 'deadcode';

/**
 * Every view the app can display. Derived from `VIEWS` in the UI store rather
 * than re-declared, so the router and the navigation helpers cannot disagree.
 */
export type AppView = View;

/**
 * Compile-time proof that the three buckets above PARTITION `View`.
 *
 * `Exclude<…>` is `never` only when every entry of `VIEWS` is claimed by
 * exactly one bucket. Adding a view to the store without giving it a
 * navigation home now fails the build here instead of shipping an unreachable
 * panel — which is precisely what happened to `deadcode`.
 */
type AssertNever<T extends never> = T;
type UnroutableView = AssertNever<Exclude<View, PanelMainView | MainView | UnlistedView>>;
/** Guards the other direction: a bucket may not name a view the store lost. */
type UnknownNavigationView = AssertNever<
  Exclude<PanelMainView | MainView | UnlistedView, View>
>;

export const PANEL_VIEW_BY_ACTIVITY: Record<Activity, PanelMainView> = {
  chat: 'chat',
  agents: 'chat',
  files: 'files',
  changes: 'changes',
  mailbox: 'mailbox',
  skills: 'skill',
  design: 'design-gallery',
};

export const VIEW_ACTIVITY: Partial<Record<AppView, Activity>> = {
  chat: 'chat',
  files: 'files',
  changes: 'changes',
  mailbox: 'mailbox',
  skill: 'skills',
  'design-gallery': 'design',
};

export const ACTIVITY_SHORTCUT_BY_KEY: Readonly<Record<string, Activity>> = {
  '1': 'chat',
  '2': 'files',
  '3': 'changes',
  '4': 'mailbox',
  '5': 'skills',
  '0': 'design',
};

/**
 * Chord labels shown in activity-bar tooltips and the "…" overflow menu.
 *
 * Built from `ACTIVITY_SHORTCUT_BY_KEY` rather than re-typed, so a rebound
 * digit cannot advertise the old one, and from `MOD_KEY_LABEL` so a Mac shows
 * `⌘1` for a chord its handler already accepts via `e.metaKey`.
 * The `agents` activity has no digit and stays deliberately unlabelled.
 */
export const ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY: Readonly<Record<Activity, string>> =
  Object.entries(ACTIVITY_SHORTCUT_BY_KEY).reduce(
    (labels, [digit, activity]) => {
      labels[activity] = `${MOD_KEY_LABEL}+${digit}`;
      return labels;
    },
    {
      chat: '',
      agents: '',
      files: '',
      changes: '',
      mailbox: '',
      skills: '',
      design: '',
    } as Record<Activity, string>,
  );

export function pairedViewForActivity(activity: Activity): PanelMainView {
  return PANEL_VIEW_BY_ACTIVITY[activity] ?? 'chat';
}

export function shortcutLabelForActivity(activity: Activity): string {
  return ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY[activity] ?? '';
}

function setView(view: AppView): void {
  const ui = useUIStore.getState();
  if (ui.currentView !== view) ui.setCurrentView(view);
}

export function showPanel(activity: Activity): void {
  const ui = useUIStore.getState();
  ui.setSidebarOpen(true);
  ui.selectActivity(activity);
  setView(pairedViewForActivity(activity));
}

export function openPanel(activity: Activity): void {
  const ui = useUIStore.getState();
  if (!ui.sidebarOpen) {
    ui.setSidebarOpen(true);
    ui.selectActivity(activity);
  } else if (ui.activeActivity === activity) {
    ui.setSidebarOpen(false);
    return;
  } else if (ui.activeActivity === 'agents') {
    // Agents sidebar is open → switching to the selected activity
    ui.setSidebarOpen(true);
    ui.selectActivity(activity);
  } else {
    ui.selectActivity(activity);
  }
  setView(pairedViewForActivity(activity));
}

export function openMainView(view: MainView): void {
  const ui = useUIStore.getState();
  if (ui.currentView === view) {
    showPanel('chat');
    return;
  }
  ui.setSidebarOpen(false);
  setView(view);
}

export function navigateToView(view: AppView): void {
  const activity = VIEW_ACTIVITY[view];
  if (activity) {
    showPanel(activity);
    return;
  }
  const ui = useUIStore.getState();
  ui.setSidebarOpen(false);
  setView(view);
}
