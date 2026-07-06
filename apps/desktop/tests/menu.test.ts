/**
 * Unit tests for the menu module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DesktopRuntimeRecord } from '../src/shared/types.js';
import type { MenuBuilderContext, ProjectMenuActions } from '../src/main/menu/types.js';
import {
  buildProjectsMenu,
  groupProjectRuntimesForMenu,
  normalizeMenuRoot,
} from '../src/main/menu/index.js';
import { buildFileMenu, buildWorkspaceMenu, buildViewMenu } from '../src/main/menu/sections.js';

// ============================================================================
// Test Data
// ============================================================================

function createMockRuntime(overrides: Partial<DesktopRuntimeRecord> = {}): DesktopRuntimeRecord {
  return {
    id: 'runtime-1',
    name: 'Test Runtime',
    root: '/test/project',
    slug: 'test-project',
    kind: 'project',
    status: 'running',
    httpPort: 3000,
    wsPort: 3001,
    url: 'http://localhost:3000',
    startedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMockContext(overrides: Partial<MenuBuilderContext> = {}): MenuBuilderContext {
  return {
    getSnapshot: () => ({
      runtimes: [],
      activeRuntimeId: null,
    }),
    getActiveRuntime: () => undefined,
    getActiveWebuiPrefs: () => undefined,
    getShellSidebarCollapsed: () => false,
    t: (key: string) => key,
    getRuntimeManager: () => ({
      getRuntimeUrlWithToken: () => undefined,
      getRuntime: () => undefined,
    }),
    getWebuiViews: () => new Map(),
    dispatchWebuiCommand: vi.fn().mockResolvedValue(true),
    reloadActiveWebuiView: vi.fn().mockResolvedValue(true),
    activateRuntime: vi.fn().mockResolvedValue(undefined),
    openProject: vi.fn().mockResolvedValue(undefined),
    registerProject: vi.fn().mockResolvedValue(undefined),
    openSettings: vi.fn().mockResolvedValue(undefined),
    openProjectSession: vi.fn().mockResolvedValue(undefined),
    closeRuntime: vi.fn().mockResolvedValue(undefined),
    unregisterProject: vi.fn().mockResolvedValue(undefined),
    getActiveRuntimeId: () => null,
    setShellSidebarCollapsed: vi.fn(),
    restoreLastWorkspace: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn(),
    revealInExplorer: vi.fn(),
    ...overrides,
  } as unknown as MenuBuilderContext;
}

function createMockActions(overrides: Partial<ProjectMenuActions> = {}): ProjectMenuActions {
  return {
    activate: vi.fn(),
    activateAndNavigate: vi.fn(),
    newSession: vi.fn(),
    openBrowser: vi.fn(),
    reload: vi.fn(),
    close: vi.fn(),
    reveal: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// normalizeMenuRoot Tests
// ============================================================================

describe('normalizeMenuRoot', () => {
  it('should convert backslashes to forward slashes', () => {
    expect(normalizeMenuRoot('C:\\Users\\test\\project')).toBe('c:/users/test/project');
  });

  it('should remove trailing slashes', () => {
    expect(normalizeMenuRoot('/test/project///')).toBe('/test/project');
  });

  it('should convert to lowercase', () => {
    expect(normalizeMenuRoot('/Test/Project')).toBe('/test/project');
  });

  it('should handle empty string', () => {
    expect(normalizeMenuRoot('')).toBe('');
  });

  it('should handle mixed separators', () => {
    expect(normalizeMenuRoot('/Test\\Project///')).toBe('/test/project');
  });
});

// ============================================================================
// groupProjectRuntimesForMenu Tests
// ============================================================================

describe('groupProjectRuntimesForMenu', () => {
  it('should return empty array for empty input', () => {
    const result = groupProjectRuntimesForMenu([]);
    expect(result).toEqual([]);
  });

  it('should group runtimes by normalized root', () => {
    const runtimes: DesktopRuntimeRecord[] = [
      createMockRuntime({ id: 'r1', root: '/test/project' }),
      createMockRuntime({ id: 'r2', root: '/test/project' }),
    ];
    const result = groupProjectRuntimesForMenu(runtimes);
    expect(result).toHaveLength(1);
    expect(result[0].sessions).toHaveLength(2);
  });

  it('should separate runtimes with different roots', () => {
    const runtimes: DesktopRuntimeRecord[] = [
      createMockRuntime({ id: 'r1', root: '/test/project1' }),
      createMockRuntime({ id: 'r2', root: '/test/project2' }),
    ];
    const result = groupProjectRuntimesForMenu(runtimes);
    expect(result).toHaveLength(2);
  });

  it('should ignore non-project runtimes', () => {
    const runtimes: DesktopRuntimeRecord[] = [
      createMockRuntime({ id: 'r1', kind: 'project' }),
      createMockRuntime({ id: 'r2', kind: 'global-settings' }),
    ];
    const result = groupProjectRuntimesForMenu(runtimes);
    expect(result).toHaveLength(1);
    expect(result[0].sessions).toHaveLength(1);
  });

  it('should use basename for name', () => {
    const runtimes: DesktopRuntimeRecord[] = [
      createMockRuntime({ name: 'Custom', root: '/test/my-project' }),
    ];
    const result = groupProjectRuntimesForMenu(runtimes);
    expect(result[0].name).toBe('my-project');
  });

  it('should sort groups alphabetically by name', () => {
    const runtimes: DesktopRuntimeRecord[] = [
      createMockRuntime({ id: 'r1', root: '/test/zeta' }),
      createMockRuntime({ id: 'r2', root: '/test/alpha' }),
      createMockRuntime({ id: 'r3', root: '/test/beta' }),
    ];
    const result = groupProjectRuntimesForMenu(runtimes);
    expect(result[0].name).toBe('alpha');
    expect(result[1].name).toBe('beta');
    expect(result[2].name).toBe('zeta');
  });
});

// ============================================================================
// buildProjectsMenu Tests
// ============================================================================

describe('buildProjectsMenu', () => {
  it('should show no sessions message when empty', () => {
    const actions = createMockActions();
    const t = (key: string) => key;
    const result = buildProjectsMenu([], actions, t);
    expect(result).toHaveLength(4); // Open, Register, Separator, No sessions
    expect(result[3].label).toBe('noOpenProjectSessions');
    expect(result[3].enabled).toBe(false);
  });

  it('should include open and register options', () => {
    const actions = createMockActions();
    const t = (key: string) => key;
    const result = buildProjectsMenu([], actions, t);
    expect(result[0].label).toBe('openProjectEllipsis');
    expect(result[0].accelerator).toBe('CmdOrCtrl+O');
    expect(result[1].label).toBe('registerProjectEllipsis');
  });

  it('should create submenu for each project group', () => {
    const runtimes: DesktopRuntimeRecord[] = [
      createMockRuntime({ id: 'r1', root: '/test/project' }),
    ];
    const actions = createMockActions();
    const t = (key: string) => key;
    const result = buildProjectsMenu(runtimes, actions, t);
    // Open, Register, Separator, Project group (no trailing separator)
    expect(result).toHaveLength(4);
    expect(result[3]).toHaveProperty('submenu');
  });

  it('should call newSession when opening project', () => {
    const actions = createMockActions();
    const t = (key: string) => key;
    const result = buildProjectsMenu([], actions, t);
    const openItem = result[0];
    if (openItem.click) openItem.click();
    expect(actions.newSession).toHaveBeenCalledWith('');
  });
});

// ============================================================================
// Menu Section Tests
// ============================================================================

describe('buildFileMenu', () => {
  it('should create File menu with expected items', () => {
    const ctx = createMockContext();
    const actions = createMockActions();
    const menu = buildFileMenu(ctx, actions, false, false, undefined, vi.fn(), () => null);

    expect(menu.label).toBe('file');
    expect(menu.submenu).toBeDefined();
    const items = menu.submenu as Array<{ label?: string; enabled?: boolean }>;
    expect(items.some((i) => i.label === 'openProjectEllipsis')).toBe(true);
    expect(items.some((i) => i.label === 'registerProjectEllipsis')).toBe(true);
  });

  it('should enable close when has active runtime', () => {
    const runtime = createMockRuntime({ id: 'active', status: 'running' });
    const ctx = createMockContext({
      getSnapshot: () => ({
        runtimes: [runtime],
        activeRuntimeId: 'active',
      }),
    });
    const actions = createMockActions();
    const menu = buildFileMenu(ctx, actions, true, false, runtime, vi.fn(), () => 'active');

    const items = menu.submenu as Array<{ label?: string; enabled?: boolean }>;
    const closeItem = items.find((i) => i.label === 'closeActiveRuntime');
    expect(closeItem?.enabled).toBe(true);
  });

  it('should disable close when no active runtime', () => {
    const ctx = createMockContext();
    const actions = createMockActions();
    const menu = buildFileMenu(ctx, actions, false, false, undefined, vi.fn(), () => null);

    const items = menu.submenu as Array<{ label?: string; enabled?: boolean }>;
    const closeItem = items.find((i) => i.label === 'closeActiveRuntime');
    expect(closeItem?.enabled).toBe(false);
  });
});

describe('buildWorkspaceMenu', () => {
  it('should create Workspace menu', () => {
    const ctx = createMockContext();
    const menu = buildWorkspaceMenu(ctx, {}, false, undefined, vi.fn());

    expect(menu.label).toBe('workspace');
    expect(menu.submenu).toBeDefined();
    const items = menu.submenu as Array<{ label?: string }>;
    expect(items.some((i) => i.label === 'openChat')).toBe(true);
    expect(items.some((i) => i.label === 'commandPalette')).toBe(true);
  });

  it('should check yolo checkbox when enabled', () => {
    const ctx = createMockContext();
    const menu = buildWorkspaceMenu(ctx, {}, true, { yolo: true }, vi.fn());

    const items = menu.submenu as Array<{ label?: string; checked?: boolean }>;
    const yoloItem = items.find((i) => i.label === 'yoloMode');
    expect(yoloItem?.checked).toBe(true);
  });

  it('should uncheck yolo checkbox when disabled', () => {
    const ctx = createMockContext();
    const menu = buildWorkspaceMenu(ctx, {}, true, { yolo: false }, vi.fn());

    const items = menu.submenu as Array<{ label?: string; checked?: boolean }>;
    const yoloItem = items.find((i) => i.label === 'yoloMode');
    expect(yoloItem?.checked).toBe(false);
  });
});

describe('buildViewMenu', () => {
  it('should create View menu', () => {
    const ctx = createMockContext();
    const menu = buildViewMenu(ctx);

    expect(menu.label).toBe('view');
    expect(menu.submenu).toBeDefined();
    const items = menu.submenu as Array<{ label?: string }>;
    expect(items.some((i) => i.label === 'compactDesktopSidebar')).toBe(true);
  });

  it('should check sidebar checkbox when collapsed', () => {
    const ctx = createMockContext({ getShellSidebarCollapsed: () => true });
    const menu = buildViewMenu(ctx);

    const items = menu.submenu as Array<{ label?: string; checked?: boolean }>;
    const sidebarItem = items.find((i) => i.label === 'compactDesktopSidebar');
    expect(sidebarItem?.checked).toBe(true);
  });

  it('should uncheck sidebar checkbox when expanded', () => {
    const ctx = createMockContext({ getShellSidebarCollapsed: () => false });
    const menu = buildViewMenu(ctx);

    const items = menu.submenu as Array<{ label?: string; checked?: boolean }>;
    const sidebarItem = items.find((i) => i.label === 'compactDesktopSidebar');
    expect(sidebarItem?.checked).toBe(false);
  });
});
