import { createCompatibilityTrustBoundary } from '@wrongstack/core/security';
import { describe, expect, it } from 'vitest';
import { EngineOperations } from '../../../apps/desktop-v2/src/engine-operations.js';
import type { ConnectionsHealthContext } from '../src/server/connections/types.js';
import {
  handleConnectionsHealthRoute,
  handleConnectionsServiceAction,
} from '../src/server/connections-health-route.js';
import type { WSClientMessage } from '../src/server/types.js';

const report = {
  checkedAt: 1,
  overall: 'healthy' as const,
  backend: 'standalone' as const,
  projectRoot: 'fixture',
  services: [],
};
function consumer(
  collect: NonNullable<ConnectionsHealthContext['collect']> = async () => report,
  authority = true,
) {
  const operations = new EngineOperations(async (type, payload) => {
    const context: ConnectionsHealthContext = {
      getProjectRoot: () => '.',
      getIndexDir: () => undefined,
      backend: 'standalone',
      collect,
      ...(authority ? { trustBoundary: createCompatibilityTrustBoundary() } : {}),
      send: (_ws, reply) => operations.receive(reply as never),
    };
    const message = { type, payload } as WSClientMessage;
    if (!(await handleConnectionsHealthRoute(context, {} as never, message)))
      await handleConnectionsServiceAction({} as never, message, context);
  }, 500);
  return operations;
}

describe('native connections acknowledgement contract', () => {
  it('settles the real native health request instead of timing out', async () => {
    const ops = consumer();
    try {
      await expect(
        ops.request('connections.health', {}, [
          'connections.health_result',
          'connections.health_error',
        ]),
      ).resolves.toMatchObject(report);
    } finally {
      ops.clear();
    }
  });
  it('settles collector failure with its actual error message', async () => {
    const ops = consumer(async () => {
      throw Error('fixture health collector failed');
    });
    try {
      await expect(
        ops.request('connections.health', {}, [
          'connections.health_result',
          'connections.health_error',
        ]),
      ).rejects.toThrow('fixture health collector failed');
    } finally {
      ops.clear();
    }
  });
  it.each([
    [{ action: 'restart' }, true, 'Missing serviceId'],
    [{ serviceId: 'mailbox', action: 'invalid' }, true, 'Unsupported action'],
    [{ serviceId: 'mailbox', action: 'restart' }, false, 'no policy authority'],
    [{ serviceId: 'webui', action: 'restart' }, true, 'Cannot restart the WebUI'],
    [{ serviceId: 'unknown-fixture', action: 'restart' }, true, 'Unknown service'],
  ] as const)('acknowledges action refusal %j', async (payload, authority, reason) => {
    const ops = consumer(undefined, authority);
    try {
      await expect(
        ops.request('connections.service_action', { ...payload }, [
          'connections.service_action_result',
        ]),
      ).rejects.toThrow(reason);
    } finally {
      ops.clear();
    }
  });
  it('leaves legacy id-less clients unchanged', async () => {
    const replies: unknown[] = [];
    await handleConnectionsHealthRoute(
      {
        getProjectRoot: () => '.',
        getIndexDir: () => undefined,
        backend: 'standalone',
        collect: async () => report,
        send: (_ws, reply) => replies.push(reply),
      },
      {} as never,
      { type: 'connections.health' },
    );
    expect(replies).toEqual([{ type: 'connections.health_result', payload: report }]);
  });
});
