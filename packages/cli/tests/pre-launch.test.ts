import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadlineInputReader } from '../src/input-reader.js';
import { detectProjectKind, LaunchAbortedError, persistLaunchChoices, runLaunchPrompts, runProjectCheck } from '../src/pre-launch.js';
import type { TerminalRenderer } from '../src/renderer.js';

/**
 * V0-C: pre-launch decides whether to scaffold AGENTS.md, prompts for
 * TUI/REPL + YOLO, and gates entry to an empty directory. Wrong behavior
 * here is the user's first impression of the tool, so these tests pin the
 * three flow shapes (initialized / project / empty) and the pinning short-
 * circuits.
 */

async function mkTempDir(prefix = 'wstack-prelaunch-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

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

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

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

describe('detectProjectKind', () => {
  it("returns 'initialized' when .wrongstack/AGENTS.md exists", async () => {
    const dir = await mkTempDir();
    await fs.mkdir(path.join(dir, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(dir, '.wrongstack', 'AGENTS.md'), '# notes');
    expect(await detectProjectKind(dir)).toBe('initialized');
  });

  it("returns 'project' when a manifest exists but no AGENTS.md", async () => {
    const dir = await mkTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), '{}');
    expect(await detectProjectKind(dir)).toBe('project');
  });

  it("returns 'project' for non-JS manifests too (pyproject.toml)", async () => {
    const dir = await mkTempDir();
    await fs.writeFile(path.join(dir, 'pyproject.toml'), '');
    expect(await detectProjectKind(dir)).toBe('project');
  });

  it("returns 'empty' when no manifest and no AGENTS.md", async () => {
    const dir = await mkTempDir();
    expect(await detectProjectKind(dir)).toBe('empty');
  });
});

describe('runProjectCheck', () => {
  let renderer: TerminalRenderer;

  beforeEach(() => {
    renderer = makeRenderer();
  });

  it('initialized project returns true without prompting', async () => {
    const dir = await mkTempDir();
    await fs.mkdir(path.join(dir, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(dir, '.wrongstack', 'AGENTS.md'), '# notes');
    const reader = makeReader([]);

    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });

    expect(result).toBe(true);
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it("'project' kind + 'y' answer scaffolds AGENTS.md", async () => {
    const dir = await mkTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
    const reader = makeReader(['y']);

    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });

    expect(result).toBe(true);
    const agentsFile = path.join(dir, '.wrongstack', 'AGENTS.md');
    const exists = await fs
      .access(agentsFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("'project' kind + 'n' answer skips scaffolding but still returns true", async () => {
    const dir = await mkTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), '{}');
    const reader = makeReader(['n']);

    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });

    expect(result).toBe(true);
    const agentsFile = path.join(dir, '.wrongstack', 'AGENTS.md');
    const exists = await fs
      .access(agentsFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("'empty' kind + 'n' answer returns false (user bailed)", async () => {
    const dir = await mkTempDir();
    // Two prompts: 'Initialize git?' then 'Continue anyway?'
    const reader = makeReader(['n', 'n']);

    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });

    expect(result).toBe(false);
  });

  it("'empty' kind + 'Y' answer returns true", async () => {
    const dir = await mkTempDir();
    // Two prompts: 'Initialize git?' then 'Continue anyway?'
    const reader = makeReader(['n', 'y']);

    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });

    expect(result).toBe(true);
  });

  it("'empty' kind + empty answer defaults to continuing", async () => {
    const dir = await mkTempDir();
    // Two prompts: 'Initialize git?' (empty) then 'Continue anyway?' (empty)
    const reader = makeReader(['', '']);

    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });

    expect(result).toBe(true);
  });
});

describe('runLaunchPrompts', () => {
  it('returns pinned values without prompting', async () => {
    const renderer = makeRenderer();
    const reader = makeReader([]);

    const result = await runLaunchPrompts({
      renderer,
      reader,
      modePinned: 'tui',
      yoloPinned: false,
      autonomyPinned: 'off',
    });

    expect(result).toEqual({ mode: 'tui', yolo: false, autonomy: 'off' });
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it("modePinned: 'repl' skips the mode question (the path --webui pins)", async () => {
    const renderer = makeRenderer();
    const reader = makeReader([]);

    const result = await runLaunchPrompts({
      renderer,
      reader,
      modePinned: 'repl',
      yoloPinned: false,
      autonomyPinned: 'off',
    });

    expect(result.mode).toBe('repl');
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it("'r' answer picks REPL mode", async () => {
    const renderer = makeRenderer();
    // 3 prompts: mode, yolo, autonomy — 'r' for mode, 'n' for yolo
    const reader = makeReader(['r', 'n', '']);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      yoloPinned: false,
      lastChoices: { mode: 'tui', yolo: true, autonomy: 'auto' },
    });
    expect(result.mode).toBe('repl');
    expect(result.yolo).toBe(false);
    expect(result.autonomy).toBe('auto');
  });

  it('empty answer defaults to TUI mode', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', '', '']);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      yoloPinned: false,
      lastChoices: { mode: 'repl', yolo: true, autonomy: 'auto' },
    });
    expect(result.mode).toBe('tui');
  });

  it("'y' on yolo prompt enables YOLO mode", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', 'y', '']);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      yoloPinned: true, // trigger individual prompts
      lastChoices: { mode: 'tui', yolo: false, autonomy: 'auto' },
    });
    expect(result.yolo).toBe(true);
    const yoloPrompt = stripAnsi(String(vi.mocked(reader.readLine).mock.calls[1]?.[0] ?? ''));
    expect(yoloPrompt).toContain('auto-approve tool calls');
  });

  it("'n' on yolo prompt disables YOLO mode", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', 'n', '']);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      yoloPinned: false,
      lastChoices: { mode: 'tui', yolo: true, autonomy: 'auto' },
    });
    expect(result.yolo).toBe(false);
  });

  it('empty answer on all prompts defaults to YOLO + Autonomy enabled', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', '', '']);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      yoloPinned: false,
      lastChoices: { mode: 'tui', yolo: true, autonomy: 'auto' },
    });
    expect(result.yolo).toBe(true);
    expect(result.autonomy).toBe('auto');
  });

  it("'n' on autonomy prompt sets autonomy off", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', '', 'n']);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      autonomyPinned: 'off',
      lastChoices: { mode: 'tui', yolo: true, autonomy: 'auto' },
    });
    expect(result.autonomy).toBe('off');
  });

  it('mode+yolo+autonomy pinned skips all prompts', async () => {
    const renderer = makeRenderer();
    const reader = makeReader([]);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      modePinned: 'tui',
      yoloPinned: true,
      autonomyPinned: 'auto',
    });
    expect(result.mode).toBe('tui');
    expect(result.yolo).toBe(true);
    expect(result.autonomy).toBe('auto');
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it("'q' on mode prompt throws LaunchAbortedError", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['q']);
    await expect(
      runLaunchPrompts({
        renderer,
        reader,
        yoloPinned: false,
        lastChoices: { mode: 'repl', yolo: true, autonomy: 'auto' },
      }),
    ).rejects.toThrow(LaunchAbortedError);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it("'q' on yolo prompt throws LaunchAbortedError", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', 'q']);
    await expect(
      runLaunchPrompts({
        renderer,
        reader,
        yoloPinned: false,
        lastChoices: { mode: 'tui', yolo: true, autonomy: 'auto' },
      }),
    ).rejects.toThrow(LaunchAbortedError);
    expect(reader.readLine).toHaveBeenCalledTimes(2);
  });

  // --- Saved-preferences (lastChoices) summary gate ---

  it('with lastChoices, empty answer accepts saved values (single prompt)', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['']); // just the summary prompt
    const lastChoices = { mode: 'tui' as const, yolo: true, autonomy: 'off' as const };

    const result = await runLaunchPrompts({ renderer, reader, lastChoices });

    expect(result).toEqual(lastChoices);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it("with lastChoices, 'Y' answer accepts saved values", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['y']);
    const lastChoices = { mode: 'repl' as const, yolo: false, autonomy: 'auto' as const };

    const result = await runLaunchPrompts({ renderer, reader, lastChoices });

    expect(result).toEqual(lastChoices);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it("with lastChoices, 'n' falls through to individual prompts", async () => {
    const renderer = makeRenderer();
    // 'n' on summary, then answers for 3 individual prompts
    const reader = makeReader(['n', 'r', 'n', 'n']);
    const lastChoices = { mode: 'tui' as const, yolo: true, autonomy: 'auto' as const };

    const result = await runLaunchPrompts({ renderer, reader, lastChoices });

    expect(result).toEqual({ mode: 'repl', yolo: false, autonomy: 'off' });
    expect(reader.readLine).toHaveBeenCalledTimes(4); // summary + 3 prompts
  });

  it("with lastChoices, 'q' on summary aborts", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['q']);
    const lastChoices = { mode: 'tui' as const, yolo: true, autonomy: 'auto' as const };

    await expect(runLaunchPrompts({ renderer, reader, lastChoices })).rejects.toThrow(
      LaunchAbortedError,
    );
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it('with lastChoices + pinned overrides, summary shows merged values', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['']); // accept the merged summary
    const lastChoices = { mode: 'repl' as const, yolo: true, autonomy: 'auto' as const };

    const result = await runLaunchPrompts({
      renderer,
      reader,
      lastChoices,
    });

    expect(result.mode).toBe('repl');
    expect(result.yolo).toBe(true);
    expect(result.autonomy).toBe('auto');
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it('on first run (no lastChoices), uses the new defaults silently with no prompts', async () => {
    const renderer = makeRenderer();
    const reader = makeReader([]);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result).toEqual({ mode: 'tui', yolo: true, autonomy: 'auto' });
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it('on first run with all CLI flags pinned, uses pinned values with no prompts', async () => {
    const renderer = makeRenderer();
    const reader = makeReader([]);
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

  it('on first run with partial CLI flags, uses defaults for unset fields', async () => {
    const renderer = makeRenderer();
    const reader = makeReader([]);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      modePinned: 'repl',
    });
    expect(result).toEqual({ mode: 'repl', yolo: true, autonomy: 'auto' });
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it('with lastChoices AND no CLI flag override, shows summary gate (1 prompt)', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['']);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      lastChoices: { mode: 'tui', yolo: true, autonomy: 'auto' },
    });
    expect(result).toEqual({ mode: 'tui', yolo: true, autonomy: 'auto' });
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it('with lastChoices AND a CLI flag that diverges, skips summary and prompts individually', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', 'n', '']); // mode=tui, yolo=n, autonomy=auto
    const result = await runLaunchPrompts({
      renderer,
      reader,
      yoloPinned: false,
      lastChoices: { mode: 'tui', yolo: true, autonomy: 'auto' },
    });
    expect(result.mode).toBe('tui');
    expect(result.yolo).toBe(false);
    expect(result.autonomy).toBe('auto');
    expect(reader.readLine).toHaveBeenCalledTimes(3);
  });

  it('with lastChoices AND CLI flag matching saved, shows summary (no override)', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['']); // accept
    const result = await runLaunchPrompts({
      renderer,
      reader,
      yoloPinned: true,
      lastChoices: { mode: 'tui', yolo: true, autonomy: 'auto' },
    });
    expect(result.yolo).toBe(true);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it('individual prompts: each prompt uses defaults', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', '', 'n']); // mode=tui, yolo=default, autonomy=n
    const result = await runLaunchPrompts({
      renderer,
      reader,
      autonomyPinned: 'off', // diverges from saved autonomy=auto
      lastChoices: { mode: 'tui', yolo: true, autonomy: 'auto' },
    });
    expect(result.mode).toBe('tui');
    expect(result.yolo).toBe(true);
    expect(result.autonomy).toBe('off');
    expect(reader.readLine).toHaveBeenCalledTimes(3);
  });

  // --- persistLaunchChoices ---

  it('persistLaunchChoices writes launch + yolo to config file', async () => {
    const dir = await mkTempDir('wstack-persist-');
    const configPath = path.join(dir, 'config.json');
    const choices = { mode: 'tui' as const, yolo: true, autonomy: 'auto' as const };

    await persistLaunchChoices(configPath, choices);

    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.yolo).toBe(true);
    expect(parsed.launch).toEqual({ mode: 'tui', autonomy: 'auto' });
  });

  it('persistLaunchChoices preserves existing config fields', async () => {
    const dir = await mkTempDir('wstack-persist-');
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ provider: 'anthropic', model: 'claude', version: 1 }));
    const choices = { mode: 'repl' as const, yolo: false, autonomy: 'off' as const };

    await persistLaunchChoices(configPath, choices);

    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.provider).toBe('anthropic');
    expect(parsed.model).toBe('claude');
    expect(parsed.yolo).toBe(false);
    expect(parsed.launch).toEqual({ mode: 'repl', autonomy: 'off' });
  });

  it('persistLaunchChoices throws on corrupt existing file instead of overwriting', async () => {
    const dir = await mkTempDir('wstack-persist-');
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, '{ "provider": "anthropic", broken: true }');
    const choices = { mode: 'tui' as const, yolo: false, autonomy: 'auto' as const };

    await expect(persistLaunchChoices(configPath, choices)).rejects.toThrow(/corrupt/i);

    const raw = await fs.readFile(configPath, 'utf8');
    expect(raw).toBe('{ "provider": "anthropic", broken: true }');
  });
});
