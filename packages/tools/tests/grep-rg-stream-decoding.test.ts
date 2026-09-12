import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRgDetectionForTests, __setRgAvailableForTests, grepTool } from '../src/grep.js';
import { type Sandbox, mkSandbox, newSignal } from './fixtures.js';

/**
 * Regression test for the rg-path stream decoding in `runRgStream`.
 *
 * The other grep tests tolerate either backend (`expect(['rg','native'])`),
 * because ripgrep is absent on stock Windows CI — so the rg path is otherwise
 * never exercised. `grep.ts` is also excluded from the coverage run, which
 * left the F4 fix to that path (raw `chunk.toString()` → `StringDecoder`)
 * unpinned. This file mocks `node:child_process` so `runRgStream` runs against
 * a controllable child and the chunk boundaries can be forced.
 */

/** Minimal structural shape of the fake stdout stream `grep.ts` consumes. */
interface FakeStream {
  on(event: string, listener: (chunk: Buffer) => void): void;
  off(event: string, listener: (chunk: Buffer) => void): void;
  emit(event: string, ...args: unknown[]): boolean;
  pause(): void;
  resume(): void;
  destroy(): void;
}

/** Minimal structural shape of the fake child process `grep.ts` consumes. */
interface FakeChild {
  stdout: FakeStream;
  stderr: null;
  exitCode: number | null;
  kill(signal?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): boolean;
}

const H = vi.hoisted(() => ({
  chunks: [] as Buffer[],
  spawnCalls: [] as unknown[][],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      H.spawnCalls.push(args);
      const child = new EventEmitter() as unknown as FakeChild;
      const stdout = new EventEmitter() as unknown as FakeStream;
      stdout.pause = () => {};
      stdout.resume = () => {};
      stdout.destroy = () => {};
      child.stdout = stdout;
      child.stderr = null;
      child.exitCode = null;
      child.kill = () => {
        child.exitCode = 0;
        child.emit('close', 0);
      };
      // Emit after runRgStream has attached its handlers.
      setImmediate(() => {
        for (const chunk of H.chunks) stdout.emit('data', chunk);
        child.exitCode = 0;
        child.emit('close', 0);
      });
      return child;
    },
  };
});

describe('grep rg path — stream chunk decoding', () => {
  let sb: Sandbox;

  beforeEach(async () => {
    H.chunks = [];
    H.spawnCalls = [];
    __setRgAvailableForTests(true); // route through runRgStream (no real rg needed)
    sb = await mkSandbox();
  });

  afterEach(async () => {
    __resetRgDetectionForTests();
    await sb.cleanup();
  });

  it('decodes a multi-byte character split across two rg output chunks', async () => {
    // "…:1:x" | 0xC3   then   0xA9 | "\n"  — 'é' straddles the chunk boundary.
    const file = path.join(sb.dir, 'a.txt');
    H.chunks = [
      Buffer.concat([Buffer.from(`${file}:1:x`, 'utf8'), Buffer.from([0xc3])]),
      Buffer.from([0xa9, 0x0a]),
    ];

    const out = await grepTool.execute({ pattern: 'é', output_mode: 'content' }, sb.ctx, {
      signal: newSignal(),
    });

    expect(out.used).toBe('rg');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toContain('xé');
    expect(out.matches[0]).not.toContain('\uFFFD');
  });

  it('decodes a 4-byte astral character split across two rg output chunks', async () => {
    const file = path.join(sb.dir, 'b.txt');
    const emoji = Buffer.from('😀', 'utf8'); // f0 9f 98 80
    H.chunks = [
      Buffer.concat([Buffer.from(`${file}:2:y`, 'utf8'), emoji.subarray(0, 2)]),
      Buffer.concat([emoji.subarray(2), Buffer.from('\n', 'utf8')]),
    ];

    const out = await grepTool.execute({ pattern: 'y', output_mode: 'content' }, sb.ctx, {
      signal: newSignal(),
    });

    expect(out.used).toBe('rg');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toContain('y😀');
    expect(out.matches[0]).not.toContain('\uFFFD');
  });

  it('assembles multiple complete lines spanning chunk boundaries', async () => {
    const file = path.join(sb.dir, 'c.txt');
    H.chunks = [
      Buffer.from(`${file}:1:alpha\n${file}:2:be`, 'utf8'),
      Buffer.from(`ta\n${file}:3:gamma\n`, 'utf8'),
    ];

    const out = await grepTool.execute({ pattern: 'a', output_mode: 'content' }, sb.ctx, {
      signal: newSignal(),
    });

    expect(out.matches).toEqual(['c.txt:1:alpha', 'c.txt:2:beta', 'c.txt:3:gamma']);
    expect(out.count).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it('count mode parses per-file tallies streamed in separate chunks', async () => {
    const file = path.join(sb.dir, 'd.txt');
    H.chunks = [Buffer.from(`${file}:7\n`, 'utf8')];

    const out = await grepTool.execute({ pattern: 'x', output_mode: 'count' }, sb.ctx, {
      signal: newSignal(),
    });

    expect(out.used).toBe('rg');
    expect(out.matches).toEqual(['d.txt:7']);
    expect(out.count).toBe(7);
  });
});
