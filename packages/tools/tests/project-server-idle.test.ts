import { type ChildProcess, spawn } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectIndexServerEndpoint } from '../src/codebase-index/project-server-endpoint.js';
import { encodeProjectServerMessage } from '../src/codebase-index/project-server-protocol.js';

const distServer = fileURLToPath(
  new URL('../dist/codebase-index/project-server.js', import.meta.url),
);
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
const distReady = fsSync.existsSync(distServer) && fsSync.existsSync(coreDist);

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('project server did not exit'));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}

async function connect(endpoint: string, timeoutMs = 5_000): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError ?? new Error(`condition timed out connecting to ${endpoint}`);
}

describe.skipIf(!distReady)('project index server idle lifecycle', () => {
  it('exits and removes metadata after the final client disconnects', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-index-idle-'));
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
    const metadataPath = path.join(indexDir, 'server.json');
    const child = spawn(
      process.execPath,
      [distServer, '--project-root', projectRoot, '--index-dir', indexDir],
      {
        env: {
          ...process.env,
          WRONGSTACK_INDEX_SERVER_IDLE_MS: '350',
          WRONGSTACK_INDEX_SERVER_CLIENT_LEASE_MS: '2000',
        },
        stdio: 'ignore',
        windowsHide: true,
      },
    );

    try {
      await waitUntil(() => fsSync.existsSync(metadataPath));
      const socket = await connect(endpoint);
      socket.destroy();
      await waitForExit(child);
      expect(fsSync.existsSync(metadataPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps a heartbeating client alive, then expires its ghost socket before idle exit', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-index-lease-'));
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
    const metadataPath = path.join(indexDir, 'server.json');
    const child = spawn(
      process.execPath,
      [distServer, '--project-root', projectRoot, '--index-dir', indexDir],
      {
        env: {
          ...process.env,
          WRONGSTACK_INDEX_SERVER_IDLE_MS: '150',
          WRONGSTACK_INDEX_SERVER_CLIENT_LEASE_MS: '200',
        },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    let socket: net.Socket | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      await waitUntil(() => fsSync.existsSync(metadataPath));
      socket = await connect(endpoint);
      socket.on('error', () => {});
      socket.resume();
      const socketClosed = new Promise<void>((resolve) => socket?.once('close', () => resolve()));
      let requestId = 1;
      heartbeat = setInterval(() => {
        socket?.write(encodeProjectServerMessage({ type: 'ping', id: requestId++ }));
      }, 40);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(child.exitCode).toBeNull();
      expect(fsSync.existsSync(metadataPath)).toBe(true);

      clearInterval(heartbeat);
      heartbeat = undefined;
      await Promise.all([socketClosed, waitForExit(child)]);
      expect(socket.destroyed).toBe(true);
      expect(fsSync.existsSync(metadataPath)).toBe(false);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      socket?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
