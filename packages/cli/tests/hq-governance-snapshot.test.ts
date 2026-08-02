import { EventEmitter } from 'node:events';
import { HQ_PROTOCOL_VERSION } from '@wrongstack/core/hq';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  buildSnapshot,
  HQ_STALE_SNAPSHOT_MS,
  reapStaleClientState,
} from '../src/hq-server/snapshot.js';
import type { ConnectedClient, HqSnapshotBroadcaster } from '../src/hq-server/types.js';
import { handleClient } from '../src/hq-server/ws.js';

class FakeSocket extends EventEmitter {
  readonly send = vi.fn();
  readonly close = vi.fn();
}

function hello(clientId: string, pid: number) {
  return {
    type: 'client.hello',
    payload: {
      protocolVersion: HQ_PROTOCOL_VERSION,
      client: {
        clientId,
        kind: 'tui',
        machineId: 'machine-1',
        pid,
        startedAt: '2026-08-02T11:00:00.000Z',
      },
      project: {
        projectId: 'project-1',
        projectRoot: 'D:/project',
        projectName: 'project',
        machineId: 'machine-1',
        workspaceKind: 'git',
      },
      capabilities: ['telemetry.publish', 'control.receive'],
    },
  };
}

function governanceEvent(clientId: string, seq: number, code = 'attachment_broker_healthy') {
  return {
    type: 'client.event',
    event: {
      id: `${clientId}-${seq}`,
      type: 'governance.snapshot',
      schemaVersion: HQ_PROTOCOL_VERSION,
      timestamp: '2026-08-02T12:00:00.000Z',
      clientId,
      projectId: 'project-1',
      seq,
      payload: {
        schemaVersion: 1,
        projectId: 'project-1',
        observedAt: '2026-08-02T12:00:00.000Z',
        available: true,
        signal: {
          level: code === 'attachment_broker_healthy' ? 'healthy' : 'warning',
          code,
          operatorAction: code === 'attachment_broker_healthy' ? 'none' : 'investigate',
          executionDisposition: 'continue',
        },
      },
    },
  };
}

describe('HQ governance snapshot ownership', () => {
  it('accepts only the elected project leader and folds its advisory into the project record', () => {
    const clients = new Map<WebSocket, ConnectedClient>();
    const browsers = new Set<WebSocket>();
    const broadcaster: HqSnapshotBroadcaster = {
      currentSerialized: () => '{}',
      broadcast: vi.fn(),
      close: vi.fn(),
    };
    const attach = (socket: FakeSocket): void =>
      handleClient(
        socket as unknown as WebSocket,
        clients,
        browsers,
        [],
        { getOperatorPolicy: () => undefined },
        broadcaster,
        new Map(),
        new Map(),
      );
    const leader = new FakeSocket();
    const follower = new FakeSocket();
    attach(leader);
    attach(follower);
    leader.emit('message', Buffer.from(JSON.stringify(hello('leader', 101))));
    follower.emit('message', Buffer.from(JSON.stringify(hello('follower', 102))));

    leader.emit('message', Buffer.from(JSON.stringify(governanceEvent('leader', 1))));
    follower.emit(
      'message',
      Buffer.from(JSON.stringify(governanceEvent('follower', 1, 'attachment_broker_degraded'))),
    );

    const leaderRecord = clients.get(leader as unknown as WebSocket);
    const followerRecord = clients.get(follower as unknown as WebSocket);
    expect(leaderRecord?.isLeader).toBe(true);
    expect(followerRecord?.isLeader).toBe(false);
    expect(leaderRecord?.governanceSnapshot?.payload.signal.code).toBe('attachment_broker_healthy');
    expect(followerRecord?.governanceSnapshot).toBeUndefined();
    expect(buildSnapshot(clients).projects[0]?.governance?.signal.code).toBe(
      'attachment_broker_healthy',
    );

    const receivedAt = leaderRecord?.governanceSnapshot?.receivedAt ?? 0;
    reapStaleClientState(clients, receivedAt + HQ_STALE_SNAPSHOT_MS + 1);
    expect(leaderRecord?.governanceSnapshot).toBeUndefined();
  });
});
