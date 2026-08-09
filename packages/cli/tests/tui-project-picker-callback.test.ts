import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectPickerItems, onProjectSelect } from '../src/boot/tui-project-picker-callback.js';
import type { ProjectEntry } from '../src/services/project-manifest.js';

const mocks = vi.hoisted(() => ({
  buildPickerItems: vi.fn(),
  loadManifest: vi.fn(),
  saveManifest: vi.fn(),
}));

vi.mock('../src/project-picker.js', () => ({
  buildPickerItems: mocks.buildPickerItems,
}));
vi.mock('../src/services/project-manifest.js', () => ({
  loadManifest: mocks.loadManifest,
  saveManifest: mocks.saveManifest,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      projectRoot: 'D:/current',
      wpaths: { globalConfig: 'D:/home/config.json' },
    },
    renderer: { write: vi.fn() },
    director: null,
    getEternalEngine: undefined,
    getParallelEngine: undefined,
    switchCtx: {},
    switchProjectInPlace: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('TUI project picker callbacks', () => {
  it('loads picker items for the current global manifest and project root', async () => {
    const ctx = context();
    mocks.buildPickerItems.mockResolvedValueOnce([{ slug: 'project' }]);
    await expect(getProjectPickerItems(ctx as never)).resolves.toEqual([{ slug: 'project' }]);
    expect(mocks.buildPickerItems).toHaveBeenCalledWith({
      globalConfigPath: 'D:/home/config.json',
      currentProjectRoot: 'D:/current',
    });
  });

  it('starts a new session in place and reports switch errors', async () => {
    const ctx = context({
      switchProjectInPlace: vi.fn().mockResolvedValue('locked'),
    });
    await onProjectSelect(ctx as never, 'new-session', 'action');
    expect(ctx.switchProjectInPlace).toHaveBeenCalledWith('D:/current', 'current');
    expect(ctx.renderer.write).toHaveBeenCalledWith(
      expect.stringContaining('Project switch failed: locked'),
    );

    await onProjectSelect(ctx as never, 'prev-sessions', 'action');
    expect(ctx.switchProjectInPlace).toHaveBeenCalledOnce();
  });

  it('ignores unknown and already-selected projects', async () => {
    const ctx = context();
    mocks.loadManifest.mockResolvedValueOnce({ projects: [] });
    await onProjectSelect(ctx as never, 'missing', 'project');
    expect(ctx.switchProjectInPlace).not.toHaveBeenCalled();

    mocks.loadManifest.mockResolvedValueOnce({
      projects: [{ slug: 'same', root: 'D:/current', name: 'Current' }],
    });
    await onProjectSelect(ctx as never, 'same', 'project');
    expect(mocks.saveManifest).not.toHaveBeenCalled();
  });

  it('warns about active work, updates lastSeen, saves, and switches projects', async () => {
    const project: ProjectEntry = {
      slug: 'next',
      root: path.join(process.cwd(), 'next'),
      name: 'Next',
    };
    mocks.loadManifest.mockResolvedValueOnce({ projects: [project] });
    const ctx = context({
      director: {
        status: () => ({
          subagents: [{ status: 'running' }, { status: 'idle' }],
        }),
      },
      getEternalEngine: () => ({ currentState: 'running' }),
      getParallelEngine: () => ({ currentState: 'running' }),
    });

    await onProjectSelect(ctx as never, 'next', 'project');

    expect(ctx.renderer.write).toHaveBeenCalledWith(
      expect.stringContaining('active background work'),
    );
    expect(ctx.renderer.write.mock.calls.flat().join(' ')).toContain('1 subagent');
    expect(project.lastSeen).toMatch(/T/);
    expect(mocks.saveManifest).toHaveBeenCalledWith({ projects: [project] }, 'D:/home/config.json');
    expect(ctx.switchProjectInPlace).toHaveBeenCalledWith(path.join(process.cwd(), 'next'), 'Next');
  });

  it('reports thrown and returned project-switch failures', async () => {
    const ctx = context({
      switchProjectInPlace: vi.fn().mockResolvedValue('cannot switch'),
    });
    mocks.loadManifest.mockResolvedValueOnce({
      projects: [{ slug: 'next', root: 'D:/next', name: 'Next' }],
    });
    await onProjectSelect(ctx as never, 'next', 'project');
    expect(ctx.renderer.write).toHaveBeenCalledWith(expect.stringContaining('cannot switch'));

    mocks.loadManifest.mockRejectedValueOnce('manifest corrupt');
    await onProjectSelect(ctx as never, 'next', 'project');
    expect(ctx.renderer.write).toHaveBeenCalledWith(expect.stringContaining('manifest corrupt'));
  });
});
