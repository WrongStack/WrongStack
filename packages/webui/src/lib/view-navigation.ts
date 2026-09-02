import { type Activity, useUIStore } from '@/stores/ui-store';

export type PanelMainView = 'chat' | 'files' | 'skill' | 'changes' | 'mailbox' | 'design-gallery';

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

export type AppView =
  | PanelMainView
  | MainView
  | 'sessions'
  | 'session-inspect'
  | 'setup'
  | 'debug'
  | 'refresh-debug'
  | 'analytics';

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

export const ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY: Readonly<Record<Activity, string>> = {
  chat: 'Ctrl+1',
  agents: '',
  files: 'Ctrl+2',
  changes: 'Ctrl+3',
  mailbox: 'Ctrl+4',
  skills: 'Ctrl+5',
  design: 'Ctrl+0',
};

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
