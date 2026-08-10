import { describe, expect, it } from 'vitest';
import {
  sessionCatalogProjectServerEndpoint,
  sessionCatalogProjectServerMetadataPath,
} from '../src/session-catalog/endpoint.js';
import {
  connectFrame,
  importDaemonInstance,
  makeTempRoot,
  waitForEndpointClosed,
  waitForMetadataFile,
  waitForMetadataRemoval,
} from './helpers/project-server-harness.js';

describe('Session Catalog project server IPC', () => {
  it('authenticates, reports health, arbitrates claims, and shuts down cleanly', async () => {
    const fixture = await makeTempRoot('session-catalog');
    const endpoint = sessionCatalogProjectServerEndpoint(fixture.root);
    const metadataPath = sessionCatalogProjectServerMetadataPath(fixture.root);
    try {
      await importDaemonInstance(
        '../../src/session-catalog/project-server.ts',
        ['--project-dir', fixture.root, '--project-root', fixture.root],
        Date.now(),
      );
      const metadata = await waitForMetadataFile<{ authToken: string; pid: number }>(metadataPath);
      const client = await connectFrame(endpoint);
      expect((await client.nextFrame()).type).toBe('hello');

      client.socket.write(`${JSON.stringify({ type: 'request', id: 1, op: 'ping', args: {} })}\n`);
      expect(await client.nextFrame()).toMatchObject({
        type: 'response',
        id: 1,
        ok: false,
        errorName: 'UnauthorizedSessionCatalogRequest',
      });

      client.socket.write(
        `${JSON.stringify({ type: 'request', id: 2, op: 'ping', args: {}, authToken: metadata.authToken })}\n`,
      );
      const ping = await client.nextFrame();
      expect(ping).toMatchObject({ type: 'response', id: 2, ok: true });
      expect(ping.result).toMatchObject({ catalogRows: 0, liveLeases: 0 });

      client.socket.write(
        `${JSON.stringify({
          type: 'request',
          id: 20,
          op: 'upsert_summary',
          args: {
            summary: {
              id: '2026-08-08/sess_filter_ipc',
              title: 'Filtered over IPC',
              startedAt: '2026-08-08T09:00:00.000Z',
              model: 'ipc-model',
              provider: 'ipc-provider',
              tokenTotal: 42,
            },
          },
          authToken: metadata.authToken,
        })}\n`,
      );
      expect(await client.nextFrame()).toMatchObject({ type: 'response', id: 20, ok: true });
      client.socket.write(
        `${JSON.stringify({
          type: 'request',
          id: 21,
          op: 'list_catalog',
          args: { provider: 'ipc-provider', model: 'ipc-model', minTokens: 40, limit: 1 },
          authToken: metadata.authToken,
        })}\n`,
      );
      expect(await client.nextFrame()).toMatchObject({
        type: 'response',
        id: 21,
        ok: true,
        result: [expect.objectContaining({ id: '2026-08-08/sess_filter_ipc' })],
      });

      const now = new Date().toISOString();
      const claim = {
        entry: {
          sessionId: '2026-08-08/sess_ipc',
          projectSlug: 'ipc',
          projectRoot: fixture.root,
          projectName: 'ipc',
          workingDir: fixture.root,
          clientType: 'tui',
          status: 'active',
          pid: process.pid,
          startedAt: now,
          lastHeartbeatAt: now,
          agentCount: 0,
          agents: [],
        },
        ownerInstanceId: 'ipc-owner-a',
      };
      client.socket.write(
        `${JSON.stringify({ type: 'request', id: 3, op: 'subscribe', args: {}, authToken: metadata.authToken })}\n`,
      );
      expect(await client.nextFrame()).toMatchObject({ type: 'response', id: 3, ok: true });
      client.socket.write(
        `${JSON.stringify({ type: 'request', id: 4, op: 'claim_new', args: claim, authToken: metadata.authToken })}\n`,
      );
      expect(await client.nextFrame()).toMatchObject({ type: 'response', id: 4, ok: true });
      expect(await client.nextFrame()).toMatchObject({
        type: 'event',
        event: { kind: 'session.claimed', sessionId: '2026-08-08/sess_ipc' },
      });
      client.socket.write(
        `${JSON.stringify({ type: 'request', id: 5, op: 'claim_new', args: { ...claim, ownerInstanceId: 'ipc-owner-b' }, authToken: metadata.authToken })}\n`,
      );
      expect(await client.nextFrame()).toMatchObject({
        type: 'response',
        id: 5,
        ok: false,
        errorName: 'SessionOwnershipConflictError',
      });

      client.socket.write(
        `${JSON.stringify({ type: 'shutdown', id: 6, reason: 'test', authToken: metadata.authToken })}\n`,
      );
      expect(await client.nextFrame()).toMatchObject({ type: 'response', id: 6, ok: true });
      client.socket.destroy();
      await waitForMetadataRemoval(metadataPath);
      await waitForEndpointClosed(endpoint);
    } finally {
      await fixture.release();
    }
  });

  it('exits promptly after the last client releases its project lease', async () => {
    const fixture = await makeTempRoot('session-catalog-disconnect-idle');
    const endpoint = sessionCatalogProjectServerEndpoint(fixture.root);
    const metadataPath = sessionCatalogProjectServerMetadataPath(fixture.root);
    const previousIdle = process.env['WRONGSTACK_SESSION_CATALOG_IDLE_MS'];
    process.env['WRONGSTACK_SESSION_CATALOG_IDLE_MS'] = '60000';
    try {
      await importDaemonInstance(
        '../../src/session-catalog/project-server.ts',
        ['--project-dir', fixture.root, '--project-root', fixture.root],
        Date.now(),
      );
      const metadata = await waitForMetadataFile<{ authToken: string }>(metadataPath);
      const client = await connectFrame(endpoint);
      expect((await client.nextFrame()).type).toBe('hello');

      const now = new Date().toISOString();
      client.socket.write(
        `${JSON.stringify({
          type: 'request',
          id: 1,
          op: 'claim_new',
          args: {
            entry: {
              sessionId: '2026-08-09/sess_switch',
              projectSlug: 'switch',
              projectRoot: fixture.root,
              projectName: 'switch',
              workingDir: fixture.root,
              clientType: 'tui',
              status: 'active',
              pid: process.pid,
              startedAt: now,
              lastHeartbeatAt: now,
              agentCount: 0,
              agents: [],
            },
            ownerInstanceId: 'switch-owner',
          },
          authToken: metadata.authToken,
        })}\n`,
      );
      const claimed = await client.nextFrame();
      expect(claimed).toMatchObject({ type: 'response', id: 1, ok: true });

      client.socket.write(
        `${JSON.stringify({
          type: 'request',
          id: 2,
          op: 'release',
          args: { credential: claimed.result },
          authToken: metadata.authToken,
        })}\n`,
      );
      expect(await client.nextFrame()).toMatchObject({ type: 'response', id: 2, ok: true });
      client.socket.destroy();

      await waitForMetadataRemoval(metadataPath, 2_000);
      await waitForEndpointClosed(endpoint, 2_000);
    } finally {
      if (previousIdle === undefined) delete process.env['WRONGSTACK_SESSION_CATALOG_IDLE_MS'];
      else process.env['WRONGSTACK_SESSION_CATALOG_IDLE_MS'] = previousIdle;
      await fixture.release();
    }
  });
});
