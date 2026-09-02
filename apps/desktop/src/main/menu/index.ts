/**
 * Application menu builder.
 * Builds the complete application menu with all sections.
 */
import { Menu } from 'electron';
import type { DesktopWebuiCommand } from '../../shared/types.js';
import type { MenuBuilderContext, ProjectMenuActions } from './types.js';
import { buildProjectsMenu } from './projects-menu.js';
import { buildFileMenu, buildWorkspaceMenu, buildViewMenu } from './sections.js';

export {
  buildProjectsMenu,
  normalizeMenuRoot,
  groupProjectRuntimesForMenu,
} from './projects-menu.js';
export * from './types.js';

/**
 * Configure the complete application menu.
 * This is the main entry point for building the menu.
 */
export function configureApplicationMenu(ctx: MenuBuilderContext): void {
  const snapshot = ctx.getSnapshot();
  const active = ctx.getActiveRuntime();
  const hasActiveRuntime = Boolean(active);
  const hasActiveWebui = active?.status === 'running';
  const hasActiveProjectWebui = hasActiveWebui && active?.kind === 'project';
  const activeWebuiPrefs = ctx.getActiveWebuiPrefs();

  const navigate = (command: DesktopWebuiCommand) => {
    void ctx.dispatchWebuiCommand(command);
  };

  const activateAndNavigate = (runtimeId: string, command: DesktopWebuiCommand) => {
    void ctx.activateRuntime(runtimeId).then(() => ctx.dispatchWebuiCommand(command));
  };

  const reloadRuntimeWebui = (runtimeId: string) => {
    void ctx.activateRuntime(runtimeId).then(() => ctx.reloadActiveWebuiView());
  };

  const actions: ProjectMenuActions = {
    activate: (runtimeId) => void ctx.activateRuntime(runtimeId),
    activateAndNavigate,
    registerProject: () => void ctx.registerProject(),
    newSession: (runtimeId) => {
      if (runtimeId) void ctx.openProjectSession(runtimeId);
      else void ctx.openProject();
    },
    openBrowser: (runtimeId) => {
      const url = ctx.getRuntimeManager().getRuntimeUrlWithToken(runtimeId);
      if (url) ctx.openExternal(url);
    },
    reload: reloadRuntimeWebui,
    close: (runtimeId) => void ctx.closeRuntime(runtimeId),
    reveal: (runtimeId) => {
      const runtime = ctx.getRuntimeManager().getRuntime(runtimeId);
      if (runtime) ctx.revealInExplorer(runtime.root);
    },
  };

  const template: import('electron').MenuItemConstructorOptions[] = [
    buildFileMenu(
      ctx,
      actions,
      hasActiveRuntime,
      hasActiveProjectWebui,
      active,
      navigate,
      ctx.getActiveRuntimeId,
    ),
    {
      label: ctx.t('projects'),
      submenu: buildProjectsMenu(snapshot.runtimes, actions, ctx.t),
    },
    buildWorkspaceMenu(ctx, actions, hasActiveWebui, activeWebuiPrefs, navigate),
    buildViewMenu(ctx),
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Re-export for backwards compatibility
export type { MenuBuilderContext, ProjectMenuActions, ProjectMenuGroup } from './types.js';
