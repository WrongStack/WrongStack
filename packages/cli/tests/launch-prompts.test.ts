/**
 * Focused coverage for pre-launch/launch-prompts.ts — launch mode prompts,
 * the saved-preferences summary gate, abort handling, and atomic persistence
 * of choices back to the global config.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LaunchAbortedError,
  persistLaunchChoices,
  runLaunchPrompts,
  type LaunchModeChoices,
} from '../src/pre-launch/launch-prompts.js';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';

let dir: string;
let configPath: string;

function fakeIo(answers: string[]) {
  let i = 0;
  const reader = {
    readLine: vi.fn(
      async (_prompt: string, opts?: { timeoutMs?: number; defaultAnswer?: string }) => {
        return answers[i++] ?? opts?.defaultAnswer ?? '';
      },
    ),
  } as unknown as ReadlineInputReader;
  const renderer = {
    write: vi.fn(),
    writeError: vi.fn(),
  } as unknown as TerminalRenderer;
  return { reader, renderer };
}

const LAST: LaunchModeChoices = { mode: 'tui', yolo: true, autonomy: 'auto' };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-launch-prompts-'));
  configPath = path.join(dir, 'config.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('runLaunchPrompts — shortcuts', () => {
  it('returns pinned values when every field is pinned', async () => {
    const { reader, renderer } = fakeIo([]);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      modePinned: 'repl',
      yoloPinned: false,
      autonomyPinned: 'off',
    });
    expect(result).toEqual({ mode: 'repl', yolo: false, autonomy: 'off' });
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it('applies defaults silently on first run (no saved choices)', async () => {
    const { reader, renderer } = fakeIo([]);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result).toEqual({ mode: 'tui', yolo: true, autonomy: 'auto' });
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it('respects partial pins on first run', async () => {
    const { reader, renderer } = fakeIo([]);
    const result = await runLaunchPrompts({ renderer, reader, modePinned: 'repl' });
    expect(result.mode).toBe('repl');
    expect(result.yolo).toBe(true);
  });
});

describe('runLaunchPrompts — summary gate', () => {
  it('accepts saved choices with the default answer', async () => {
    const { reader, renderer } = fakeIo([]);
    const result = await runLaunchPrompts({ renderer, reader, lastChoices: LAST });
    expect(result).toEqual(LAST);
    expect(renderer.write).toHaveBeenCalledWith(expect.stringContaining('Last settings:'));
    expect(renderer.write).toHaveBeenCalledWith(expect.stringContaining('▶'));
  });

  it('accepts an explicit y', async () => {
    const { reader, renderer } = fakeIo(['y']);
    const result = await runLaunchPrompts({ renderer, reader, lastChoices: LAST });
    expect(result).toEqual(LAST);
  });

  it('throws LaunchAbortedError on q at the summary gate', async () => {
    const { reader, renderer } = fakeIo(['q']);
    await expect(runLaunchPrompts({ renderer, reader, lastChoices: LAST })).rejects.toBeInstanceOf(
      LaunchAbortedError,
    );
  });

  it('falls through to individual prompts when the user answers n', async () => {
    const { reader, renderer } = fakeIo(['n', 'r', 'n', 'n']);
    const result = await runLaunchPrompts({ renderer, reader, lastChoices: LAST });
    expect(result.mode).toBe('repl');
    expect(result.yolo).toBe(false);
    expect(result.autonomy).toBe('off');
  });

  it('goes straight to individual prompts when a pin overrides saved choices', async () => {
    const { reader, renderer } = fakeIo(['r', 'y', 'y']);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      lastChoices: LAST,
      modePinned: 'repl',
    });
    expect(result.mode).toBe('repl');
    expect(reader.readLine).toHaveBeenCalledTimes(2); // yolo + autonomy prompts only
  });
});

describe('runLaunchPrompts — individual prompts', () => {
  it('cancels on q at the mode prompt', async () => {
    // 'n' falls through the summary gate, then 'q' aborts at the mode prompt.
    const { reader, renderer } = fakeIo(['n', 'q']);
    await expect(
      runLaunchPrompts({ renderer, reader, lastChoices: LAST, modePinned: undefined }),
    ).rejects.toBeInstanceOf(LaunchAbortedError);
  });

  it('cancels on q at the yolo prompt', async () => {
    // 'n' falls through the summary gate, 'r' picks repl, 'q' aborts at yolo.
    const { reader, renderer } = fakeIo(['n', 'r', 'q']);
    await expect(runLaunchPrompts({ renderer, reader, lastChoices: LAST })).rejects.toBeInstanceOf(
      LaunchAbortedError,
    );
  });

  it('cancels on q at the autonomy prompt', async () => {
    // 'n' falls through, 'r' picks repl, 'y' enables yolo, 'q' aborts at autonomy.
    const { reader, renderer } = fakeIo(['n', 'r', 'y', 'q']);
    await expect(runLaunchPrompts({ renderer, reader, lastChoices: LAST })).rejects.toBeInstanceOf(
      LaunchAbortedError,
    );
  });

  it('keeps the pinned yolo when it matches the saved value', async () => {
    // 'n' falls through the summary gate, 'r' picks repl; yolo is pinned to
    // the saved value so only the autonomy prompt follows.
    const { reader, renderer } = fakeIo(['n', 'r', 'y']);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      lastChoices: LAST,
      yoloPinned: true,
    });
    expect(result.yolo).toBe(true);
    expect(result.mode).toBe('repl');
    expect(reader.readLine).toHaveBeenCalledTimes(3); // gate + mode + autonomy
  });

  it('keeps the pinned autonomy when it matches the saved value', async () => {
    // 'n' falls through, 'r' picks repl, 'y' enables yolo; autonomy is pinned
    // to the saved value so no autonomy prompt follows.
    const { reader, renderer } = fakeIo(['n', 'r', 'y']);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      lastChoices: LAST,
      autonomyPinned: 'auto',
    });
    expect(result.autonomy).toBe('auto');
    expect(result.mode).toBe('repl');
    expect(reader.readLine).toHaveBeenCalledTimes(3); // gate + mode + yolo
  });
});

describe('persistLaunchChoices', () => {
  it('writes choices into a fresh config', async () => {
    await persistLaunchChoices(configPath, LAST);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(raw.yolo).toBe(true);
    expect(raw.launch).toEqual({ mode: 'tui', autonomy: 'auto' });
  });

  it('updates an existing config, preserving other fields', async () => {
    await fs.writeFile(configPath, JSON.stringify({ apiKey: 'keep', yolo: false }), 'utf8');
    await persistLaunchChoices(configPath, { mode: 'repl', yolo: false, autonomy: 'off' });
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(raw.apiKey).toBe('keep');
    expect(raw.launch).toEqual({ mode: 'repl', autonomy: 'off' });
  });

  it('refuses to overwrite a corrupt existing config', async () => {
    await fs.writeFile(configPath, '{ not json', 'utf8');
    await expect(persistLaunchChoices(configPath, LAST)).rejects.toThrow(
      'Refusing to overwrite corrupt config',
    );
  });
});
