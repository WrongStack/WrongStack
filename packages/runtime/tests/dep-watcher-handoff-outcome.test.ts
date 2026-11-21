import { describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({
  onSpawn: undefined as ((task: string, name: string) => Promise<unknown>) | undefined,
}));

vi.mock('@wrongstack/coordination', () => ({
  getSharedProjectMailbox: () => ({ send: async () => {} }),
  startTechStackConsumer: (opts: { onSpawn: (task: string, name: string) => Promise<unknown> }) => {
    seam.onSpawn = opts.onSpawn;
    return () => {};
  },
  startPackageOutdatedWatcher: () => () => {},
}));

import { setupDepWatcherConsumers } from '../src/dep-watcher/consumers.js';

describe('dep-watcher handoff preserves awaitTasks outcome', () => {
  it('logs the real rejection and result summary when director exists before spawn', async () => {
    const logs: string[] = [];
    setupDepWatcherConsumers({
      dwCfg: { enabled: true },
      globalRoot: '/tmp/dw-handoff-test',
      projectSlug: 'proj',
      events: { onPattern: () => () => {} } as never,
      sessionId: 'sess-1',
      projectRoot: '/tmp/dw-handoff-test',
      teardownHandlers: [],
      logger: { info: (m) => logs.push(m), warn: () => {}, debug: () => {} },
      multiAgentHost: {
        spawn: async () => ({ subagentId: 's1', taskId: 't1' }),
        getDirector: () => ({
          awaitTasks: () => Promise.reject(new Error('audit crashed')),
        }),
      },
    });

    await seam.onSpawn?.('audit', 'tech-stack');
    await new Promise((r) => setTimeout(r, 10));

    expect(logs).toContain('[dep-watcher] audit settled rejected: audit crashed');
  });
});
