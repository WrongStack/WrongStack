// TEMP PROBE — validates the in-process daemon mechanism before the real harness.
// Import the tools codebase-index daemon with a synthetic argv, drive its socket,
// and confirm (a) it binds in-process, (b) hello/ping work with the metadata token,
// (c) shutdown closes the listener and removes metadata.
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  projectIndexServerEndpoint,
  projectIndexServerMetadataPath,
} from '../src/codebase-index/project-server-endpoint.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs
      .rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
      .catch(() => {});
  }
});

it('probe: in-process tools daemon lifecycle', { timeout: 60_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-probe-root-'));
  const indexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-probe-index-'));
  roots.push(root, indexDir);

  process.env.WRONGSTACK_INDEX_SERVER_IDLE_MS = '60000';

  const realArgv = process.argv;
  try {
    process.argv = [
      realArgv[0] ?? 'node',
      'probe',
      '--project-root',
      root,
      '--index-dir',
      indexDir,
    ];
    const daemonModule = '../src/codebase-index/project-server.js?probe=1';
    await import(daemonModule);
  } finally {
    process.argv = realArgv;
  }

  // Metadata file appears once the daemon wins the bind.
  const metadataPath = projectIndexServerMetadataPath(root, indexDir);
  let metadata: { authToken: string; pid: number } | undefined;
  for (let i = 0; i < 400; i++) {
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as typeof metadata;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  expect(metadata).toBeTruthy();
  expect(metadata!.authToken).toMatch(/^[0-9a-f]{32}$/);
  expect(metadata!.pid).toBe(process.pid);

  // Connect and read frames (hello, index-state).
  const endpoint = projectIndexServerEndpoint(root, indexDir);
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection(endpoint);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  socket.setEncoding('utf8');
  const frames: Record<string, unknown>[] = [];
  const framePromise = new Promise<void>((resolve) => {
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic newline framing loop
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === 'hello') resolve();
      }
    });
  });
  await Promise.race([
    framePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('no hello frame')), 15_000)),
  ]);
  expect(frames.find((f) => f.type === 'hello')).toMatchObject({
    pid: process.pid,
    projectRoot: root,
  });

  // Ping with the token from metadata.
  const ping = new Promise<Record<string, unknown>>((resolve) => {
    const onData = (chunk: string) => {
      let nl: number;
      let buffer = chunk;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic newline framing loop
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.type === 'response' && frame.id === 99) {
          socket.off('data', onData);
          resolve(frame);
        }
      }
    };
    socket.on('data', onData);
  });
  socket.write(`${JSON.stringify({ type: 'ping', id: 99, authToken: metadata!.authToken })}\n`);
  const pingResponse = (await Promise.race([
    ping,
    new Promise((_, reject) => setTimeout(() => reject(new Error('no ping response')), 15_000)),
  ])) as { ok?: boolean; result?: { clients?: number; pid?: number } };
  expect(pingResponse.ok).toBe(true);
  expect(pingResponse.result?.clients).toBe(1);

  // Shutdown: response ok, then the listener must be closed and metadata gone.
  const shutdown = new Promise<Record<string, unknown>>((resolve) => {
    const onData = (chunk: string) => {
      let nl: number;
      let buffer = chunk;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic newline framing loop
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.type === 'response' && frame.id === 100) {
          socket.off('data', onData);
          resolve(frame);
        }
      }
    };
    socket.on('data', onData);
  });
  socket.write(
    `${JSON.stringify({ type: 'shutdown', id: 100, reason: 'probe', authToken: metadata!.authToken })}\n`,
  );
  const shutdownResponse = (await Promise.race([
    shutdown,
    new Promise((_, reject) => setTimeout(() => reject(new Error('no shutdown response')), 15_000)),
  ])) as { ok?: boolean };
  expect(shutdownResponse.ok).toBe(true);

  // Listener must refuse new connections once stopped.
  await expect(
    new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(endpoint);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    }),
  ).rejects.toThrow();

  // Metadata must be removed by the owner.
  await expect(fs.access(metadataPath)).rejects.toThrow();
});
