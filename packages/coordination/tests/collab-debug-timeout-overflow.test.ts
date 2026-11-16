import { describe, expect, it } from 'vitest';
import { CollabSession } from '../src/collab-debug.js';

describe('CollabSession timeout clamping (F392)', () => {
  it('clamps timeoutMs above 32-bit signed max instead of timing out in 1ms', async () => {
    const director = {
      spawn: async () => 's1',
      assignInternal: async () => {},
      assign: async () => ({ taskId: 't1', subagentId: 's1' }),
      awaitTasks: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return [{ taskId: 't1', status: 'completed', output: 'ok' }];
      },
      cancel: async () => {},
    };
    const fleetBus = {
      emit: () => {},
      on: () => () => {},
      filter: () => () => {},
    };

    const session = new CollabSession(
      director as never,
      fleetBus as never,
      {
        projectRoot: process.cwd(),
        targetPaths: [],
        timeoutMs: 3_000_000_000,
        prebuiltSnapshot: { id: 'snap1', createdAt: new Date().toISOString(), files: [] },
      } as never,
    );

    await expect(session.start()).resolves.toBeDefined();
  });
});
