import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LANGUAGE_RUNNERS,
  createPolyglotSuite,
  type PolyglotMeta,
} from '../src/suites/polyglot.js';

let root: string;

async function writeExercise(
  lang: string,
  slug: string,
  opts: {
    solution?: string[];
    test?: string[];
    config?: boolean;
    docs?: Record<string, string>;
  } = {},
): Promise<void> {
  const dir = path.join(root, lang, 'exercises', 'practice', slug);
  await fs.mkdir(path.join(dir, '.meta'), { recursive: true });
  if (opts.config !== false) {
    await fs.writeFile(
      path.join(dir, '.meta', 'config.json'),
      JSON.stringify({
        files: {
          solution: opts.solution ?? [`${slug}.py`],
          test: opts.test ?? [`${slug}_test.py`],
        },
      }),
    );
  }
  const docs = opts.docs ?? { 'instructions.md': `Solve ${slug}.` };
  await fs.mkdir(path.join(dir, '.docs'), { recursive: true });
  for (const [name, content] of Object.entries(docs)) {
    await fs.writeFile(path.join(dir, '.docs', name), content);
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'polyglot-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createPolyglotSuite.loadTasks', () => {
  it('loads exercises into BenchTasks with prompt, exclude and meta', async () => {
    await writeExercise('python', 'bowling', {
      solution: ['bowling.py'],
      test: ['bowling_test.py'],
      docs: {
        'introduction.md': 'Intro.',
        'instructions.md': 'Do it.',
        'instructions.append.md': 'Extra.',
      },
    });
    const suite = createPolyglotSuite({ polyglotDir: root, languages: ['python'] });
    const tasks = await suite.loadTasks({});
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t.id).toBe('polyglot/python/bowling');
    expect(t.suite).toBe('polyglot');
    expect(t.templateExclude).toEqual(['.meta']);
    expect(t.prompt).toMatch(/Intro\./);
    expect(t.prompt).toMatch(/Extra\./);
    expect(t.prompt).toMatch(/bowling\.py/);
    expect(t.prompt).toMatch(/bowling_test\.py/);
    const meta = t.meta as never as PolyglotMeta;
    expect(meta.language).toBe('python');
    expect(meta.testCommand).toEqual({
      command: 'python',
      args: ['-m', 'pytest', '-q', 'bowling_test.py'],
    });
  });

  it('sorts slugs and respects the limit', async () => {
    await writeExercise('python', 'zebra');
    await writeExercise('python', 'apple');
    const suite = createPolyglotSuite({ polyglotDir: root, languages: ['python'] });
    const limited = await suite.loadTasks({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.id).toBe('polyglot/python/apple'); // sorted, apple first
  });

  it('defaults to all known languages when none are specified', async () => {
    await writeExercise('go', 'gcd', { solution: ['gcd.go'], test: ['gcd_test.go'] });
    const suite = createPolyglotSuite({ polyglotDir: root });
    const tasks = await suite.loadTasks({});
    expect(tasks.map((t) => t.id)).toContain('polyglot/go/gcd');
  });

  it('skips unknown languages and absent practice dirs', async () => {
    const suite = createPolyglotSuite({ polyglotDir: root, languages: ['cobol', 'python'] });
    // cobol → not in LANGUAGE_RUNNERS (continue); python → practice dir missing (continue)
    expect(await suite.loadTasks({})).toEqual([]);
  });

  it('skips exercises missing a config.json', async () => {
    await writeExercise('python', 'noconfig', { config: false });
    const suite = createPolyglotSuite({ polyglotDir: root, languages: ['python'] });
    expect(await suite.loadTasks({})).toEqual([]);
  });

  it('skips exercises with no solution files', async () => {
    await writeExercise('python', 'empty', { solution: [] });
    const suite = createPolyglotSuite({ polyglotDir: root, languages: ['python'] });
    expect(await suite.loadTasks({})).toEqual([]);
  });

  it('skips exercises whose config omits the files manifest', async () => {
    const dir = path.join(root, 'python', 'exercises', 'practice', 'nofiles');
    await fs.mkdir(path.join(dir, '.meta'), { recursive: true });
    await fs.writeFile(path.join(dir, '.meta', 'config.json'), '{}'); // no `files` key
    const suite = createPolyglotSuite({ polyglotDir: root, languages: ['python'] });
    expect(await suite.loadTasks({})).toEqual([]);
  });

  it('builds a prompt noting a hidden suite when there are no test files', async () => {
    await writeExercise('python', 'hidden', { solution: ['hidden.py'], test: [] });
    const suite = createPolyglotSuite({ polyglotDir: root, languages: ['python'] });
    const tasks = await suite.loadTasks({});
    expect(tasks[0]!.prompt).toMatch(/A hidden test suite will be run/);
  });
});

describe('createPolyglotSuite.subsetId', () => {
  it('is order-independent and stable', () => {
    const suite = createPolyglotSuite({ polyglotDir: root });
    const a = [{ id: 'x' }, { id: 'y' }] as never;
    const b = [{ id: 'y' }, { id: 'x' }] as never;
    expect(suite.subsetId(a)).toBe(suite.subsetId(b));
    expect(suite.subsetId(a)).toMatch(/^polyglot:[0-9a-f]{12}$/);
  });
});

describe('LANGUAGE_RUNNERS', () => {
  it('every language exposes a working test command (and js a setup step)', () => {
    for (const [lang, runner] of Object.entries(LANGUAGE_RUNNERS)) {
      expect(runner.dir).toBe(lang);
      const cmd = runner.test(['some_test']);
      expect(typeof cmd.command).toBe('string');
      expect(Array.isArray(cmd.args)).toBe(true);
    }
    expect(LANGUAGE_RUNNERS.javascript!.setup).toEqual({
      command: 'npm',
      args: ['install', '--no-audit', '--no-fund'],
    });
  });
});
