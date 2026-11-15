/**
 * A Chronicle daemon of an older release is replaced, not reused: the client asks it to stop
 * with the project's token and connects to the daemon of its own release that takes over the
 * endpoint. A daemon of the same release is reused as before.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WRONGSTACK_RUNTIME_VERSION } from '@wrongstack/primitives';
import { afterEach, expect, it, vi } from 'vitest';

// Running from src there is no built project-server.js; report it present so the client
// connects to the fake daemons below. The election's own spawns do nothing here.
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const existsSync = (p: fs.PathLike) =>
    String(p).endsWith(`${path.sep}project-server.js`) || real.existsSync(p);
  return { ...real, existsSync, default: { ...real, existsSync } };
});
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const spawn = () => ({ unref() {}, on() {}, once() {} });
  return { ...real, spawn, default: { ...real, spawn } };
});

const { ChronicleProjectServerClient } = await import('../src/project-server-client.js');
const { chronicleProjectServerEndpoint, chronicleProjectServerMetadataPath } = await import(
  '../src/project-server-endpoint.js'
);
const { CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION } = await import(
  '../src/project-server-protocol.js'
);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-older-'));
  const projectDir = path.join(root, '.wrongstack');
  fs.mkdirSync(projectDir, { recursive: true });
  const metadata = chronicleProjectServerMetadataPath(projectDir);
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(metadata, JSON.stringify({ authToken: 'project-token' }));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, projectDir, endpoint: chronicleProjectServerEndpoint(projectDir) };
}

/** A fake daemon of `version` that records frames and answers requests with `answer`. */
async function daemon(
  where: ReturnType<typeof project>,
  version: string,
  answer: string,
  onShutdown?: () => void,
) {
  const frames: Array<Record<string, unknown>> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
        buffer = buffer.slice(nl + 1);
        frames.push(frame);
        if (frame['type'] === 'shutdown') onShutdown?.();
        if (frame['type'] === 'request') {
          socket.write(
            `${JSON.stringify({ type: 'response', id: frame['id'], ok: true, result: answer })}\n`,
          );
        }
      }
    });
    socket.write(
      `${JSON.stringify({
        type: 'hello',
        runtimeVersion: version,
        protocolVersion: CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION,
        pid: 999_999_999,
        projectRoot: where.root,
        projectDir: where.projectDir,
        chronicleDirectory: where.projectDir,
        endpoint: where.endpoint,
        startedAt: new Date().toISOString(),
      })}\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(where.endpoint, resolve));
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  cleanups.push(() => void stop());
  return { frames, stop };
}

function client(where: ReturnType<typeof project>) {
  const value = new ChronicleProjectServerClient({
    projectRoot: where.root,
    globalRoot: where.root,
    projectId: 'chronicle-older',
    projectDir: where.projectDir,
    workspaceId: 'chronicle-older',
  });
  cleanups.push(() => void value.close());
  return value;
}

it('asks an older daemon to stop and uses the one of its own release that replaces it', async () => {
  const where = project();
  let replaced!: Promise<unknown>;
  const older = await daemon(where, '1.0.0', 'older', () => {
    replaced = older.stop().then(() => daemon(where, WRONGSTACK_RUNTIME_VERSION, 'current'));
  });
  const result = await client(where).call('ping', {}, { timeoutMs: 8_000 });
  await replaced;
  expect(result).toBe('current');
  expect(older.frames).toEqual([
    expect.objectContaining({
      type: 'shutdown',
      reason: 'older-release-replacement',
      authToken: 'project-token',
    }),
  ]);
});

it('reuses a daemon of the same release', async () => {
  const where = project();
  const same = await daemon(where, WRONGSTACK_RUNTIME_VERSION, 'same');
  expect(await client(where).call('ping', {}, { timeoutMs: 8_000 })).toBe('same');
  expect(same.frames.map((frame) => frame['type'])).toEqual(['request']);
});
