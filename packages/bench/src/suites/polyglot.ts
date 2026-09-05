import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BenchSuite, BenchTask } from '../types.js';

/**
 * Aider polyglot benchmark loader.
 *
 * The polyglot-benchmark repo (https://github.com/Aider-AI/polyglot-benchmark)
 * lays exercises out in Exercism form:
 *
 *   <root>/<language>/exercises/practice/<slug>/
 *     .docs/instructions.md          ← problem statement
 *     .meta/config.json              ← Exercism file manifest (solution/test/example)
 *     .meta/example.<ext>            ← reference solution (EXCLUDED from the agent)
 *     <solution files>               ← stubs the agent edits
 *     <test files>                   ← the hidden tests the grader runs
 *
 * We do NOT vendor the exercises (225 across 6 languages); the caller points
 * `--polyglot-dir` at a local checkout.
 */

/** Per-language test command + optional dependency-install step. */
interface LanguageRunner {
  /** Directory name under the polyglot root. */
  dir: string;
  /** argv for the test command, run in the workdir. */
  test: (testFiles: string[]) => { command: string; args: string[] };
  /** argv for an optional setup/install step run before tests. */
  setup?: { command: string; args: string[] } | undefined;
}

const LANGUAGE_RUNNERS: Record<string, LanguageRunner> = {
  python: {
    dir: 'python',
    test: (tests) => ({ command: 'python', args: ['-m', 'pytest', '-q', ...tests] }),
  },
  javascript: {
    dir: 'javascript',
    setup: { command: 'npm', args: ['install', '--no-audit', '--no-fund'] },
    test: () => ({ command: 'npm', args: ['test'] }),
  },
  go: {
    dir: 'go',
    test: () => ({ command: 'go', args: ['test', './...'] }),
  },
  rust: {
    dir: 'rust',
    test: () => ({ command: 'cargo', args: ['test', '--', '--include-ignored'] }),
  },
  cpp: {
    dir: 'cpp',
    test: () => ({ command: 'cmake', args: ['--build', 'build', '--target', 'test'] }),
  },
  java: {
    dir: 'java',
    test: () => ({ command: './gradlew', args: ['test'] }),
  },
};

/** Metadata the polyglot grader reads off each task. */
export interface PolyglotMeta {
  language: string;
  solutionFiles: string[];
  testFiles: string[];
  testCommand: { command: string; args: string[] };
  setupCommand?: { command: string; args: string[] } | undefined;
}

export function createPolyglotSuite(opts: {
  /** Local checkout of the polyglot-benchmark repo. */
  polyglotDir: string;
  /** Restrict to these languages (default: all present). */
  languages?: string[] | undefined;
}): BenchSuite {
  return {
    id: 'polyglot',
    async loadTasks({ limit }) {
      const tasks: BenchTask[] = [];
      const langs = opts.languages ?? Object.keys(LANGUAGE_RUNNERS);
      for (const lang of langs) {
        const runner = LANGUAGE_RUNNERS[lang];
        if (!runner) continue;
        const practiceDir = path.join(opts.polyglotDir, runner.dir, 'exercises', 'practice');
        let slugs: string[];
        try {
          slugs = (await fs.readdir(practiceDir, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        } catch {
          continue; // language not present in this checkout
        }
        for (const slug of slugs) {
          const exerciseDir = path.join(practiceDir, slug);
          const task = await loadExercise(exerciseDir, lang, runner, slug);
          if (task) tasks.push(task);
          if (limit !== undefined && tasks.length >= limit) return tasks;
        }
      }
      return tasks;
    },
    subsetId(tasks) {
      // Order-independent digest of the exact task ids in this run.
      const ids = tasks.map((t) => t.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `polyglot:${createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 12)}`;
    },
  };
}

async function loadExercise(
  exerciseDir: string,
  language: string,
  runner: LanguageRunner,
  slug: string,
): Promise<BenchTask | undefined> {
  // Exercism manifest tells us which files are the solution vs the tests.
  let manifest: { files?: { solution?: string[]; test?: string[] } };
  try {
    const raw = await fs.readFile(path.join(exerciseDir, '.meta', 'config.json'), 'utf8');
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    return undefined; // not a well-formed exercise
  }
  const solutionFiles = manifest.files?.solution ?? [];
  const testFiles = manifest.files?.test ?? [];
  if (solutionFiles.length === 0) return undefined;

  const instructions = await readInstructions(exerciseDir);

  const meta: PolyglotMeta = {
    language,
    solutionFiles,
    testFiles,
    testCommand: runner.test(testFiles),
    setupCommand: runner.setup,
  };

  return {
    id: `polyglot/${language}/${slug}`,
    suite: 'polyglot',
    prompt: buildPrompt(instructions, solutionFiles, testFiles),
    templateDir: exerciseDir,
    // Never copy the reference solution into the agent's workdir.
    templateExclude: ['.meta'],
    meta: meta as never as Record<string, unknown>,
  };
}

async function readInstructions(exerciseDir: string): Promise<string> {
  const docs = path.join(exerciseDir, '.docs');
  const parts: string[] = [];
  for (const name of ['introduction.md', 'instructions.md', 'instructions.append.md']) {
    try {
      parts.push((await fs.readFile(path.join(docs, name), 'utf8')).trim());
    } catch {
      // optional file
    }
  }
  return parts.filter(Boolean).join('\n\n');
}

function buildPrompt(instructions: string, solutionFiles: string[], testFiles: string[]): string {
  return [
    instructions,
    '',
    '---',
    '',
    `Implement the solution by editing **only** these file(s): ${solutionFiles.join(', ')}.`,
    testFiles.length > 0
      ? `The test suite (${testFiles.join(', ')}) is already present and will be run to grade your work — do not modify the tests.`
      : 'A hidden test suite will be run to grade your work.',
    'Make the tests pass. Use the available file tools to read and edit the files. When the implementation is complete, stop.',
  ].join('\n');
}

export { LANGUAGE_RUNNERS };
