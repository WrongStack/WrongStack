import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ESM module namespaces are not configurable, so `vi.spyOn(fs, 'readdir')`
// throws under Vitest. Wrap readdir in a vi.fn at module-mock time instead —
// it delegates to the real implementation until a test overrides it, and
// `vi.restoreAllMocks()` puts the real delegate back between tests.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
import type { ReadlineInputReader } from '../src/input-reader.js';
import { detectProjectKind, LaunchAbortedError, maybeAskAboutIndexing, persistLaunchChoices, resolveIndexThreshold, runLaunchPrompts, runProjectCheck } from '../src/pre-launch.js';
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
      directorPinned: false,
      autonomyPinned: 'off',
    });

    expect(result).toEqual({ mode: 'tui', yolo: false, director: false, autonomy: 'off' });
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it("modePinned: 'repl' skips the mode question (the path --webui pins)", async () => {
    // boot.ts pins the surface to REPL when --webui is passed (webui runs the
    // browser server alongside the REPL, mutually exclusive with the Ink TUI),
    // so the TUI/REPL picker must not prompt — otherwise a TUI choice would
    // shadow the --webui branch in execution.ts.
    const renderer = makeRenderer();
    const reader = makeReader([]);

    const result = await runLaunchPrompts({
      renderer,
      reader,
      modePinned: 'repl',
      yoloPinned: false,
      directorPinned: false,
      autonomyPinned: 'off',
    });

    expect(result.mode).toBe('repl');
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it("'r' answer picks REPL mode", async () => {
    const renderer = makeRenderer();
    // 4 prompts: mode, yolo, director, autonomy — all defaults except mode
    const reader = makeReader(['r', '', '', '']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.mode).toBe('repl');
    expect(result.yolo).toBe(true);
    expect(result.director).toBe(true);
    expect(result.autonomy).toBe('auto');
  });

  it('empty answer defaults to TUI mode', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', '', '', '']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.mode).toBe('tui');
  });

  it("'y' on yolo prompt enables YOLO mode", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', 'y', '', '']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.yolo).toBe(true);
    const yoloPrompt = stripAnsi(String(vi.mocked(reader.readLine).mock.calls[1]?.[0] ?? ''));
    expect(yoloPrompt).toContain('auto-approve normal project work');
  });

  it("'n' on yolo prompt disables YOLO mode", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', 'n', '', '']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.yolo).toBe(false);
  });

  it('empty answer on all prompts defaults to YOLO + Director + Autonomy enabled', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', '', '', '']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.yolo).toBe(true);
    expect(result.director).toBe(true);
    expect(result.autonomy).toBe('auto');
  });

  it("'n' on director prompt disables Director", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', '', 'n', '']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.director).toBe(false);
  });

  it("'n' on autonomy prompt sets autonomy off", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', '', '', 'n']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.autonomy).toBe('off');
  });

  it('mode prompt asked but yolo+director+autonomy pinned skips those prompts', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['r']);
    const result = await runLaunchPrompts({
      renderer,
      reader,
      yoloPinned: true,
      directorPinned: false,
      autonomyPinned: 'off',
    });
    expect(result.mode).toBe('repl');
    expect(result.yolo).toBe(true);
    expect(result.director).toBe(false);
    expect(result.autonomy).toBe('off');
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it("'q' on mode prompt throws LaunchAbortedError", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['q']);
    await expect(runLaunchPrompts({ renderer, reader })).rejects.toThrow(LaunchAbortedError);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it("'q' on yolo prompt throws LaunchAbortedError", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', 'q']);
    await expect(runLaunchPrompts({ renderer, reader })).rejects.toThrow(LaunchAbortedError);
    expect(reader.readLine).toHaveBeenCalledTimes(2);
  });

  it("'q' on director prompt throws LaunchAbortedError", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', '', 'q']);
    await expect(runLaunchPrompts({ renderer, reader })).rejects.toThrow(LaunchAbortedError);
    expect(reader.readLine).toHaveBeenCalledTimes(3);
  });

  // --- Saved-preferences (lastChoices) summary gate ---

  it('with lastChoices, empty answer accepts saved values (single prompt)', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['']); // just the summary prompt
    const lastChoices = { mode: 'tui' as const, yolo: true, director: false, autonomy: 'off' as const };

    const result = await runLaunchPrompts({ renderer, reader, lastChoices });

    expect(result).toEqual(lastChoices);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it("with lastChoices, 'Y' answer accepts saved values", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['y']);
    const lastChoices = { mode: 'repl' as const, yolo: false, director: true, autonomy: 'auto' as const };

    const result = await runLaunchPrompts({ renderer, reader, lastChoices });

    expect(result).toEqual(lastChoices);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it("with lastChoices, 'n' falls through to individual prompts", async () => {
    const renderer = makeRenderer();
    // 'n' on summary, then answers for 4 individual prompts
    const reader = makeReader(['n', 'r', 'n', 'n', 'n']);
    const lastChoices = { mode: 'tui' as const, yolo: true, director: true, autonomy: 'auto' as const };

    const result = await runLaunchPrompts({ renderer, reader, lastChoices });

    expect(result).toEqual({ mode: 'repl', yolo: false, director: false, autonomy: 'off' });
    expect(reader.readLine).toHaveBeenCalledTimes(5); // summary + 4 prompts
  });

  it("with lastChoices, 'q' on summary aborts", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['q']);
    const lastChoices = { mode: 'tui' as const, yolo: true, director: true, autonomy: 'auto' as const };

    await expect(runLaunchPrompts({ renderer, reader, lastChoices })).rejects.toThrow(
      LaunchAbortedError,
    );
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it('with lastChoices + pinned overrides, summary shows merged values', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['']); // accept the merged summary
    const lastChoices = { mode: 'tui' as const, yolo: true, director: true, autonomy: 'auto' as const };

    // CLI pinned REPL and YOLO off — summary should reflect overrides
    const result = await runLaunchPrompts({
      renderer,
      reader,
      modePinned: 'repl',
      yoloPinned: false,
      lastChoices,
    });

    expect(result.mode).toBe('repl'); // pinned overrides saved 'tui'
    expect(result.yolo).toBe(false); // pinned overrides saved true
    expect(result.director).toBe(true); // from lastChoices (not pinned)
    expect(result.autonomy).toBe('auto'); // from lastChoices (not pinned)
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it('without lastChoices, prompts individually as before (backwards compat)', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['t', '', '', '']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.mode).toBe('tui');
    expect(result.yolo).toBe(true);
    expect(result.director).toBe(true);
    expect(result.autonomy).toBe('auto');
    expect(reader.readLine).toHaveBeenCalledTimes(4);
  });

  // --- persistLaunchChoices ---

  it('persistLaunchChoices writes launch + yolo to config file', async () => {
    const dir = await mkTempDir('wstack-persist-');
    const configPath = path.join(dir, 'config.json');
    const choices = { mode: 'tui' as const, yolo: true, director: false, autonomy: 'auto' as const };

    await persistLaunchChoices(configPath, choices);

    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.yolo).toBe(true);
    expect(parsed.launch).toEqual({ mode: 'tui', director: false, autonomy: 'auto' });
  });

  it('persistLaunchChoices preserves existing config fields', async () => {
    const dir = await mkTempDir('wstack-persist-');
    const configPath = path.join(dir, 'config.json');
    // Pre-populate with some existing config
    await fs.writeFile(configPath, JSON.stringify({ provider: 'anthropic', model: 'claude', version: 1 }));
    const choices = { mode: 'repl' as const, yolo: false, director: true, autonomy: 'off' as const };

    await persistLaunchChoices(configPath, choices);

    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.provider).toBe('anthropic'); // preserved
    expect(parsed.model).toBe('claude'); // preserved
    expect(parsed.yolo).toBe(false); // updated
    expect(parsed.launch).toEqual({ mode: 'repl', director: true, autonomy: 'off' }); // added
  });

  it('persistLaunchChoices throws on corrupt existing file instead of overwriting', async () => {
    const dir = await mkTempDir('wstack-persist-');
    const configPath = path.join(dir, 'config.json');
    // Write a corrupt (non-JSON) file
    await fs.writeFile(configPath, '{ "provider": "anthropic", broken: true }');
    const choices = { mode: 'tui' as const, yolo: false, director: false, autonomy: 'auto' as const };

    await expect(persistLaunchChoices(configPath, choices)).rejects.toThrow(/corrupt/i);

    // File must still contain the corrupt original — NOT overwritten
    const raw = await fs.readFile(configPath, 'utf8');
    expect(raw).toBe('{ "provider": "anthropic", broken: true }');
  });
});

// ─── maybeAskAboutIndexing ────────────────────────────────────────────────────

/**
 * Minimal Dirent stub — the file counter only touches `.name`,
 * `.isDirectory()`, and `.isFile()`.
 */
function dirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    parentPath: '',
    path: '',
  } as never as Dirent;
}

/**
 * Stub `fs.readdir` to return a controlled directory tree. The map keys
 * are absolute directory paths; values are the entries in that directory.
 */
function stubReaddir(tree: Record<string, Dirent[]>) {
  (fs.readdir as never as ReturnType<typeof vi.fn>).mockImplementation(
    async (dirPath: unknown) => {
      const key = typeof dirPath === 'string' ? dirPath : String(dirPath);
      return tree[key] ?? [];
    },
  );
}

describe('resolveIndexThreshold', () => {
  const envKey = 'WRONGSTACK_INDEX_QUESTION_THRESHOLD';
  const original = process.env[envKey];

  afterEach(() => {
    // Restore the original env value (or delete if it was unset).
    if (original === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = original;
    }
  });

  it('returns 500 when env var is unset', () => {
    delete process.env[envKey];
    expect(resolveIndexThreshold()).toBe(500);
  });

  it('returns 500 when env var is empty string', () => {
    process.env[envKey] = '';
    expect(resolveIndexThreshold()).toBe(500);
  });

  it('returns the parsed number for a valid positive integer', () => {
    process.env[envKey] = '200';
    expect(resolveIndexThreshold()).toBe(200);
  });

  it('handles large values (e.g. to suppress the question)', () => {
    process.env[envKey] = '999999';
    expect(resolveIndexThreshold()).toBe(999999);
  });

  it('handles the value "1" (most aggressive)', () => {
    process.env[envKey] = '1';
    expect(resolveIndexThreshold()).toBe(1);
  });

  it('falls back to 500 for non-numeric strings', () => {
    process.env[envKey] = 'not-a-number';
    expect(resolveIndexThreshold()).toBe(500);
  });

  it('falls back to 500 for zero', () => {
    process.env[envKey] = '0';
    expect(resolveIndexThreshold()).toBe(500);
  });

  it('falls back to 500 for negative numbers', () => {
    process.env[envKey] = '-100';
    expect(resolveIndexThreshold()).toBe(500);
  });

  it('falls back to 500 for Infinity', () => {
    process.env[envKey] = 'Infinity';
    expect(resolveIndexThreshold()).toBe(500);
  });

  it('falls back to 500 for NaN', () => {
    process.env[envKey] = 'NaN';
    expect(resolveIndexThreshold()).toBe(500);
  });
});

describe('maybeAskAboutIndexing', () => {
  let renderer: TerminalRenderer;

  beforeEach(() => {
    renderer = makeRenderer();
    vi.restoreAllMocks();
  });

  it('returns undefined when indexing is not configured (bare mode)', async () => {
    const reader = makeReader([]);

    // Note: The module-level mock delegates to real fs.readdir, so we cannot
    // prevent filesystem access here. We just verify the early return works.
    const result = await maybeAskAboutIndexing({
      projectRoot: '/proj',
      renderer,
      reader,
      indexingConfigured: false,
    });

    expect(result).toBeUndefined();
    // Never prompts the reader — short-circuits immediately.
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it('returns undefined for a small codebase (< 500 indexable files)', async () => {
    const root = '/proj';
    const reader = makeReader([]);

    // 2 indexable files — well below the 500 threshold.
    stubReaddir({
      [root]: [
        dirent('README.md', false),
        dirent('src', true),
      ],
      [path.join(root, 'src')]: [
        dirent('index.ts', false),
        dirent('helper.ts', false),
      ],
    });

    const result = await maybeAskAboutIndexing({
      projectRoot: root,
      renderer,
      reader,
      indexingConfigured: true,
    });

    expect(result).toBeUndefined();
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it('returns true when user answers "y" on a large codebase', async () => {
    const root = '/proj';
    const reader = makeReader(['y']);

    // 500 .ts files in a single directory — hits the threshold exactly.
    const entries = Array.from({ length: 500 }, (_, i) =>
      dirent(`file_${i}.ts`, false),
    );
    stubReaddir({ [root]: entries });

    const result = await maybeAskAboutIndexing({
      projectRoot: root,
      renderer,
      reader,
      indexingConfigured: true,
    });

    expect(result).toBe(true);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
    const prompt = stripAnsi(String(vi.mocked(reader.readLine).mock.calls[0]?.[0] ?? ''));
    expect(prompt).toContain('Run codebase indexing now');
  });

  it('returns false when user answers "n" on a large codebase', async () => {
    const root = '/proj';
    const reader = makeReader(['n']);

    const entries = Array.from({ length: 500 }, (_, i) =>
      dirent(`file_${i}.ts`, false),
    );
    stubReaddir({ [root]: entries });

    const result = await maybeAskAboutIndexing({
      projectRoot: root,
      renderer,
      reader,
      indexingConfigured: true,
    });

    expect(result).toBe(false);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
    // Verify the skip message was written.
    const writeCalls = vi.mocked(renderer.write).mock.calls.map(
      (c) => stripAnsi(String(c[0])),
    );
    const skipLine = writeCalls.find((l) => l.includes('Skipping indexing'));
    expect(skipLine).toBeDefined();
  });

  it('returns false when user answers "q" (skip, not abort)', async () => {
    const root = '/proj';
    const reader = makeReader(['q']);

    const entries = Array.from({ length: 500 }, (_, i) =>
      dirent(`file_${i}.ts`, false),
    );
    stubReaddir({ [root]: entries });

    const result = await maybeAskAboutIndexing({
      projectRoot: root,
      renderer,
      reader,
      indexingConfigured: true,
    });

    // 'q' is NOT LaunchAbortedError — we're past the project check.
    expect(result).toBe(false);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it('returns false on empty input (defaults to skip)', async () => {
    const root = '/proj';
    const reader = makeReader(['']);

    const entries = Array.from({ length: 500 }, (_, i) =>
      dirent(`file_${i}.ts`, false),
    );
    stubReaddir({ [root]: entries });

    const result = await maybeAskAboutIndexing({
      projectRoot: root,
      renderer,
      reader,
      indexingConfigured: true,
    });

    expect(result).toBe(false);
  });

  it('counts recursively across nested directories', async () => {
    const root = '/proj';

    // 2 dirs × 250 files each = 500 — hits the threshold.
    const entriesA = Array.from({ length: 250 }, (_, i) =>
      dirent(`a_${i}.ts`, false),
    );
    const entriesB = Array.from({ length: 250 }, (_, i) =>
      dirent(`b_${i}.ts`, false),
    );
    stubReaddir({
      [root]: [dirent('dir_a', true), dirent('dir_b', true)],
      [path.join(root, 'dir_a')]: entriesA,
      [path.join(root, 'dir_b')]: entriesB,
    });

    const reader = makeReader(['y']);
    const result = await maybeAskAboutIndexing({
      projectRoot: root,
      renderer,
      reader,
      indexingConfigured: true,
    });

    // Recursive count reaches the threshold -> question asked -> user said yes.
    expect(result).toBe(true);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it('skips node_modules, .git, and other ignore dirs', async () => {
    const root = '/proj';

    // 500 files inside node_modules — should be skipped entirely.
    const nodeModulesFiles = Array.from({ length: 500 }, (_, i) =>
      dirent(`mod_${i}.ts`, false),
    );
    stubReaddir({
      [root]: [
        dirent('node_modules', true),
        dirent('index.ts', false), // 1 indexable file in root
      ],
      [path.join(root, 'node_modules')]: nodeModulesFiles,
    });

    const reader = makeReader([]);
    const result = await maybeAskAboutIndexing({
      projectRoot: root,
      renderer,
      reader,
      indexingConfigured: true,
    });

    // Only 1 indexable file after filtering — below threshold → no prompt.
    expect(result).toBeUndefined();
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it('stops counting early once threshold is reached', async () => {
    const root = '/proj';

    // 1000 files — the counter should stop at 500 and return.
    const entries = Array.from({ length: 1000 }, (_, i) =>
      dirent(`file_${i}.ts`, false),
    );
    stubReaddir({ [root]: entries });

    const reader = makeReader(['y']);
    const result = await maybeAskAboutIndexing({
      projectRoot: root,
      renderer,
      reader,
      indexingConfigured: true,
    });

    expect(result).toBe(true);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it('shows approximate file count in the prompt', async () => {
    const root = '/proj';
    const reader = makeReader(['']);

    const entries = Array.from({ length: 500 }, (_, i) =>
      dirent(`file_${i}.ts`, false),
    );
    stubReaddir({ [root]: entries });

    await maybeAskAboutIndexing({
      projectRoot: root,
      renderer,
      reader,
      indexingConfigured: true,
    });

    const writeCalls = vi.mocked(renderer.write).mock.calls.map(
      (c) => stripAnsi(String(c[0])),
    );
    const detectLine = writeCalls.find((l) => l.includes('Large codebase detected'));
    expect(detectLine).toBeDefined();
    // Should mention the approximate count.
    expect(detectLine).toContain('500');
  });
});
