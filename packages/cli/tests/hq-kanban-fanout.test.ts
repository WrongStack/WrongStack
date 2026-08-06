/**
 * C2 — Kanban snapshot fanout test.
 *
 * Verifies the post-merge `hq.kanban_snapshot` envelope is broadcast to every
 * client whose `projectId` matches — and to nobody else.
 *
 * This file used to assert "notifies every browser regardless of project
 * scope", which was true of the code and useless in practice: no browser
 * consumer for `hq.kanban_snapshot` has ever existed, so the assertion pinned
 * bandwidth the SPA parsed and threw away, while reading like proof that
 * browsers were served. See `hq-browser-protocol-parity.test.ts` for the guard
 * that now catches the whole class.
 *
 * The fanout is implemented by `fanoutKanbanDelta` in `hq-server/ws.ts`.
 * Extracted as a pure function so this test can drive the contract
 * directly without spinning up a full HQ server.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ConnectedClient } from '../src/hq-server/types.js';
import { fanoutKanbanDelta } from '../src/hq-server/ws.js';

function makeFakeWs() {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    send: vi.fn((data: string) => {
      sent.push(data);
    }),
  };
  return { ws: ws as unknown as WebSocket, sent };
}

function makeClient(projectId: string): { ws: WebSocket; client: ConnectedClient } {
  const { ws } = makeFakeWs();
  const client = {
    ws,
    clientId: `c-${projectId}-${Math.random().toString(36).slice(2, 8)}`,
    projectId,
    project: {
      projectId,
      projectRoot: '/test',
      projectName: projectId,
      machineId: 'm-test',
      workspaceKind: 'git' as const,
    },
    kind: 'tui',
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    capabilities: ['telemetry.publish'],
    declaredRedactionPolicy: {
      rawContent: false,
      toolArgs: 'summary' as const,
      paths: 'project-relative' as const,
    },
    lastEventSeq: 0,
    mailboxes: new Map(),
    sessions: new Map(),
    fleets: new Map(),
    mcpSnapshots: new Map(),
    commandQueue: [],
    isLeader: false,
  };
  return { ws, client };
}

const MESSAGE = JSON.stringify({
  type: 'hq.kanban_snapshot',
  payload: {
    projectId: 'p1',
    generatedAt: '2026-07-31T12:00:00.000Z',
    boards: [],
    tombstones: [],
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('C2 — Kanban snapshot fanout', () => {
  it('notifies every client in the same project', () => {
    const a = makeClient('p1');
    const b = makeClient('p1');
    const clients = new Map<WebSocket, ConnectedClient>([
      [a.ws, a.client],
      [b.ws, b.client],
    ]);
    const browsers = new Set<WebSocket>();

    const result = fanoutKanbanDelta(MESSAGE, clients, browsers, 'p1');

    expect(result.clientsNotified).toBe(2);
    expect(result.browsersNotified).toBe(0);
    expect(a.ws.send).toHaveBeenCalledWith(MESSAGE);
    expect(b.ws.send).toHaveBeenCalledWith(MESSAGE);
  });

  it('skips clients in a different project', () => {
    const same = makeClient('p1');
    const other = makeClient('p2');
    const clients = new Map<WebSocket, ConnectedClient>([
      [same.ws, same.client],
      [other.ws, other.client],
    ]);
    const browsers = new Set<WebSocket>();

    const result = fanoutKanbanDelta(MESSAGE, clients, browsers, 'p1');

    expect(result.clientsNotified).toBe(1);
    expect(same.ws.send).toHaveBeenCalledWith(MESSAGE);
    expect(other.ws.send).not.toHaveBeenCalled();
  });

  it('does not send the delta to browsers, which have no handler for it', () => {
    const browser1 = makeFakeWs();
    const browser2 = makeFakeWs();
    const browsers = new Set<WebSocket>([browser1.ws, browser2.ws]);
    const clients = new Map<WebSocket, ConnectedClient>();

    const result = fanoutKanbanDelta(MESSAGE, clients, browsers, 'p1');

    expect(result.clientsNotified).toBe(0);
    expect(result.browsersNotified).toBe(0);
    expect(browser1.ws.send).not.toHaveBeenCalled();
    expect(browser2.ws.send).not.toHaveBeenCalled();
  });

  it('serves the matching client while leaving a connected browser untouched', () => {
    const c = makeClient('p1');
    const browser = makeFakeWs();
    const clients = new Map<WebSocket, ConnectedClient>([[c.ws, c.client]]);
    const browsers = new Set<WebSocket>([browser.ws]);

    const result = fanoutKanbanDelta(MESSAGE, clients, browsers, 'p1');

    expect(result.clientsNotified).toBe(1);
    expect(result.browsersNotified).toBe(0);
    expect(c.ws.send).toHaveBeenCalledWith(MESSAGE);
    expect(browser.ws.send).not.toHaveBeenCalled();
  });

  it('returns zero counts when both maps are empty', () => {
    const result = fanoutKanbanDelta(
      MESSAGE,
      new Map<WebSocket, ConnectedClient>(),
      new Set<WebSocket>(),
      'p1',
    );

    expect(result).toEqual({ clientsNotified: 0, browsersNotified: 0 });
  });
});
