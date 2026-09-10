/**
 * Shutdown answers in-flight requests instead of stranding them.
 *
 * `stop()` used to destroy client sockets while dispatches were still running:
 * an in-flight caller saw nothing but a bare connection close (its response
 * can no longer be written once the socket is destroyed) and hung until its
 * own call timeout, while `store.dispose()` closed SQLite under the live
 * operation. The candidate-accept file lock gives this suite a deterministic
 * way to park one dispatch mid-flight: the lock is held from the test process
 * with the same `withFileLock` protocol the server uses, `acceptCandidate`
 * blocks acquiring it, and `ping`'s `pendingRequests` proves it is queued
 * before shutdown is requested.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sageProjectServerEndpoint,
  sageProjectServerMetadataPath,
} from '../src/project-server-endpoint.js';
import type { SageProjectServerMetadata } from '../src/project-server-protocol.js';

interface ServerResponseFrame {
  type: 'response';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  errorName?: string | undefined;
}

const sageTestDir = dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = join(sageTestDir, '..', 'dist', 'project-server.js');
const SRC_ENTRY = join(sageTestDir, '..', 'src', 'project-server.ts');

function resolveServerEntry(): { cmd: string; args: string[] } {
  try {
    accessSync(DIST_ENTRY);
    return { cmd: process.execPath, args: [DIST_ENTRY] };
  } catch {
    return { cmd: process.execPath, args: ['--import', 'tsx', SRC_ENTRY] };
  }
}

const SERVER_LAUNCH = resolveServerEntry();

interface Harness {
  metadata: SageProjectServerMetadata;
  /** First response frame per id — convenient for waitFor loops. */
  responses: Map<number, ServerResponseFrame>;
  /** Every response frame per id — the suite asserts on frame COUNTS too. */
  frames: Map<number, ServerResponseFrame[]>;
  request(body: Record<string, unknown>): void;
  closed: Promise<void>;
}

let projectRoot: string;
let child: ChildProcess | undefined;

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the SAGE daemon');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startServer(): Promise<Harness> {
  child = spawn(SERVER_LAUNCH.cmd, [...SERVER_LAUNCH.args, '--project-root', projectRoot], {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
    env: { ...process.env, WRONGSTACK_SAGE_SERVER_IDLE_MS: '600000' },
  });

  const metadata = await waitFor(async () => {
    try {
      return JSON.parse(
        await readFile(sageProjectServerMetadataPath(projectRoot), 'utf8'),
      ) as SageProjectServerMetadata;
    } catch {
      return undefined;
    }
  });

  const socket = await waitFor(
    () =>
      new Promise<net.Socket | undefined>((resolve) => {
        const attempt = net.createConnection(sageProjectServerEndpoint(projectRoot));
        attempt.once('connect', () => resolve(attempt));
        attempt.once('error', () => resolve(undefined));
      }),
  );
  socket.setEncoding('utf8');

  const responses = new Map<number, ServerResponseFrame>();
  const frames = new Map<number, ServerResponseFrame[]>();
  let buffer = '';
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
  });
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as ServerResponseFrame;
        if (message.type !== 'response') continue;
        if (!responses.has(message.id)) responses.set(message.id, message);
        const list = frames.get(message.id);
        if (list) list.push(message);
        else frames.set(message.id, [message]);
      } catch {
        // Malformed frames are not what this suite asserts on.
      }
    }
  });

  return {
    metadata,
    responses,
    frames,
    request: (body: Record<string, unknown>) => socket.write(`${JSON.stringify(body)}\n`),
    closed,
  };
}

describe('SAGE daemon shutdown answers in-flight requests', () => {
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'sage-stop-drain-'));
  });

  afterEach(async () => {
    child?.kill();
    child = undefined;
    await new Promise((r) => setTimeout(r, 150));
    await rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('rejects an in-flight request cleanly before the socket closes', async () => {
    const h = await startServer();
    const meta = { clientId: 'stop-drain-test', authToken: h.metadata.authToken };

    h.request({
      type: 'request',
      id: 1,
      op: 'createCandidate',
      args: { input: { text: 'stop-drain regression candidate', kind: 'fact' } },
      meta,
    });
    const created = await waitFor(async () => {
      const r = h.responses.get(1);
      if (!r) return undefined;
      expect(r.ok).toBe(true);
      return r.result as { id: string };
    });

    // Park the accept dispatch mid-flight: the test process holds the same
    // candidate-accept lock the server's accept path waits on.
    let releaseHold: (() => void) | undefined;
    const held = withFileLock(
      join(projectRoot, '.wrongstack', 'memories', 'locks', `candidate-accept-${created.id}`),
      () =>
        new Promise<void>((resolve) => {
          releaseHold = resolve;
        }),
      { timeoutMs: 30_000, staleMs: 30 * 60_000 },
    ).catch(() => undefined);

    h.request({
      type: 'request',
      id: 2,
      op: 'acceptCandidate',
      args: { candidateId: created.id },
      meta,
    });

    // Deterministic in-flight proof: ping sees itself plus the blocked accept.
    let pingId = 100;
    await waitFor(async () => {
      const id = pingId++;
      h.request({ type: 'request', id, op: 'ping', args: {}, meta });
      const r = await waitFor(async () => h.responses.get(id), 5_000);
      if (!r.ok) throw new Error(`ping failed during in-flight wait: ${r.error}`);
      return (r.result as { pendingRequests: number }).pendingRequests >= 2 ? r : undefined;
    });

    h.request({ type: 'shutdown', id: 200, reason: 'test', authToken: h.metadata.authToken });
    await Promise.race([h.closed, new Promise((r) => setTimeout(r, 15_000))]);

    const inFlight = h.responses.get(2);
    expect(inFlight).toBeDefined();
    expect(inFlight?.ok).toBe(false);
    expect(String(inFlight?.error)).toMatch(/stopping/i);
    expect(inFlight?.errorName).toBe('SageServerStoppingError');
    // Exactly one frame: the stopping rejection. The later abort/lock-error
    // path writes to an already-destroyed socket and must stay silent.
    expect(h.frames.get(2)).toHaveLength(1);
    // The shutdown ack itself still arrived.
    expect(h.responses.get(200)?.ok).toBe(true);

    releaseHold?.();
    await held;
  }, 60_000);

  it('still delivers real responses for requests that settle before shutdown', async () => {
    const h = await startServer();
    const meta = { clientId: 'stop-drain-settled', authToken: h.metadata.authToken };

    h.request({ type: 'request', id: 1, op: 'ping', args: {}, meta });
    const ping = await waitFor(async () => h.responses.get(1));
    expect(ping.ok).toBe(true);

    // A settled request is no longer "unsettled": shutdown must not append a
    // stopping rejection after its real response.
    h.request({ type: 'shutdown', id: 2, reason: 'test', authToken: h.metadata.authToken });
    await Promise.race([h.closed, new Promise((r) => setTimeout(r, 15_000))]);

    expect(h.frames.get(1)).toHaveLength(1);
    expect(h.frames.get(1)?.[0]?.ok).toBe(true);
    expect(h.responses.get(2)?.ok).toBe(true);
  }, 60_000);
});
