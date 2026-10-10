import { describe, expect, it, vi } from 'vitest';
import {
  sessionCatalogProjectServerEndpoint,
  sessionCatalogProjectServerMetadataPath,
} from '../src/session-catalog/endpoint.js';
import {
  connectFrame,
  importDaemonInstance,
  makeTempRoot,
  sleep,
  waitForEndpointClosed,
  waitForMetadataFile,
  waitForMetadataRemoval,
} from './helpers/project-server-harness.js';

const startup = vi.hoisted(() => ({
  entered: () => {},
  ready: Promise.resolve(),
}));

vi.mock('../src/security/file-permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/security/file-permissions.js')>();
  return {
    ...actual,
    restrictFilePermissions: async (...args: Parameters<typeof actual.restrictFilePermissions>) => {
      if (args[1]?.label === 'session-catalog-metadata') {
        startup.entered();
        await startup.ready;
      }
      await actual.restrictFilePermissions(...args);
    },
  };
});

describe('Session Catalog startup disconnect', () => {
  it('keeps the elected daemon alive when a handshake probe leaves before metadata is ready', async () => {
    const fixture = await makeTempRoot('catalog-startup-disconnect');
    const endpoint = sessionCatalogProjectServerEndpoint(fixture.root);
    const metadataPath = sessionCatalogProjectServerMetadataPath(fixture.root);
    let releaseStartup = () => {};
    startup.ready = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      startup.entered = resolve;
    });
    try {
      await importDaemonInstance(
        '../../src/session-catalog/project-server.ts',
        ['--project-dir', fixture.root, '--project-root', fixture.root],
        Date.now(),
      );
      await entered;
      const probe = await connectFrame(endpoint);
      const closed = new Promise<void>((resolve) => probe.socket.once('close', resolve));
      probe.socket.destroy();
      await closed;
      // Exceed the post-disconnect idle grace while the metadata write is gated.
      await sleep(500);
      releaseStartup();
      const client = await connectFrame(endpoint);
      try {
        expect(await client.nextFrame()).toMatchObject({ type: 'hello' });
        const metadata = await waitForMetadataFile<{ authToken: string }>(metadataPath);
        client.socket.write(
          `${JSON.stringify({ type: 'request', id: 1, op: 'ping', args: {}, authToken: metadata.authToken })}\n`,
        );
        expect(await client.nextFrame()).toMatchObject({ type: 'response', id: 1, ok: true });
        client.socket.write(
          `${JSON.stringify({ type: 'shutdown', id: 2, authToken: metadata.authToken })}\n`,
        );
        expect(await client.nextFrame()).toMatchObject({ type: 'response', id: 2, ok: true });
      } finally {
        client.socket.destroy();
      }
      await waitForMetadataRemoval(metadataPath);
      await waitForEndpointClosed(endpoint);
    } finally {
      releaseStartup();
      await fixture.release();
    }
  });
});
