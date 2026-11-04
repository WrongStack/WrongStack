import { useCodemapActivityStore } from '@wrongstack/project-surfaces/atlas/codemap-activity-store';
import { useCodemapIndexStore } from '@wrongstack/project-surfaces/atlas/codemap-index-store';
import {
  ATLAS_FRAME_TYPES,
  applyAtlasFrame,
  bindAtlasFrames,
} from '@wrongstack/project-surfaces/atlas/frames';
import { beforeEach, describe, expect, it } from 'vitest';
import { projectPath } from '../src/project-path';

beforeEach(() => useCodemapActivityStore.getState().clear());

describe('atlas frames from the project journal', () => {
  it('records a watcher file event the way the journal carries it', () => {
    applyAtlasFrame({
      type: 'codemap.file_event',
      payload: {
        at: 1_793_703_854_679,
        filePath: 'D:\\repo\\CODE_OF_CONDUCT.md',
        operation: 'edit',
        phase: 'changed',
        sessionId: 's1',
        source: 'watcher',
      },
    });
    const [activity] = useCodemapActivityStore
      .getState()
      .getActivityForFile('D:\\repo\\CODE_OF_CONDUCT.md');
    expect(activity).toMatchObject({ source: 'watcher', timestamp: 1_793_703_854_679 });
  });

  it('starts and finishes a tool operation on its file', () => {
    applyAtlasFrame({
      type: 'codemap.tool_started',
      payload: {
        id: 'tool-1',
        name: 'edit',
        fileTargets: [{ filePath: 'src/a.ts', operation: 'edit' }],
        agentId: 'worker',
        agentName: 'WORKER',
      },
    });
    expect(useCodemapActivityStore.getState().getActiveForFile('src/a.ts')).toHaveLength(1);
    applyAtlasFrame({
      type: 'codemap.tool_executed',
      payload: { id: 'tool-1', durationMs: 12, ok: true },
    });
    expect(useCodemapActivityStore.getState().getActiveForFile('src/a.ts')).toHaveLength(0);
  });

  it('reloads the map in place when the index is rebuilt', () => {
    const before = useCodemapIndexStore.getState().generation;
    applyAtlasFrame({ type: 'codemap.index_updated', payload: { at: 42 } });
    expect(useCodemapIndexStore.getState()).toMatchObject({
      generation: before + 1,
      lastUpdatedAt: 42,
    });
  });

  it('subscribes to every atlas frame and stops on request', () => {
    const handlers = new Map<string, (message: { payload: unknown }) => void>();
    const stop = bindAtlasFrames((type, handler) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    });
    expect([...handlers.keys()]).toEqual([...ATLAS_FRAME_TYPES]);
    const before = useCodemapIndexStore.getState().generation;
    handlers.get('codemap.index_updated')?.({ payload: {} });
    expect(useCodemapIndexStore.getState().generation).toBe(before + 1);
    stop();
    expect(handlers.size).toBe(0);
  });
});

describe('project paths', () => {
  it('shows a file inside the project relative to its root', () => {
    expect(projectPath('\\\\?\\D:\\Repo\\src\\a.ts', 'd:\\repo\\')).toBe('src/a.ts');
    expect(projectPath('E:/other/b.ts', 'D:/Repo')).toBe('E:/other/b.ts');
  });
});
