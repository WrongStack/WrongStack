import { EventBus } from '@wrongstack/contracts/kernel';
import type { Context } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import { setupEvents } from '../src/server/setup-events.js';

vi.mock('@wrongstack/kanban', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/kanban')>()),
  bridgeKanbanSupervisor: vi.fn(() => vi.fn()),
  getServerKanbanStore: vi.fn(() => ({ getBoard: vi.fn(), listBoards: vi.fn() })),
  recordTaskFileActivity: vi.fn(async () => false),
}));

/**
 * An approval must show where a call writes. `tool.confirm_needed` carries the
 * tool's declared `writeTargets` (VULN-001 Phase 2: the files inside a `patch`
 * diff, a `format` target list) and the TUI prompt lists them as WRITES; the
 * WebUI prompt can only show them if the server forwards them.
 */
describe('tool.confirm_needed carries the declared write targets', () => {
  it('forwards writeTargets to the WebUI prompt', () => {
    const events = new EventBus();
    const broadcast = vi.fn();
    const dispose = setupEvents({
      events,
      broadcast,
      clients: new Map(),
      config: {},
      context: {
        session: { id: 'session-live' },
        todos: [],
        state: { onChange: vi.fn(), revision: 0 },
      } as unknown as Context,
      pendingConfirms: new Map(),
    });

    events.emit('tool.confirm_needed', {
      sessionId: 'session-live',
      tool: {
        name: 'patch',
        description: 'apply a diff',
        inputSchema: { type: 'object' },
        permission: 'confirm',
        mutating: true,
        execute: vi.fn(),
      },
      input: { diff: '--- a/src/a.ts\n+++ b/src/a.ts\n' },
      toolUseId: 'confirm-writes',
      suggestedPattern: 'patch',
      writeTargets: ['src/a.ts', '.github/workflows/release.yml'],
      deadlineAt: 120_000,
      resolve: vi.fn(),
    });

    expect(broadcast).toHaveBeenCalledWith(
      expect.any(Map),
      expect.objectContaining({
        type: 'tool.confirm_needed',
        payload: expect.objectContaining({
          writeTargets: ['src/a.ts', '.github/workflows/release.yml'],
        }),
      }),
    );
    dispose();
  });
});
