import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getImagePreviewCacheSize,
  loadCachedImagePreview,
} from '../src/graphics/image-preview-cache.js';
import { ALT_SCREEN_OFF } from '../src/mouse.js';
import { createExitOrchestrator } from '../src/run-tui-exits.js';
import type { RunTuiOptions } from '../src/run-tui-options.js';
import { BRACKETED_PASTE_OFF, SYNC_OUTPUT_OFF } from '../src/terminal-modes.js';

vi.mock('../src/run-tui-session.js', () => ({
  setupTuiSession: () => ({
    register: () => Promise.resolve(),
    unregister: () => undefined,
  }),
}));

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let tmpDir = '';
let samplePngPath = '';

interface Harness {
  orch: ReturnType<typeof createExitOrchestrator>;
  writes: string[];
  disposeSyncStdout: ReturnType<typeof vi.fn>;
  resolvedCodes: number[];
  awaitResolved: () => Promise<number>;
}

function createHarness(): Harness {
  const writes: string[] = [];
  const stdout = {
    write: vi.fn((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }),
  } as unknown as NodeJS.WriteStream;

  const inkStdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  const lifecycle = {
    release: vi.fn(),
    reset: vi.fn(),
  } as never;

  const disposeSyncStdout = vi.fn();
  const opts = {
    projectRoot: process.cwd(),
    events: new EventBus(),
    agent: {
      ctx: {
        agentId: 'test-agent',
        meta: {},
        session: {
          id: 'sess-exit-test',
          close: vi.fn(() => Promise.resolve()),
          flushSync: vi.fn(),
        },
      },
    },
  } as unknown as RunTuiOptions;

  const orch = createExitOrchestrator({
    opts,
    stdout,
    inkStdin,
    lifecycle,
    stopTitle: vi.fn(),
    restoreTrace: vi.fn(),
    disposeSyncStdout,
  });
  orch.markAlternateScreenActive();

  const resolvedCodes: number[] = [];
  let resolvePromise!: (code: number) => void;
  const runPromise = new Promise<number>((resolve) => {
    resolvePromise = resolve;
  });
  orch.attachResolve((code) => {
    resolvedCodes.push(code);
    resolvePromise(code);
  });

  // Seed image preview cache through the real loader to verify every exit path clears it.
  loadCachedImagePreview(samplePngPath);
  expect(getImagePreviewCacheSize()).toBe(1);

  return {
    orch,
    writes,
    disposeSyncStdout,
    resolvedCodes,
    awaitResolved: () => runPromise,
  };
}

function assertSyncOffBeforeAltScreenOff(writes: readonly string[]): void {
  const combined = writes.join('');
  const syncOffIdx = combined.indexOf(SYNC_OUTPUT_OFF);
  const pasteOffIdx = combined.indexOf(BRACKETED_PASTE_OFF);
  const altOffIdx = combined.indexOf(ALT_SCREEN_OFF);
  expect(syncOffIdx).toBeGreaterThanOrEqual(0);
  expect(pasteOffIdx).toBeGreaterThan(syncOffIdx);
  expect(altOffIdx).toBeGreaterThan(syncOffIdx);
}

describe('createExitOrchestrator DECSET 2026 teardown across all 6 exit paths', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wstack-tui-exits-'));
    samplePngPath = join(tmpDir, 'dot.png');
    writeFileSync(samplePngPath, ONE_PIXEL_PNG);
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. natural settle() flushes sync stdout, clears image cache, and emits SYNC_OUTPUT_OFF before ALT_SCREEN_OFF', async () => {
    const h = createHarness();
    h.orch.settle(0);
    const code = await h.awaitResolved();
    expect(code).toBe(0);
    expect(h.disposeSyncStdout).toHaveBeenCalledTimes(1);
    expect(getImagePreviewCacheSize()).toBe(0);
    assertSyncOffBeforeAltScreenOff(h.writes);
  });

  it('2. requestExit() unmounts Ink -> settle() and emits SYNC_OUTPUT_OFF before ALT_SCREEN_OFF', async () => {
    const h = createHarness();
    h.orch.setInkInstance({
      unmount: () => {
        h.orch.settle(h.orch.getRunExitCode());
      },
    });
    h.orch.requestExit(17);
    const code = await h.awaitResolved();
    expect(code).toBe(17);
    expect(h.disposeSyncStdout).toHaveBeenCalledTimes(1);
    expect(getImagePreviewCacheSize()).toBe(0);
    assertSyncOffBeforeAltScreenOff(h.writes);
  });

  it('3. external SIGTERM signal tears down durably and emits SYNC_OUTPUT_OFF before ALT_SCREEN_OFF', async () => {
    const beforeListeners = new Set(process.listeners('SIGTERM'));
    const h = createHarness();
    const added = process.listeners('SIGTERM').find((fn) => !beforeListeners.has(fn));
    expect(added).toBeDefined();

    added?.('SIGTERM');
    const code = await h.awaitResolved();
    expect(code).toBe(143);
    expect(h.disposeSyncStdout).toHaveBeenCalledTimes(1);
    expect(getImagePreviewCacheSize()).toBe(0);
    assertSyncOffBeforeAltScreenOff(h.writes);
  });

  it('4. rapid SIGINT (2x Ctrl+C) force-exit emits SYNC_OUTPUT_OFF before ALT_SCREEN_OFF prior to process.exit(130)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const beforeListeners = new Set(process.listeners('SIGINT'));
    const h = createHarness();
    const added = process.listeners('SIGINT').find((fn) => !beforeListeners.has(fn));
    expect(added).toBeDefined();

    added?.('SIGINT');
    added?.('SIGINT');

    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(h.disposeSyncStdout).toHaveBeenCalledTimes(1);
    expect(getImagePreviewCacheSize()).toBe(0);
    assertSyncOffBeforeAltScreenOff(h.writes);
  });

  it('5. raw-stdin Ctrl+C watcher (2x 0x03) force-exit emits SYNC_OUTPUT_OFF before ALT_SCREEN_OFF prior to process.exit(130)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const h = createHarness();

    h.orch.onRawCtrlC(Buffer.from([0x03]));
    h.orch.onRawCtrlC('\x03');

    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(h.disposeSyncStdout).toHaveBeenCalledTimes(1);
    expect(getImagePreviewCacheSize()).toBe(0);
    assertSyncOffBeforeAltScreenOff(h.writes);
  });

  it('6. synchronous process "exit" handler emits SYNC_OUTPUT_OFF before ALT_SCREEN_OFF and detaches cleanly', async () => {
    const beforeExitListeners = new Set(process.listeners('exit'));
    const h = createHarness();
    const exitListener = process.listeners('exit').find((fn) => !beforeExitListeners.has(fn));
    expect(exitListener).toBeDefined();

    exitListener?.(0);

    expect(h.disposeSyncStdout).toHaveBeenCalledTimes(1);
    expect(getImagePreviewCacheSize()).toBe(0);
    assertSyncOffBeforeAltScreenOff(h.writes);

    // Subsequent settle() detaches listeners without double-writing SYNC_OUTPUT_OFF.
    const countAfterExit = h.writes.length;
    h.orch.settle(0);
    await h.awaitResolved();
    expect(h.writes.length).toBe(countAfterExit);
  });
});
