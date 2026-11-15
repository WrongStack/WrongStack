/**
 * A mailbox daemon of an older release is replaced, not reused: the client asks it to stop with
 * the project's token and connects to the daemon of its own release that takes over the
 * endpoint. A daemon of the same release is reused as before. The daemon spawn is stubbed; the
 * fake daemons stand in for it.
 */
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WRONGSTACK_RUNTIME_VERSION } from '@wrongstack/primitives';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MailboxProjectServerConnection } from '../src/mailbox-project-server-client.js';
import {
  mailboxProjectServerEndpoint,
  mailboxProjectServerMetadataPath,
} from '../src/mailbox-project-server-endpoint.js';
import { MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION } from '../src/mailbox-project-server-protocol.js';

let projectDir: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-older-daemon-'));
  await fs.writeFile(
    mailboxProjectServerMetadataPath(projectDir),
    JSON.stringify({ projectDir, authToken: 'project-token' }),
  );
  vi.spyOn(
    MailboxProjectServerConnection.prototype as unknown as {
      spawnDetachedServer(): number | undefined;
    },
    'spawnDetachedServer',
  ).mockReturnValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await fs.rm(projectDir, { recursive: true, force: true });
});

/** A fake mailbox daemon of `version` that records the frames it receives. */
async function daemon(version: string, onShutdown?: () => void) {
  const endpoint = mailboxProjectServerEndpoint(projectDir);
  const frames: Array<Record<string, unknown>> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
        buffer = buffer.slice(nl + 1);
        frames.push(frame);
        if (frame['type'] === 'shutdown') onShutdown?.();
      }
    });
    socket.write(
      `${JSON.stringify({
        type: 'hello',
        runtimeVersion: version,
        protocolVersion: MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION,
        pid: 999_999_999,
        projectDir,
        endpoint,
        startedAt: new Date().toISOString(),
      })}\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  cleanups.push(stop);
  return { frames, stop };
}

it('asks an older daemon to stop and connects to the one of its own release', async () => {
  let replaced!: Promise<Awaited<ReturnType<typeof daemon>>>;
  const older = await daemon('1.0.0', () => {
    replaced = older.stop().then(() => daemon(WRONGSTACK_RUNTIME_VERSION));
  });
  const client = new MailboxProjectServerConnection(projectDir);
  try {
    await client.connect();
    const current = await replaced;
    expect(older.frames).toEqual([
      expect.objectContaining({
        type: 'shutdown',
        reason: 'older-release-replacement',
        authToken: 'project-token',
      }),
    ]);
    expect(current.frames).toEqual([]);
  } finally {
    client.close();
  }
});

it('reuses a daemon of the same release', async () => {
  const same = await daemon(WRONGSTACK_RUNTIME_VERSION);
  const client = new MailboxProjectServerConnection(projectDir);
  try {
    await client.connect();
    expect(same.frames).toEqual([]);
  } finally {
    client.close();
  }
});
