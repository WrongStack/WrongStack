import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connection: { request: vi.fn() },
  getConnection: vi.fn(),
}));

vi.mock('../src/server/client.js', () => ({
  getKanbanServerConnection: mocks.getConnection,
}));

import * as clientDomain from '../src/client-domain.js';
import { createBoard, exportBoardToTaskGraph, moveTask, splitTask } from '../src/client-domain.js';
import { KANBAN_DOMAIN_OPERATIONS } from '../src/domain-operations.js';
import * as packageApi from '../src/index.js';
import * as manager from '../src/manager.js';
import type { KanbanEventContext } from '../src/types.js';

/** Session every routed mutation in this suite is attributed to. */
const EVENT_CONTEXT: KanbanEventContext = {
  sessionId: '2026-08-26/sess_01TESTCLIENTDOMAIN000000',
};
import { decodeKanbanDomainValue, encodeKanbanDomainValue } from '../src/server/protocol.js';

describe('stateful Kanban client domain', () => {
  beforeEach(() => {
    process.env['WRONGSTACK_KANBAN_FORCE_IPC'] = '1';
    mocks.connection.request.mockReset();
    mocks.connection.request.mockResolvedValue(encodeKanbanDomainValue(undefined));
    mocks.getConnection.mockReset();
    mocks.getConnection.mockResolvedValue(mocks.connection);
  });

  afterEach(() => {
    delete process.env['WRONGSTACK_KANBAN_FORCE_IPC'];
  });

  it('routes board and task operations through the whitelisted domainCall', async () => {
    mocks.connection.request.mockResolvedValueOnce(encodeKanbanDomainValue({ id: 'board-1' }));
    await createBoard('D:\\project', { title: 'IPC board' });
    await splitTask('D:\\project', 'board-1', 'task-1', { titles: ['one', 'two'] }, EVENT_CONTEXT);

    expect(mocks.connection.request).toHaveBeenNthCalledWith(1, 'domainCall', {
      operation: 'createBoard',
      wireArgs: encodeKanbanDomainValue([{ title: 'IPC board' }]),
    });
    expect(mocks.connection.request).toHaveBeenNthCalledWith(2, 'domainCall', {
      operation: 'splitTask',
      wireArgs: encodeKanbanDomainValue([
        'board-1',
        'task-1',
        { titles: ['one', 'two'] },
        EVENT_CONTEXT,
      ]),
    });
  });

  it('routes every public stateful manager operation through the IPC client facade', () => {
    // Cast the facades to Records: the test's purpose is exactly to iterate
    // KANBAN_DOMAIN_OPERATIONS dynamically and prove every op is routed.
    const managerView = manager as unknown as Record<string, unknown>;
    const clientView = clientDomain as unknown as Record<string, unknown>;
    const packageApiView = packageApi as unknown as Record<string, unknown>;
    for (const operation of KANBAN_DOMAIN_OPERATIONS) {
      expect(typeof managerView[operation], `${operation} manager implementation`).toBe('function');
      expect(typeof clientView[operation], `${operation} client facade`).toBe('function');
      expect(packageApiView[operation], `${operation} public export`).toBe(clientView[operation]);
      expect(packageApiView[operation], `${operation} must not expose manager directly`).not.toBe(
        managerView[operation],
      );
    }
  });

  it('removes trailing undefined values before JSON framing', async () => {
    // `order` is skipped but the event context after it is not, so the encoder
    // has to carry an interior undefined rather than trim a trailing one.
    await moveTask('D:\\project', 'board-1', 'task-1', 'todo', undefined, EVENT_CONTEXT);
    expect(mocks.connection.request).toHaveBeenCalledWith('domainCall', {
      operation: 'moveTask',
      wireArgs: encodeKanbanDomainValue(['board-1', 'task-1', 'todo', undefined, EVENT_CONTEXT]),
    });
  });

  it('restores Map-bearing task graph results from domainCall', async () => {
    const graphNodes = new Map([['node-1', { id: 'node-1', title: 'Task' }]]);
    const taskIdMap = new Map([['task-1', 'node-1']]);
    mocks.connection.request.mockResolvedValueOnce(
      encodeKanbanDomainValue({
        board: { id: 'board-1' },
        graph: { nodes: graphNodes, edges: [], rootNodes: ['node-1'] },
        taskIdMap,
      }),
    );

    const result = await exportBoardToTaskGraph('D:\\project', 'board-1');

    expect(result?.graph.nodes).toBeInstanceOf(Map);
    expect(result?.graph.nodes.get('node-1')?.title).toBe('Task');
    expect(result?.taskIdMap).toBeInstanceOf(Map);
    expect(result?.taskIdMap.get('task-1')).toBe('node-1');
  });

  it('round-trips nested Map and Set values through JSON framing', () => {
    const encoded = encodeKanbanDomainValue({
      map: new Map([['key', new Set(['a', 'b'])]]),
    });
    const framed = JSON.parse(JSON.stringify(encoded));
    const decoded = decodeKanbanDomainValue(framed) as {
      map: Map<string, Set<string>>;
    };

    expect(decoded.map).toBeInstanceOf(Map);
    expect(decoded.map.get('key')).toEqual(new Set(['a', 'b']));
  });

  it('fails closed when the IPC owner is disabled', async () => {
    mocks.getConnection.mockResolvedValue(null);
    await expect(createBoard('D:\\project', { title: 'No fallback' })).rejects.toThrow(
      /stateful clients require IPC/,
    );
  });
});
