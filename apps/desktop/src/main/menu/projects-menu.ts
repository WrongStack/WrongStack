/**
 * Projects menu builder.
 */
import path from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopRuntimeRecord } from '../../shared/types.js';
import type { ProjectMenuActions, ProjectMenuGroup } from './types.js';

export function buildProjectsMenu(
  runtimes: DesktopRuntimeRecord[],
  actions: ProjectMenuActions,
  t: (key: string) => string,
): MenuItemConstructorOptions[] {
  const projectGroups = groupProjectRuntimesForMenu(runtimes);
  const menu: MenuItemConstructorOptions[] = [
    {
      label: t('openProjectEllipsis'),
      accelerator: 'CmdOrCtrl+O',
      click: () => actions.newSession(''),
    },
    {
      label: t('registerProjectEllipsis'),
      click: () => actions.registerProject?.(),
    },
    { type: 'separator' },
  ];

  if (projectGroups.length === 0) {
    menu.push({ label: t('noOpenProjectSessions'), enabled: false });
    return menu;
  }

  for (const group of projectGroups) {
    menu.push({
      label: group.name,
      submenu: [
        {
          label: t('newSession'),
          click: () => actions.newSession(group.sessions[0]?.id ?? ''),
          enabled: Boolean(group.sessions[0]),
        },
        {
          label: t('revealProjectFolder'),
          click: () => actions.reveal(group.sessions[0]?.id ?? ''),
          enabled: Boolean(group.sessions[0]),
        },
        { type: 'separator' },
        ...group.sessions.map((runtime, index) => buildSessionMenu(runtime, index + 1, actions, t)),
      ],
    });
  }
  return menu;
}

export function buildSessionMenu(
  runtime: DesktopRuntimeRecord,
  index: number,
  actions: ProjectMenuActions,
  t: (key: string) => string,
): MenuItemConstructorOptions {
  const running = runtime.status === 'running';
  const label = `${t('session')} ${index} · ${runtime.status}`;
  return {
    label,
    submenu: [
      {
        label: t('quickView'),
        click: () => actions.activate(runtime.id),
      },
      {
        label: 'WebUI',
        enabled: running,
        submenu: [
          {
            label: t('chat'),
            click: () =>
              actions.activateAndNavigate(runtime.id, { activity: 'chat', view: 'chat' }),
          },
          {
            label: t('focusPrompt'),
            click: () => actions.activateAndNavigate(runtime.id, { action: 'focus-chat' }),
          },
          {
            label: t('terminal'),
            click: () => actions.activateAndNavigate(runtime.id, { terminal: 'toggle' }),
          },
          {
            label: t('newTerminal'),
            click: () => actions.activateAndNavigate(runtime.id, { terminal: 'new' }),
          },
          { type: 'separator' },
          {
            label: t('files'),
            click: () =>
              actions.activateAndNavigate(runtime.id, { activity: 'files', view: 'files' }),
          },
          {
            label: t('changes'),
            click: () =>
              actions.activateAndNavigate(runtime.id, { activity: 'changes', view: 'changes' }),
          },
          {
            label: t('sessions'),
            click: () => actions.activateAndNavigate(runtime.id, { view: 'sessions' }),
          },
          {
            label: t('fleetHQ'),
            click: () => actions.activateAndNavigate(runtime.id, { view: 'roster' }),
          },
          {
            label: t('settings'),
            click: () => actions.activateAndNavigate(runtime.id, { view: 'settings' }),
          },
          { type: 'separator' },
          {
            label: t('commandPalette'),
            click: () =>
              actions.activateAndNavigate(runtime.id, { action: 'open-command-palette' }),
          },
          {
            label: t('modelSwitcher'),
            click: () => actions.activateAndNavigate(runtime.id, { action: 'open-model-switcher' }),
          },
        ],
      },
      { type: 'separator' },
      {
        label: t('openInBrowser'),
        enabled: running,
        click: () => actions.openBrowser(runtime.id),
      },
      {
        label: t('reloadWebui'),
        enabled: running,
        click: () => actions.reload(runtime.id),
      },
      {
        label: t('closeSession'),
        click: () => actions.close(runtime.id),
      },
    ],
  };
}

export function groupProjectRuntimesForMenu(runtimes: DesktopRuntimeRecord[]): ProjectMenuGroup[] {
  const groups = new Map<string, ProjectMenuGroup>();
  for (const runtime of runtimes) {
    if (runtime.kind !== 'project') continue;
    const key = normalizeMenuRoot(runtime.root);
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(runtime);
      continue;
    }
    groups.set(key, {
      key,
      name: path.basename(runtime.root) || runtime.name,
      root: runtime.root,
      sessions: [runtime],
    });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeMenuRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}
