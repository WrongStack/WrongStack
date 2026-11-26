/**
 * A response line that is valid JSON but not an object (`null`, a number, a
 * string, a boolean) is the same malformed frame as bad JSON. The client
 * destroys the socket and fails the in-flight call. It must not throw
 * `message.type` on null, and it must not leave the call waiting out its
 * timeout.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const existsSync = (p: fs.PathLike) =>
    String(p).endsWith(`${path.sep}project-server.js`) ||
    String(p).endsWith('/project-server.js') ||
    real.existsSync(p);
  return { ...real, existsSync, default: { ...real, existsSync } };
});

const { ChronicleProjectServerClient } = await import('../src/project-server-client.js');
const { chronicleProjectServerEndpoint } = await import('../src/project-server-endpoint.js');
const { CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION } = await import(
  '../src/project-server-protocol.js'
);

(
  ChronicleProjectServerClient.prototype as unknown as { spawnDetachedServer(): void }
).spawnDetachedServer = () => {};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function pingAgainst(frame: string): Promise<{ outcome: string; crashes: string[] }> {
  const crashes: string[] = [];
  const onUncaught = (error: Error) => crashes.push(`${error.name}: ${error.message}`);
  const onRejection = (error: unknown) => {
    crashes.push(
      error instanceof Error
        ? `rejection ${error.name}: ${error.message}`
        : `rejection ${String(error)}`,
    );
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-client-null-'));
  const projectDir = path.join(root, '.wrongstack');
  fs.mkdirSync(projectDir, { recursive: true });
  const endpoint = chronicleProjectServerEndpoint(projectDir);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.write(
      `${JSON.stringify({
        type: 'hello',
        protocolVersion: CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION,
        pid: process.pid,
        projectRoot: root,
        projectDir,
        chronicleDirectory: projectDir,
        endpoint,
        startedAt: new Date().toISOString(),
      })}\n`,
    );
    socket.on('data', () => {
      socket.write(`${frame}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  const client = new ChronicleProjectServerClient({
    projectRoot: root,
    globalRoot: root,
    projectId: 'chronicle-client-null',
    projectDir,
    workspaceId: 'chronicle-client-null',
  });
  cleanups.push(() => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
    void client.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  try {
    await client.call('ping', {}, { timeoutMs: 700 });
    return { outcome: 'resolved', crashes };
  } catch (error) {
    return {
      outcome: error instanceof Error ? error.message : String(error),
      crashes,
    };
  }
}

it('fails a non-object Chronicle response closed', async () => {
  const control = await pingAgainst('{');
  expect(control.crashes).toEqual([]);
  expect(control.outcome).toBe('Chronicle project server connection closed');

  for (const frame of ['null', '1', '"x"', 'true']) {
    const problem = await pingAgainst(frame);
    expect(problem.crashes, frame).toEqual([]);
    expect(problem.outcome, frame).toBe('Chronicle project server connection closed');
  }
});
