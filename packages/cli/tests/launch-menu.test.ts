/**
 * Tests for `boot/launch-menu.ts` — the interactive launch menu.
 *
 * Three concerns covered:
 *   1. shouldSkipMenu  — pure predicate, no I/O.
 *   2. runLaunchMenu   — readLine mock, summary gate, port/host prompts,
 *                        cancellation, and the default-port fallback.
 *   3. applyLaunchMenuToArgv — pure argv transformation.
 *   4. toPersistedMenuChoice / persistMenuChoice — persistence shape
 *      and port-range validation.
 *
 * The TTY predicate (`isStdinTTY()`) is satisfied by default because
 * vitest runs in a TTY-capable environment. Tests that need to
 * simulate a non-TTY environment pass `flags['no-menu']` or set
 * stdin.isTTY manually. We rely on the explicit skip predicates
 * (`--no-menu`, `--no-interactive`, known subcommand, etc.) instead
 * of mocking isStdinTTY directly — the predicate has its own
 * dedicated tests.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyLaunchMenuToArgv,
  runLaunchMenu,
  shouldSkipMenu,
  toPersistedMenuChoice,
} from '../src/boot/launch-menu.js';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';

// ── Renderer / reader mocks ─────────────────────────────────────────────

function makeRenderer(): TerminalRenderer {
  return {
    write: vi.fn(),
    writeLine: vi.fn(),
    writeBlock: vi.fn(),
    writeToolCall: vi.fn(),
    writeToolResult: vi.fn(),
    writeDiff: vi.fn(),
    writeWarning: vi.fn(),
    writeError: vi.fn(),
    writeInfo: vi.fn(),
    clear: vi.fn(),
    render: vi.fn(),
  } as never as TerminalRenderer;
}

function makeReader(answers: string[]): ReadlineInputReader {
  let i = 0;
  return {
    readLine: vi.fn(async () => {
      if (i >= answers.length) throw new Error('EOF');
      return answers[i++] ?? '';
    }),
    close: vi.fn(async () => {}),
  } as never as ReadlineInputReader;
}

// ── shouldSkipMenu ──────────────────────────────────────────────────────

describe('shouldSkipMenu', () => {
  it('skips when --no-menu is set', () => {
    expect(shouldSkipMenu([], { 'no-menu': true }, [])).toBe(true);
  });

  it('skips when --webui is set', () => {
    expect(shouldSkipMenu([], { webui: true }, [])).toBe(true);
  });

  it('skips when --simpleui is set', () => {
    expect(shouldSkipMenu([], { simpleui: true }, [])).toBe(true);
  });

  it('skips when --hq is set', () => {
    expect(shouldSkipMenu([], { hq: true }, [])).toBe(true);
  });

  it('skips when --desktop is set', () => {
    expect(shouldSkipMenu([], { desktop: true }, [])).toBe(true);
  });

  it('skips when --no-interactive is set', () => {
    expect(shouldSkipMenu([], { 'no-interactive': true }, [])).toBe(true);
  });

  it('skips when --skip is set', () => {
    expect(shouldSkipMenu([], { skip: true }, [])).toBe(true);
  });

  it('skips when --prompt <text> is provided', () => {
    expect(shouldSkipMenu([], { prompt: 'explain x' }, [])).toBe(true);
  });

  it('skips when a positional arg is present (one-shot query)', () => {
    expect(shouldSkipMenu([], {}, ['refactor', 'src/foo.ts'])).toBe(true);
  });

  it('skips when first positional is a known subcommand', () => {
    for (const sub of ['auth', 'init', 'mcp', 'plugin', 'doctor', 'version']) {
      expect(shouldSkipMenu([], {}, [sub]), `should skip subcommand "${sub}"`).toBe(true);
    }
  });

  it('does NOT skip on plain TTY invocation with no flags', () => {
    // Force a "TTY" environment so the predicate has no reason to skip.
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    try {
      expect(shouldSkipMenu([], {}, [])).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  it('skips when stdin is not a TTY (no flags needed)', () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    try {
      expect(shouldSkipMenu([], {}, [])).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });
});

// ── applyLaunchMenuToArgv ───────────────────────────────────────────────

describe('applyLaunchMenuToArgv', () => {
  it('returns argv unchanged for cancelled results', () => {
    expect(
      applyLaunchMenuToArgv(['--no-banner'], {
        mode: 'tui-repl',
        cancelled: true,
      }),
    ).toEqual(['--no-banner']);
  });

  it('returns argv unchanged for tui-repl results', () => {
    expect(
      applyLaunchMenuToArgv(['--yolo'], {
        mode: 'tui-repl',
        cancelled: false,
      }),
    ).toEqual(['--yolo']);
  });

  it('appends --webui and --port for webui results', () => {
    expect(
      applyLaunchMenuToArgv([], {
        mode: 'webui',
        port: 3500,
        cancelled: false,
      }),
    ).toEqual(['--port=3500', '--webui']);
  });

  it('appends --simpleui and --port for simpleui results', () => {
    expect(
      applyLaunchMenuToArgv([], {
        mode: 'simpleui',
        port: 3501,
        cancelled: false,
      }),
    ).toEqual(['--port=3501', '--simpleui']);
  });

  it('appends --hq and --port for hq results', () => {
    expect(
      applyLaunchMenuToArgv([], {
        mode: 'hq',
        port: 3502,
        cancelled: false,
      }),
    ).toEqual(['--port=3502', '--hq']);
  });

  it('appends --desktop without port or host', () => {
    expect(
      applyLaunchMenuToArgv(['--yolo'], {
        mode: 'desktop',
        cancelled: false,
      }),
    ).toEqual(['--yolo', '--desktop']);
  });

  it('omits --port when result has no port', () => {
    expect(
      applyLaunchMenuToArgv([], {
        mode: 'webui',
        cancelled: false,
      }),
    ).toEqual(['--webui']);
  });

  it('includes --host when result has one', () => {
    expect(
      applyLaunchMenuToArgv([], {
        mode: 'hq',
        port: 3499,
        host: '0.0.0.0',
        cancelled: false,
      }),
    ).toEqual(['--port=3499', '--host=0.0.0.0', '--hq']);
  });

  it('does not mutate the input argv array', () => {
    const original = ['--yolo'];
    applyLaunchMenuToArgv(original, {
      mode: 'webui',
      port: 3456,
      cancelled: false,
    });
    expect(original).toEqual(['--yolo']);
  });
});

// ── toPersistedMenuChoice ───────────────────────────────────────────────

describe('toPersistedMenuChoice', () => {
  it('returns undefined for cancelled results', () => {
    expect(toPersistedMenuChoice({ mode: 'webui', cancelled: true })).toBeUndefined();
  });

  it('returns undefined for tui-repl results (owned by inner prompts)', () => {
    expect(toPersistedMenuChoice({ mode: 'tui-repl', cancelled: false })).toBeUndefined();
  });

  it('persists a desktop choice without port or host', () => {
    expect(toPersistedMenuChoice({ mode: 'desktop', cancelled: false })).toEqual({
      mode: 'desktop',
    });
  });

  it('persists a valid webui choice with port and host', () => {
    expect(
      toPersistedMenuChoice({
        mode: 'webui',
        port: 3500,
        host: '127.0.0.1',
        cancelled: false,
      }),
    ).toEqual({ mode: 'webui', port: 3500, host: '127.0.0.1' });
  });

  it('drops out-of-range port (>65535)', () => {
    expect(
      toPersistedMenuChoice({
        mode: 'webui',
        port: 70000,
        cancelled: false,
      }),
    ).toEqual({ mode: 'webui' });
  });

  it('drops out-of-range port (0 or negative)', () => {
    expect(
      toPersistedMenuChoice({
        mode: 'hq',
        port: 0,
        cancelled: false,
      }),
    ).toEqual({ mode: 'hq' });
  });

  it('drops empty host string', () => {
    expect(
      toPersistedMenuChoice({
        mode: 'simpleui',
        port: 3466,
        host: '',
        cancelled: false,
      }),
    ).toEqual({ mode: 'simpleui', port: 3466 });
  });
});

// ── runLaunchMenu — TTY-gated branches ──────────────────────────────────

describe('runLaunchMenu', () => {
  let originalIsTTY: boolean | undefined;
  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it('returns null when --no-menu is set', async () => {
    const renderer = makeRenderer();
    const reader = makeReader([]);
    const result = await runLaunchMenu({
      argv: [],
      flags: { 'no-menu': true },
      positional: [],
      renderer,
      reader,
    });
    expect(result).toBeNull();
  });

  it('selects webui with the user-typed port', async () => {
    const renderer = makeRenderer();
    // Mode pick (2), port (3500), host (Enter → default)
    const reader = makeReader(['2', '3500', '']);
    const result = await runLaunchMenu({
      argv: [],
      flags: {},
      positional: [],
      renderer,
      reader,
    });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('webui');
    expect(result!.port).toBe(3500);
    expect(result!.cancelled).toBe(false);
  });

  it('falls back to default port on Enter', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['4', '', '']);
    const result = await runLaunchMenu({
      argv: [],
      flags: {},
      positional: [],
      renderer,
      reader,
    });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('hq');
    // Default HQ port is 3499 (matches packages/cli/src/hq-server.ts).
    expect(result!.port).toBe(3499);
    expect(result!.host).toBe('0.0.0.0');
  });

  it('cancels when user types q at the mode prompt', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['q']);
    const result = await runLaunchMenu({
      argv: [],
      flags: {},
      positional: [],
      renderer,
      reader,
    });
    expect(result).not.toBeNull();
    expect(result!.cancelled).toBe(true);
  });

  it('falls back to tui-repl when user enters garbage', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['banana']);
    const result = await runLaunchMenu({
      argv: [],
      flags: {},
      positional: [],
      renderer,
      reader,
    });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('tui-repl');
    expect(result!.cancelled).toBe(false);
  });

  it('selects desktop and skips port/host prompts', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['5']);
    const result = await runLaunchMenu({
      argv: [],
      flags: {},
      positional: [],
      renderer,
      reader,
    });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('desktop');
    expect(result!.port).toBeUndefined();
    expect(result!.host).toBeUndefined();
    expect(result!.cancelled).toBe(false);
    expect((reader.readLine as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('selects desktop when the user types the mode name', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['desktop']);
    const result = await runLaunchMenu({
      argv: [],
      flags: {},
      positional: [],
      renderer,
      reader,
    });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('desktop');
    expect((reader.readLine as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('skips port/host prompts for tui-repl', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['1']);
    const result = await runLaunchMenu({
      argv: [],
      flags: {},
      positional: [],
      renderer,
      reader,
    });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('tui-repl');
    expect(result!.port).toBeUndefined();
    // Only ONE readLine call (the mode prompt) — no port/host follow-ups.
    expect((reader.readLine as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('summary gate "Y" reuses lastChoice without re-asking the mode prompt', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['y']);
    const result = await runLaunchMenu({
      argv: [],
      flags: {},
      positional: [],
      renderer,
      reader,
      lastChoice: { mode: 'webui', port: 8080, host: '127.0.0.1' },
    });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('webui');
    expect(result!.port).toBe(8080);
    expect(result!.host).toBe('127.0.0.1');
    // Only ONE readLine call — the summary gate. No mode / port / host prompts.
    expect((reader.readLine as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('summary gate "n" falls through to the numbered menu', async () => {
    const renderer = makeRenderer();
    // 'n' → re-prompt mode (3) → port (Enter) → host (Enter)
    const reader = makeReader(['n', '3', '', '']);
    const result = await runLaunchMenu({
      argv: [],
      flags: {},
      positional: [],
      renderer,
      reader,
      lastChoice: { mode: 'webui', port: 8080 },
    });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('simpleui');
    expect(result!.port).toBe(3466); // default SimpleUI port
  });

  it('summary gate "q" cancels', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['q']);
    const result = await runLaunchMenu({
      argv: [],
      flags: {},
      positional: [],
      renderer,
      reader,
      lastChoice: { mode: 'hq', port: 3499 },
    });
    expect(result).not.toBeNull();
    expect(result!.cancelled).toBe(true);
  });

  it('re-prompts on invalid port then accepts a valid one', async () => {
    const renderer = makeRenderer();
    // Mode (2) → invalid port → valid port → host (Enter)
    const reader = makeReader(['2', '99999', '3500', '']);
    const result = await runLaunchMenu({
      argv: [],
      flags: {},
      positional: [],
      renderer,
      reader,
    });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('webui');
    expect(result!.port).toBe(3500);
    // writeWarning should have fired at least once.
    expect(renderer.writeWarning as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });
});

// ── persistMenuChoice ───────────────────────────────────────────────────

describe('persistMenuChoice', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-menu-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a fresh config file when none exists', async () => {
    const { persistMenuChoice } = await import('../src/boot/launch-menu.js');
    const cfgPath = path.join(tmpDir, 'config.json');
    await persistMenuChoice(cfgPath, {
      mode: 'webui',
      port: 3500,
      host: '127.0.0.1',
    });
    const written = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(written.launch.menuChoice).toEqual({
      mode: 'webui',
      port: 3500,
      host: '127.0.0.1',
    });
  });

  it('preserves existing launch keys when merging menuChoice', async () => {
    const { persistMenuChoice } = await import('../src/boot/launch-menu.js');
    const cfgPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({ launch: { mode: 'tui', autonomy: 'auto' }, yolo: true }),
    );
    await persistMenuChoice(cfgPath, { mode: 'hq', port: 3499 });
    const written = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(written.launch.mode).toBe('tui');
    expect(written.launch.autonomy).toBe('auto');
    expect(written.launch.menuChoice).toEqual({ mode: 'hq', port: 3499 });
    expect(written.yolo).toBe(true);
  });

  it('refuses to overwrite a corrupt config file', async () => {
    const { persistMenuChoice } = await import('../src/boot/launch-menu.js');
    const cfgPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(cfgPath, '{not valid json');
    await expect(persistMenuChoice(cfgPath, { mode: 'webui', port: 3456 })).rejects.toThrow(
      /corrupt config/,
    );
  });
});
