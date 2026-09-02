/**
 * Menu sections builder.
 * Each function builds a specific menu section.
 */
import type { MenuItemConstructorOptions } from 'electron';
import type {
  DesktopRuntimeRecord,
  DesktopWebuiCommand,
  DesktopWebuiPrefs,
} from '../../shared/types.js';
import type { MenuBuilderContext } from './types.js';

/**
 * Build File menu section.
 */
export function buildFileMenu(
  ctx: MenuBuilderContext,
  _actions: unknown,
  hasActiveRuntime: boolean,
  hasActiveProjectWebui: boolean,
  active: DesktopRuntimeRecord | undefined,
  navigate: (command: DesktopWebuiCommand) => void,
  getActiveRuntimeId: () => string | null,
): MenuItemConstructorOptions {
  return {
    label: ctx.t('file'),
    submenu: [
      {
        label: ctx.t('openProjectEllipsis'),
        accelerator: 'CmdOrCtrl+O',
        click: () => void ctx.openProject(),
      },
      { label: ctx.t('registerProjectEllipsis'), click: () => void ctx.registerProject() },
      {
        label: ctx.t('removeActiveFromRegistry'),
        enabled: hasActiveProjectWebui,
        click: () => {
          if (active?.kind === 'project') void ctx.unregisterProject(active.root);
        },
      },
      { type: 'separator' },
      {
        label: ctx.t('newSessionForActive'),
        accelerator: 'CmdOrCtrl+N',
        enabled: hasActiveProjectWebui,
        click: () => void ctx.openProjectSession(active?.id),
      },
      {
        label: ctx.t('settings'),
        accelerator: 'CmdOrCtrl+,',
        click: () => {
          if (hasActiveRuntime) navigate({ view: 'settings' });
          else void ctx.openSettings();
        },
      },
      { type: 'separator' },
      {
        label: ctx.t('closeActiveRuntime'),
        accelerator: 'CmdOrCtrl+W',
        enabled: hasActiveRuntime,
        click: () => {
          const id = getActiveRuntimeId();
          if (id) void ctx.closeRuntime(id);
        },
      },
      { type: 'separator' },
      {
        role: process.platform === 'darwin' ? 'close' : 'quit',
      },
    ],
  };
}

/**
 * Build Workspace menu section.
 */
export function buildWorkspaceMenu(
  ctx: MenuBuilderContext,
  _actions: unknown,
  hasActiveWebui: boolean,
  prefs: DesktopWebuiPrefs | undefined,
  navigate: (command: DesktopWebuiCommand) => void,
): MenuItemConstructorOptions {
  const yoloChecked = prefs?.yolo === true;
  const nextPredictionChecked = prefs?.nextPrediction === true;
  const contextAutoCompactChecked = prefs?.contextAutoCompact === true;

  const webuiItem = (item: MenuItemConstructorOptions): MenuItemConstructorOptions => ({
    ...item,
    enabled: item.enabled ?? hasActiveWebui,
  });

  return {
    label: ctx.t('workspace'),
    submenu: [
      webuiItem({
        label: ctx.t('openChat'),
        accelerator: 'CmdOrCtrl+1',
        click: () => navigate({ activity: 'chat', view: 'chat' }),
      }),
      webuiItem({
        label: ctx.t('focusPrompt'),
        accelerator: 'CmdOrCtrl+/',
        click: () => navigate({ action: 'focus-chat' }),
      }),
      webuiItem({
        label: ctx.t('toggleTerminal'),
        accelerator: 'CmdOrCtrl+`',
        click: () => navigate({ terminal: 'toggle' }),
      }),
      webuiItem({ label: ctx.t('newTerminal'), click: () => navigate({ terminal: 'new' }) }),
      { type: 'separator' },
      webuiItem({
        label: ctx.t('commandPalette'),
        accelerator: 'CmdOrCtrl+K',
        click: () => navigate({ action: 'open-command-palette' }),
      }),
      webuiItem({
        label: ctx.t('quickModelSwitcher'),
        accelerator: 'CmdOrCtrl+M',
        click: () => navigate({ action: 'open-model-switcher' }),
      }),
      webuiItem({
        type: 'checkbox',
        label: ctx.t('yoloMode'),
        checked: yoloChecked,
        accelerator: 'CmdOrCtrl+Shift+Y',
        click: () => navigate({ pref: { key: 'yolo', toggle: true } }),
      }),
      webuiItem({
        type: 'checkbox',
        label: ctx.t('nextPrediction'),
        checked: nextPredictionChecked,
        click: () => navigate({ pref: { key: 'nextPrediction', toggle: true } }),
      }),
      webuiItem({
        type: 'checkbox',
        label: ctx.t('contextAutoCompact'),
        checked: contextAutoCompactChecked,
        click: () => navigate({ pref: { key: 'contextAutoCompact', toggle: true } }),
      }),
      { type: 'separator' },
      webuiItem({
        label: ctx.t('reloadActiveWebui'),
        accelerator: 'CmdOrCtrl+Shift+R',
        click: () => void ctx.reloadActiveWebuiView(),
      }),
    ],
  };
}

/**
 * Build View menu section.
 */
export function buildViewMenu(ctx: MenuBuilderContext): MenuItemConstructorOptions {
  return {
    label: ctx.t('view'),
    submenu: [
      {
        type: 'checkbox',
        label: ctx.t('compactDesktopSidebar'),
        accelerator: 'CmdOrCtrl+B',
        checked: ctx.getShellSidebarCollapsed(),
        click: () => ctx.setShellSidebarCollapsed(!ctx.getShellSidebarCollapsed()),
      },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
}
