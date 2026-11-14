/**
 * Edge paths of the lean profile, subsets, shared npm install and token
 * reader that the feature tests do not reach.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exec = vi.hoisted(() => ({ execCommand: vi.fn() }));
vi.mock('../src/exec-command.js', () => ({ execCommand: exec.execCommand }));

import { createSandbox, deepMerge, LEAN_BENCH_CONFIG } from '../src/isolation.js';
import { readTokenMetrics } from '../src/session-metrics.js';
import { loadSubsetIds } from '../src/suites/bundled.js';
import { resolveHardSuiteDir } from '../src/suites/hard.js';
import { createPolyglotSuite } from '../src/suites/polyglot.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-additions-'));
  exec.execCommand.mockReset();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('lean harness overlay', () => {
  it('deep-merges tuning over the lean profile but never over the run contract', async () => {
    const sandbox = await createSandbox({
      baseDir: path.join(root, 'sb'),
      maxIterations: 12,
      yolo: true,
      harnessOverlay: {
        systemPrompt: { variant: 'pro' },
        features: { tokenSavingMode: 'off' },
        yolo: false,
        tools: { maxIterations: 999 },
      },
    });
    const cfg = JSON.parse(await fs.readFile(path.join(sandbox.homeDir, 'config.json'), 'utf8'));
    expect(cfg.systemPrompt).toEqual({ variant: 'pro' });
    expect(cfg.features).toEqual({ ...LEAN_BENCH_CONFIG.features, tokenSavingMode: 'off' });
    expect(cfg.yolo).toBe(true);
    expect(cfg.tools.maxIterations).toBe(12);
  });

  it('replaces arrays and scalars instead of merging them', () => {
    expect(deepMerge({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { d: 5 } })).toEqual({
      a: [3],
      b: { c: 1, d: 5 },
    });
  });

  it('ignores __proto__, constructor, and prototype keys in deepMerge', () => {
    const payload = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"prototype": {"x": 1}}, "safe": 42}',
    ) as Record<string, unknown>;
    const merged = deepMerge({ a: 1 }, payload);
    expect((merged as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.hasOwn(merged, '__proto__')).toBe(false);
    expect(Object.hasOwn(merged, 'constructor')).toBe(false);
    expect(merged['safe']).toBe(42);
  });
});

describe('bundled suites and subsets', () => {
  it('locates the hard suite directory', () => {
    expect(resolveHardSuiteDir()).toMatch(/fixtures[\\/]hard$/);
  });

  it('rejects a subset file without a usable ids array', async () => {
    const file = path.join(root, 'bad.json');
    await fs.writeFile(file, JSON.stringify({ ids: [] }));
    await expect(loadSubsetIds(file, root)).rejects.toThrow(/non-empty "ids"/);
  });
});

describe('polyglot workdir preparation', () => {
  it('prepares a python exercise even when a listed test file is missing', async () => {
    const exercise = path.join(root, 'python', 'exercises', 'practice', 'adder');
    await fs.mkdir(path.join(exercise, '.meta'), { recursive: true });
    await fs.writeFile(
      path.join(exercise, '.meta', 'config.json'),
      JSON.stringify({ files: { solution: ['adder.py'], test: ['adder_test.py'] } }),
    );
    const [task] = await createPolyglotSuite({ polyglotDir: root }).loadTasks({});
    const workdir = path.join(root, 'work');
    await fs.mkdir(workdir);
    await expect(task?.prepareWorkdir?.(workdir)).resolves.toBeUndefined();

    // A test file that needs no rewrite is left byte-for-byte alone.
    await fs.writeFile(path.join(workdir, 'adder_test.py'), 'def test(): pass\n');
    const before = (await fs.stat(path.join(workdir, 'adder_test.py'))).mtimeMs;
    await task?.prepareWorkdir?.(workdir);
    expect((await fs.stat(path.join(workdir, 'adder_test.py'))).mtimeMs).toBe(before);
  });
});

describe('readTokenMetrics', () => {
  it('reads a leader transcript that spawned no subagents', async () => {
    const homeDir = path.join(root, 'home');
    const workdir = path.join(root, 'work');
    const sessions = resolveWstackPaths({
      projectRoot: workdir,
      globalRoot: homeDir,
    }).projectSessions;
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(
      path.join(sessions, 'sess_B.jsonl'),
      `${JSON.stringify({ type: 'llm_response', usage: { input: 10, output: 5 } })}\n`,
    );
    const m = await readTokenMetrics({ homeDir, workdir });
    expect(m.total).toBe(15);
    expect(m.subagentTotal).toBe(0);
  });
});

describe('remaining edges', () => {
  it('labels the harness profile in the report header', async () => {
    const { computeHarnessFingerprint, fingerprintLabel } = await import('../src/fingerprint.js');
    const fp = computeHarnessFingerprint({
      cliVersion: '1',
      toolNames: [],
      maxIterations: 1,
      yolo: false,
      subsetId: 's',
      profile: 'lean',
    });
    expect(fingerprintLabel(fp)).toContain('profile=lean');
  });

  it('skips a response without a usage record', async () => {
    const homeDir = path.join(root, 'home');
    const workdir = path.join(root, 'work');
    const sessions = resolveWstackPaths({
      projectRoot: workdir,
      globalRoot: homeDir,
    }).projectSessions;
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(
      path.join(sessions, 'sess_C.jsonl'),
      `${JSON.stringify({ type: 'llm_response' })}\n`,
    );
    expect((await readTokenMetrics({ homeDir, workdir })).requests).toBe(0);
  });

  it('leaves a cpp CMakeLists without a slug unpinned', async () => {
    const { preparedText } = await import('../src/suites/polyglot.js');
    const meta = {
      language: 'cpp',
      solutionFiles: [],
      testFiles: [],
      testCommand: { command: 'cmake', args: [] },
    };
    expect(preparedText(meta, 'CMakeLists.txt', 'get_filename_component(x)')).toBe(
      'get_filename_component(x)',
    );
  });
});
