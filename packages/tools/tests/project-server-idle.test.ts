import { type ChildProcess, spawn } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectIndexServerEndpoint } from '../src/codebase-index/project-server-endpoint.js';

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
    // Capture the daemon's stderr so a future failure discriminates its
    // mechanism: an unhandled-rejection teardown crash exits non-zero with a
    // stack on stderr, a swallowed rmSync failure exits 0 with the file left
    // behind. stdio:'ignore' recorded neither.
    const stderrLogPath = path.join(projectRoot, 'daemon-stderr.log');
    const stderrFd = fsSync.openSync(stderrLogPath, 'w');
    const child = spawn(
      process.execPath,
      [distServer, '--project-root', projectRoot, '--index-dir', indexDir],
      {
        env: {
          ...process.env,
          WRONGSTACK_INDEX_SERVER_IDLE_MS: '350',
          WRONGSTACK_INDEX_SERVER_CLIENT_LEASE_MS: '2000',
        },
        stdio: ['ignore', 'ignore', stderrFd],
        windowsHide: true,
      },
    );

    try {
      await waitUntil(() => fsSync.existsSync(metadataPath));
      const socket = await connect(endpoint);
      socket.destroy();
      await waitForExit(child);
      fsSync.closeSync(stderrFd);
      const stderrText = fsSync.readFileSync(stderrLogPath, 'utf8');
      expect(child.exitCode, `daemon exit ${child.exitCode}; stderr: ${stderrText}`).toBe(0);
      expect(fsSync.existsSync(metadataPath), `metadata survived exit; stderr: ${stderrText}`).toBe(
        false,
      );
    } finally {
      try {
        fsSync.closeSync(stderrFd);
      } catch {
        /* closed after a successful waitForExit */
      }
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes metadata and exits cleanly when a teardown step throws', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-index-fault-'));
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
    const metadataPath = path.join(indexDir, 'server.json');
    const stderrLogPath = path.join(projectRoot, 'daemon-stderr.log');
    const stderrFd = fsSync.openSync(stderrLogPath, 'w');
    const child = spawn(
      process.execPath,
      [distServer, '--project-root', projectRoot, '--index-dir', indexDir],
      {
        env: {
          ...process.env,
          WRONGSTACK_INDEX_SERVER_IDLE_MS: '350',
          WRONGSTACK_INDEX_SERVER_CLIENT_LEASE_MS: '2000',
          // Inject a synchronous teardown failure exactly where
          // indexStorePool.closeAll() sits: before metadata removal. The
          // shutdown-ordering contract: report it, still remove the metadata,
          // and exit 0 — an unawaited `void stop()` rejection once killed the
          // process with the file still on disk (a stale-server claim that
          // blocks the next daemon from reclaiming the endpoint).
          WRONGSTACK_INDEX_SERVER_FAULT: 'teardown-throw',
        },
        stdio: ['ignore', 'ignore', stderrFd],
        windowsHide: true,
      },
    );

    try {
      await waitUntil(() => fsSync.existsSync(metadataPath));
      const socket = await connect(endpoint);
      socket.destroy();
      await waitForExit(child);
      fsSync.closeSync(stderrFd);
      const stderrText = fsSync.readFileSync(stderrLogPath, 'utf8');
      expect(child.exitCode, `daemon exit ${child.exitCode}; stderr: ${stderrText}`).toBe(0);
      expect(stderrText).toContain('teardown error');
      expect(fsSync.existsSync(metadataPath), `metadata survived exit; stderr: ${stderrText}`).toBe(
        false,
      );
    } finally {
      try {
        fsSync.closeSync(stderrFd);
      } catch {
        /* closed after a successful waitForExit */
      }
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps a heartbeating client alive, then expires its ghost socket before idle exit', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-index-lease-'));
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
    const metadataPath = path.join(indexDir, 'server.json');
    // Same evidence capture as the idle-exit case above: exit code + stderr
    // discriminate a teardown crash from a swallowed rmSync failure.
    const stderrLogPath = path.join(projectRoot, 'daemon-stderr.log');
    const stderrFd = fsSync.openSync(stderrLogPath, 'w');
    const heartbeatClient = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./fixtures/project-server-heartbeat.mjs', import.meta.url)),
        endpoint,
        metadataPath,
        path.join(projectRoot, 'stop-heartbeat'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let clientOutput = '';
    let clientErrors = '';
    heartbeatClient.stdout.on('data', (chunk) => {
      clientOutput += chunk.toString();
    });
    heartbeatClient.stderr.on('data', (chunk) => {
      clientErrors += chunk.toString();
    });
    let child: ChildProcess | undefined;
    try {
      await waitUntil(() => clientOutput.includes('WAITING'));
      child = spawn(
        process.execPath,
        [distServer, '--project-root', projectRoot, '--index-dir', indexDir],
        {
          env: {
            ...process.env,
            WRONGSTACK_INDEX_SERVER_IDLE_MS: '150',
            WRONGSTACK_INDEX_SERVER_CLIENT_LEASE_MS: '200',
          },
          stdio: ['ignore', 'ignore', stderrFd],
          windowsHide: true,
        },
      );

      await waitUntil(() => fsSync.existsSync(metadataPath));
      await waitUntil(() => clientOutput.includes('READY')).catch((error) => {
        throw new Error(
          `${String(error)}; client exit=${heartbeatClient.exitCode}; output=${clientOutput}; stderr=${clientErrors}; daemon stderr=${fsSync.readFileSync(stderrLogPath, 'utf8')}`,
        );
      });
      // Reproduce the worker stall that used to starve its local heartbeat.
      const blockedUntil = Date.now() + 350;
      while (Date.now() < blockedUntil) {
        /* real client keeps sending */
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(child.exitCode).toBeNull();
      expect(fsSync.existsSync(metadataPath)).toBe(true);

      await fs.writeFile(path.join(projectRoot, 'stop-heartbeat'), 'stop');
      await Promise.all([waitForExit(heartbeatClient), waitForExit(child)]);
      fsSync.closeSync(stderrFd);
      const stderrText = fsSync.readFileSync(stderrLogPath, 'utf8');
      expect(clientOutput).toContain('CLOSED');
      expect(heartbeatClient.exitCode).toBe(0);
      expect(child.exitCode, `daemon exit ${child.exitCode}; stderr: ${stderrText}`).toBe(0);
      expect(fsSync.existsSync(metadataPath), `metadata survived exit; stderr: ${stderrText}`).toBe(
        false,
      );
    } finally {
      try {
        fsSync.closeSync(stderrFd);
      } catch {
        /* closed after a successful waitForExit */
      }
      if (heartbeatClient.exitCode === null && heartbeatClient.signalCode === null) {
        heartbeatClient.kill();
        await waitForExit(heartbeatClient);
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        await waitForExit(child);
      }
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
