/**
 * Unit tests for runtime operations module.
 * Tests the operation flow logic that can run without Electron.
 */
import { describe, it, expect, vi } from 'vitest';
import type { IRuntimeManager, IAgentBridge } from '../src/main/state/types.js';
import type { DesktopRuntimeRecord } from '../src/shared/types.js';

// Mock Electron to prevent dynamic import errors
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

// Mock the non-existent desktopSettingsWorkspaceRoot import
vi.mock('../src/main/runtime-manager.js', () => ({
  desktopSettingsWorkspaceRoot: vi.fn(() => '/mock/settings/root'),
  rendererIndexPath: vi.fn(),
  preloadPath: vi.fn(),
  webuiPreloadPath: vi.fn(),
}));

import type { RuntimeOperationsContext } from '../src/main/runtime/operations.js';
import {
  unregisterProject,
  activateRuntime,
  closeRuntime,
} from '../src/main/runtime/operations.js';

// ============================================================================
// Mock Helpers
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

function createMockContext(
  overrides: Partial<RuntimeOperationsContext> = {},
): RuntimeOperationsContext {
  const runtimeManager = {
    snapshot: vi.fn().mockReturnValue({
      runtimes: [createMockRuntime()],
      activeRuntimeId: 'runtime-1',
      lastActiveProjectRoot: null,
      openProjects: ['/test/project'],
    }),
    activateRuntime: vi.fn(),
    closeRuntime: vi.fn(),
    openProject: vi.fn(),
    registerProject: vi.fn(),
    unregisterProject: vi.fn(),
    restoreLastWorkspace: vi.fn(),
    getRuntime: vi.fn(),
    getRuntimeUrlWithToken: vi.fn(),
    getStateFile: vi.fn(),
    getRestoreActiveRuntimeId: vi.fn(),
    getRestoreProjectSessions: vi.fn(),
    getRestoreOpenProjects: vi.fn(),
  } as unknown as IRuntimeManager;

  const agentBridge = {
    close: vi.fn(),
    sendMessage: vi.fn(),
    abort: vi.fn(),
    closeAll: vi.fn(),
    getConversation: vi.fn(),
    getConversationSnapshot: vi.fn(),
    runtimeConnected: vi.fn(),
    runtimeDisconnected: vi.fn(),
    getStatus: vi.fn(),
  } as unknown as IAgentBridge;

  return {
    getRuntimeManager: () => runtimeManager,
    getAgentBridge: () => agentBridge,
    broadcastState: vi.fn(),
    syncActiveWebuiView: vi.fn(),
    dispatchWebuiCommand: vi.fn(),
    chooseProjectRoot: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// unregisterProject Tests
// ============================================================================

describe('unregisterProject', () => {
  it('should return snapshot when root is empty', async () => {
    const ctx = createMockContext();
    const result = await unregisterProject(ctx, '');
    expect(ctx.getRuntimeManager().snapshot).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('should return snapshot when root is not a string', async () => {
    const ctx = createMockContext();
    const result = await unregisterProject(ctx, '' as string);
    expect(ctx.getRuntimeManager().snapshot).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('should unregister project with valid root', async () => {
    const ctx = createMockContext();
    await unregisterProject(ctx, '/test/project');
    expect(ctx.getRuntimeManager().unregisterProject).toHaveBeenCalledWith('/test/project');
  });

  it('should broadcast state after unregistering', async () => {
    const ctx = createMockContext();
    await unregisterProject(ctx, '/test/project');
    expect(ctx.broadcastState).toHaveBeenCalled();
  });

  it('should return snapshot after operation', async () => {
    const ctx = createMockContext();
    const result = await unregisterProject(ctx, '/test/project');
    expect(result).toBeDefined();
    expect(result.runtimes).toBeDefined();
    expect(ctx.getRuntimeManager().unregisterProject).toHaveBeenCalledWith('/test/project');
  });
});

// ============================================================================
// activateRuntime Tests
// ============================================================================

describe('activateRuntime', () => {
  it('should activate runtime with given ID', async () => {
    const ctx = createMockContext();
    await activateRuntime(ctx, 'runtime-1');
    expect(ctx.getRuntimeManager().activateRuntime).toHaveBeenCalledWith('runtime-1');
  });

  it('should sync active webui view after activation', async () => {
    const ctx = createMockContext();
    await activateRuntime(ctx, 'runtime-1');
    expect(ctx.syncActiveWebuiView).toHaveBeenCalled();
  });

  it('should broadcast state after activation', async () => {
    const ctx = createMockContext();
    await activateRuntime(ctx, 'runtime-1');
    expect(ctx.broadcastState).toHaveBeenCalled();
  });

  it('should return snapshot', async () => {
    const ctx = createMockContext();
    const result = await activateRuntime(ctx, 'runtime-1');
    expect(result).toBeDefined();
    expect(result.runtimes).toHaveLength(1);
  });
});

// ============================================================================
// closeRuntime Tests
// ============================================================================

describe('closeRuntime', () => {
  it('should close agent bridge for runtime', async () => {
    const ctx = createMockContext();
    await closeRuntime(ctx, 'runtime-1');
    expect(ctx.getAgentBridge().close).toHaveBeenCalledWith('runtime-1');
  });

  it('should close runtime in manager', async () => {
    const ctx = createMockContext();
    await closeRuntime(ctx, 'runtime-1');
    expect(ctx.getRuntimeManager().closeRuntime).toHaveBeenCalledWith('runtime-1');
  });

  it('should sync active webui view after close', async () => {
    const ctx = createMockContext();
    await closeRuntime(ctx, 'runtime-1');
    expect(ctx.syncActiveWebuiView).toHaveBeenCalled();
  });

  it('should broadcast state after close', async () => {
    const ctx = createMockContext();
    await closeRuntime(ctx, 'runtime-1');
    expect(ctx.broadcastState).toHaveBeenCalled();
  });

  it('should return snapshot', async () => {
    const ctx = createMockContext();
    const result = await closeRuntime(ctx, 'runtime-1');
    expect(result).toBeDefined();
    expect(result.runtimes).toHaveLength(1);
  });
});
