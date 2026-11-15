import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WrongMemoryClient } from '../src/client.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('WrongMemoryClient timeout overflow guard', () => {
  it('chunks timeoutMs above 2_147_483_647ms without scheduling an overflowing timer', async () => {
    const origSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: Parameters<typeof setTimeout>[0],
      delay?: number,
      ...args: unknown[]
    ) => {
      delays.push(Number(delay ?? 0));
      return origSetTimeout(fn, delay, ...args);
    }) as typeof setTimeout;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-wm-ovf-'));
    tempRoots.push(root);
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'runtime', 'endpoint.json'),
      JSON.stringify({
        pid: process.pid,
        endpoint: '\\\\.\\pipe\\ws-nonexistent-test-pipe-12345',
        startedAt: new Date().toISOString(),
      }),
    );
    fs.writeFileSync(path.join(root, 'runtime', 'token'), 'test-token');

    try {
      await WrongMemoryClient.connect({
        dataRoot: root,
        timeoutMs: 2_147_483_648,
      }).catch(() => undefined);
      expect(delays.length).toBeGreaterThan(0);
      expect(delays.every((d) => d >= 0 && d <= 2_147_483_647)).toBe(true);
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
    }
  });
});
