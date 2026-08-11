/**
 * Kanban is a projection, and a projection may never take down its source.
 *
 * A stale IPC endpoint once made `hydrateSessionKanban` throw out of
 * `setupSession`, which killed `wstack` before it produced a prompt — no
 * session at all, because a board the user had not asked for could not be
 * reached. `bindProjectEndpoint` stops the daemon from wedging in the first
 * place, but that is the belt; this is the braces. Any failure reaching Kanban
 * must degrade to `null` and be reportable, never propagate.
 */
import type { Context } from '@wrongstack/core/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@wrongstack/kanban', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@wrongstack/kanban');
  return {
    ...actual,
    // Stands in for every way the daemon can be unreachable: the client throws
    // this exact shape when the endpoint refuses and no daemon can be spawned.
    listBoards: vi.fn(async () => {
      throw new Error('Failed to connect to kanban project server at /tmp/wskb-v6/deadbeef.sock');
    }),
  };
});

const { hydrateSessionKanban, sessionKanbanDegradation } = await import('../src/session-kanban.js');

function contextFor(projectRoot: string): Context {
  return {
    projectRoot,
    todos: [],
    meta: {},
    session: { id: 'degraded-session' },
    state: { onChange: () => () => undefined, replaceTodos: () => undefined },
    setCurrentKanbanTask: () => undefined,
  } as never as Context;
}

describe('session kanban degradation', () => {
  beforeEach(() => {
    delete process.env.WRONGSTACK_KANBAN_TASK_MIRROR;
  });

  it('resolves null instead of throwing when the daemon is unreachable', async () => {
    await expect(hydrateSessionKanban(contextFor('/nonexistent-project'))).resolves.toBeNull();
  });

  it('reports why the board is unavailable so a surface can say so once', async () => {
    await hydrateSessionKanban(contextFor('/nonexistent-project'));
    const reason = sessionKanbanDegradation();
    expect(reason).toContain('Failed to connect to kanban project server');
  });

  it('does nothing at all without a session id', async () => {
    const context = {
      ...contextFor('/nonexistent-project'),
      session: undefined,
    } as never as Context;
    await expect(hydrateSessionKanban(context)).resolves.toBeNull();
  });
});
