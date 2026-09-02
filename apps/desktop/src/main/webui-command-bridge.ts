import type { DesktopWebuiCommand } from '../shared/types.js';

type DesktopCommandAction = NonNullable<DesktopWebuiCommand['action']>;
type DesktopCommandView = NonNullable<DesktopWebuiCommand['view']>;
type DesktopCommandActivity = NonNullable<DesktopWebuiCommand['activity']>;
type DesktopCommandOverlay = NonNullable<DesktopWebuiCommand['overlay']>;
type DesktopCommandDockSection = NonNullable<DesktopWebuiCommand['dockSection']>;
type DesktopCommandWorkTab = NonNullable<DesktopWebuiCommand['workTab']>;
type DesktopCommandPrefKey = NonNullable<DesktopWebuiCommand['pref']>['key'];

const DESKTOP_WEBUI_ACTIONS = new Set<DesktopCommandAction>([
  'new-session',
  'clear-context',
  'compact-context',
  'repair-context',
  'download-chat',
  'focus-chat',
  'open-command-palette',
  'open-shortcuts',
  'search-chat',
  'open-model-switcher',
  'open-prompt-library',
]);

const DESKTOP_WEBUI_VIEWS = new Set<DesktopCommandView>([
  'chat',
  'settings',
  'goal',
  'sddhub',
  'files',
  'changes',
  'sessions',
  'setup',
  'skill',
  'roster',
  'mailbox',
  'debug',
  'design-gallery',
  'refresh-debug',
  'analytics',
]);

const DESKTOP_WEBUI_ACTIVITIES = new Set<DesktopCommandActivity>([
  'chat',
  'agents',
  'history',
  'files',
  'changes',
  'mailbox',
  'skills',
  'design',
]);

const DESKTOP_WEBUI_OVERLAYS = new Set<DesktopCommandOverlay>([
  'fleet',
  'agents-monitor',
  'processes',
  'queue',
]);

const DESKTOP_WEBUI_DOCKS = new Set<DesktopCommandDockSection>([
  'goal',
  'fleet',
  'work',
  'worktrees',
  'collab',
]);

const DESKTOP_WEBUI_WORK_TABS = new Set<DesktopCommandWorkTab>(['todos', 'tasks', 'plan']);
const DESKTOP_WEBUI_PREF_KEYS = new Set<DesktopCommandPrefKey>([
  'yolo',
  'nextPrediction',
  'contextAutoCompact',
]);

export function normalizeDesktopWebuiCommand(value: unknown): DesktopWebuiCommand | null {
  if (!isRecord(value)) return null;
  const command: DesktopWebuiCommand = {};
  let hasCommand = false;

  const action = value['action'];
  if (action !== undefined) {
    if (typeof action !== 'string' || !DESKTOP_WEBUI_ACTIONS.has(action as DesktopCommandAction)) {
      return null;
    }
    command.action = action as DesktopCommandAction;
    hasCommand = true;
  }

  const view = value['view'];
  if (view !== undefined) {
    if (typeof view !== 'string' || !DESKTOP_WEBUI_VIEWS.has(view as DesktopCommandView)) {
      return null;
    }
    command.view = view as DesktopCommandView;
    hasCommand = true;
  }

  const activity = value['activity'];
  if (activity !== undefined) {
    if (
      typeof activity !== 'string' ||
      !DESKTOP_WEBUI_ACTIVITIES.has(activity as DesktopCommandActivity)
    ) {
      return null;
    }
    command.activity = activity as DesktopCommandActivity;
    hasCommand = true;
  }

  const overlay = value['overlay'];
  if (overlay !== undefined) {
    if (
      typeof overlay !== 'string' ||
      !DESKTOP_WEBUI_OVERLAYS.has(overlay as DesktopCommandOverlay)
    ) {
      return null;
    }
    command.overlay = overlay as DesktopCommandOverlay;
    hasCommand = true;
  }

  const dockSection = value['dockSection'];
  if (dockSection !== undefined) {
    if (
      typeof dockSection !== 'string' ||
      !DESKTOP_WEBUI_DOCKS.has(dockSection as DesktopCommandDockSection)
    ) {
      return null;
    }
    command.dockSection = dockSection as DesktopCommandDockSection;
    hasCommand = true;
  }

  const workTab = value['workTab'];
  if (workTab !== undefined) {
    if (
      typeof workTab !== 'string' ||
      !DESKTOP_WEBUI_WORK_TABS.has(workTab as DesktopCommandWorkTab)
    ) {
      return null;
    }
    command.workTab = workTab as DesktopCommandWorkTab;
    hasCommand = true;
  }

  const terminal = value['terminal'];
  if (terminal !== undefined) {
    if (terminal !== true && terminal !== false && terminal !== 'toggle' && terminal !== 'new') {
      return null;
    }
    command.terminal = terminal;
    hasCommand = true;
  }

  const pref = value['pref'];
  if (pref !== undefined) {
    if (!isRecord(pref)) return null;
    const key = pref['key'];
    if (typeof key !== 'string' || !DESKTOP_WEBUI_PREF_KEYS.has(key as DesktopCommandPrefKey)) {
      return null;
    }
    const toggle = pref['toggle'];
    const prefValue = pref['value'];
    if (toggle !== undefined && typeof toggle !== 'boolean') return null;
    if (prefValue !== undefined && typeof prefValue !== 'boolean') return null;
    if (toggle === undefined && prefValue === undefined) return null;
    command.pref = {
      key: key as DesktopCommandPrefKey,
      ...(typeof prefValue === 'boolean' ? { value: prefValue } : {}),
      ...(typeof toggle === 'boolean' ? { toggle } : {}),
    };
    hasCommand = true;
  }

  return hasCommand ? command : null;
}

export function buildWebuiCommandFallbackScript(command: DesktopWebuiCommand): string {
  const payload = JSON.stringify(command).replace(/</g, '\\u003c');
  return `window.dispatchEvent(new CustomEvent('wrongstack:desktop-command', { detail: ${payload} })); true;`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
