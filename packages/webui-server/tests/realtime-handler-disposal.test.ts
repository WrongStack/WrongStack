import { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { SpecsWebSocketHandler, WorktreeWebSocketHandler } from '../src/index.js';

const logger: Logger = {
  level: 'error',
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

describe('realtime handler disposal', () => {
  it('clears Specs WebSocket clients', () => {
    const handler = new SpecsWebSocketHandler('specs', 'graphs');
    const internal = handler as unknown as { clients: Set<unknown> };
    internal.clients.add({});

    handler.dispose();
    expect(internal.clients.size).toBe(0);
  });

  it('clears Worktree socket and handle snapshots', () => {
    const handler = new WorktreeWebSocketHandler(new EventBus(), logger);
    const internal = handler as unknown as {
      clients: Set<unknown>;
      handles: Map<string, unknown>;
      baseBranch: string;
    };
    internal.clients.add({});
    internal.handles.set('run-1', {});
    internal.baseBranch = 'main';

    handler.dispose();
    expect(internal.clients.size).toBe(0);
    expect(internal.handles.size).toBe(0);
    expect(internal.baseBranch).toBe('');
  });
});
