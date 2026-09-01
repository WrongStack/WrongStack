/**
 * The daemon reports an operation that blocked its event loop.
 *
 * SQLite is synchronous and this daemon runs a single event loop, so a slow
 * operation is never slow for its caller alone: every other client of the
 * project queues behind it and can fail with its own call timeout somewhere
 * else entirely. That is exactly how an FTS join-order regression — seconds
 * per `searchSage` under one SQLite build, milliseconds under another — went
 * unnoticed until unrelated ops started tripping the client's 30s timeout.
 *
 * These drive a real daemon over its real socket with the threshold pinned to
 * 0 (`WRONGSTACK_SAGE_SLOW_OP_MS`), because the assertion is about what the
 * process actually writes to stderr.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sageProjectServerEndpoint,
  sageProjectServerMetadataPath,
} from '../src/project-server-endpoint.js';
import type { SageProjectServerMetadata } from '../src/project-server-protocol.js';

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

let projectRoot: string;
let endpoint: string;
let child: ChildProcess | undefined;

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the SAGE daemon');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'sage-slowop-'));
  endpoint = sageProjectServerEndpoint(projectRoot);
});

afterEach(async () => {
  child?.kill();
  child = undefined;
  await new Promise((r) => setTimeout(r, 150));
  await rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('SAGE daemon slow-operation reporting', () => {
  it('names the op, its duration and the queue depth, then throttles repeats', async () => {
    child = spawn(SERVER_LAUNCH.cmd, [...SERVER_LAUNCH.args, '--project-root', projectRoot], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, WRONGSTACK_SAGE_SLOW_OP_MS: '0' },
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const metadataPath = sageProjectServerMetadataPath(projectRoot);
    const metadata = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(metadataPath, 'utf8')) as SageProjectServerMetadata;
      } catch {
        return undefined;
      }
    });

    const socket = await waitFor(
      () =>
        new Promise<net.Socket | undefined>((resolve) => {
          const attempt = net.createConnection(endpoint);
          attempt.once('connect', () => resolve(attempt));
          attempt.once('error', () => resolve(undefined));
        }),
    );

    try {
      const ping = (id: number): void => {
        socket.write(
          `${JSON.stringify({
            type: 'request',
            id,
            op: 'ping',
            args: {},
            meta: { clientId: 'slow-op-test', authToken: metadata.authToken },
          })}\n`,
        );
      };

      ping(1);
      const line = await waitFor(async () =>
        /sage project server: ping took \d+ms \(queued=\d+, clients=\d+\)/.test(stderr)
          ? stderr
          : undefined,
      );
      expect(line).toContain('every client waits behind it');

      // A persistent regression must not flood stderr: the same op stays
      // silent for the throttle window even though it still crosses the
      // (zeroed) threshold.
      const before = stderr.match(/ping took/g)?.length ?? 0;
      ping(2);
      await new Promise((r) => setTimeout(r, 500));
      expect(stderr.match(/ping took/g)?.length ?? 0).toBe(before);
    } finally {
      socket.destroy();
    }
  }, 30_000);
});
