import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execCommand } from '../exec-command.js';
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

const CPP_GRADE_BUILD_DIR = '.bench-build';
// Aider's script uses Unix Makefiles; Windows dev boxes rarely have make on PATH.
/* v8 ignore next -- one side per host platform. */
const CPP_GENERATOR = process.platform === 'win32' ? 'Ninja' : 'Unix Makefiles';

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
    // A per-workdir install, as Aider's harness has: sharing one tree across
    // workdirs let agents empty it through the link mid-run. With a warm npm
    // cache --prefer-offline takes ~15 s.
    setup: { command: 'npm', args: ['install', '--prefer-offline', '--no-audit', '--no-fund'] },
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
  // Aider's cpp-test.sh: configure with every test enabled, then build — the
  // CMakeLists makes running the test binary part of the default target. A
  // dedicated build dir keeps an agent's own `build/` cache (possibly another
  // generator) from breaking the configure step.
  cpp: {
    dir: 'cpp',
    setup: {
      command: 'cmake',
      args: [
        '-S',
        '.',
        '-B',
        CPP_GRADE_BUILD_DIR,
        '-G',
        CPP_GENERATOR,
        '-DEXERCISM_RUN_ALL_TESTS=1',
      ],
    },
    test: () => ({ command: 'cmake', args: ['--build', CPP_GRADE_BUILD_DIR] }),
  },
  java: {
    dir: 'java',
    test: () => ({
      /* v8 ignore next -- one side per host platform. */
      command: process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew',
      args: ['test'],
    }),
  },
};

/** Metadata the polyglot grader reads off each task. */
export interface PolyglotMeta {
  language: string;
  solutionFiles: string[];
  testFiles: string[];
  testCommand: { command: string; args: string[] };
  setupCommand?: { command: string; args: string[] } | undefined;
  /** Exercise slug; cpp's CMakeLists is pinned to it. Absent in old artifacts. */
  slug?: string | undefined;
  /**
   * Build/test scaffolding restored from the template before grading, like
   * the tests: an agent that rewrote `build.gradle` or the CMake test target
   * could otherwise skip the suite. Absent in old artifacts.
   */
  harnessFiles?: string[] | undefined;
}

/** Scaffolding per language that grading must see as shipped. */
const HARNESS_FILES: Record<string, string[]> = {
  cpp: ['CMakeLists.txt', 'test/tests-main.cpp', 'test/catch.hpp'],
  java: ['build.gradle'],
};

export function createPolyglotSuite(opts: {
  /** Local checkout of the polyglot-benchmark repo. */
  polyglotDir: string;
  /** Restrict to these languages (default: all present). */
  languages?: string[] | undefined;
  /**
   * Pinned task ids (`polyglot/<language>/<slug>`). When set, only these load,
   * and an id missing from the checkout is an error: a silently shrunken
   * subset would publish a score over fewer tasks than it claims.
   */
  ids?: string[] | undefined;
}): BenchSuite {
  return {
    id: 'polyglot',
    async loadTasks({ limit }) {
      const tasks: BenchTask[] = [];
      const wanted = opts.ids ? new Set(opts.ids) : undefined;
      const langs = opts.languages ?? Object.keys(LANGUAGE_RUNNERS);
      for (const lang of langs) {
        if (!Object.hasOwn(LANGUAGE_RUNNERS, lang)) continue;
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
          if (wanted && !wanted.has(`polyglot/${lang}/${slug}`)) continue;
          const exerciseDir = path.join(practiceDir, slug);
          const task = await loadExercise(exerciseDir, lang, runner, slug);
          if (task) tasks.push(task);
          if (limit !== undefined && tasks.length >= limit) return tasks;
        }
      }
      if (wanted) {
        const loaded = new Set(tasks.map((task) => task.id));
        const missing = [...wanted].filter(
          (id) =>
            !loaded.has(id) && (!opts.languages || opts.languages.includes(id.split('/')[1] ?? '')),
        );
        if (missing.length > 0) {
          throw new Error(
            `polyglot subset names ${missing.length} task(s) not in this checkout: ${missing.slice(0, 5).join(', ')}`,
          );
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
    slug,
    harnessFiles: HARNESS_FILES[language] ?? [],
  };

  return {
    id: `polyglot/${language}/${slug}`,
    suite: 'polyglot',
    prepareWorkdir: async (workdir) => {
      await prepareExercise(workdir, meta);
      await installDependencies(workdir, meta);
    },
    prompt: buildPrompt(instructions, solutionFiles, testFiles),
    templateDir: exerciseDir,
    // Never copy the reference solution into the agent's workdir.
    templateExclude: ['.meta'],
    meta: meta as never as Record<string, unknown>,
  };
}

/** Apply {@link preparedText} to a freshly copied workdir before the agent starts. */
export async function prepareExercise(workdir: string, meta: PolyglotMeta): Promise<void> {
  for (const rel of [...meta.testFiles, ...(meta.harnessFiles ?? [])]) {
    const full = path.join(workdir, rel);
    let text: string;
    try {
      text = await fs.readFile(full, 'utf8');
    } catch {
      continue;
    }
    const next = preparedText(meta, rel, text);
    if (next !== text) await fs.writeFile(full, next, 'utf8');
  }
}

const DEPENDENCY_INSTALL_TIMEOUT_MS = 300_000;

/**
 * Install the exercise's dependencies before the agent starts, as Aider's
 * harness does. Only the grader used to run `npm install`, so the agent saw no
 * node_modules: `npx jest` fetched a bare jest without the exercise's babel
 * preset and failed to load the spec — 83 of 137 JS sessions (2026-10-28) hit
 * it, then either spent ~30 s installing or verified with a hand-written
 * runner the real suite later failed. A failed install is left for the grader
 * to report; it reruns setup anyway.
 */
export async function installDependencies(
  workdir: string,
  meta: PolyglotMeta,
  run: typeof execCommand = execCommand,
): Promise<void> {
  if (meta.language !== 'javascript' || !meta.setupCommand) return;
  await run({
    command: meta.setupCommand.command,
    args: meta.setupCommand.args,
    cwd: workdir,
    timeoutMs: DEPENDENCY_INSTALL_TIMEOUT_MS,
  });
}

/**
 * The shipped file as the harness runs it. Exported so the grader restores
 * to exactly this content.
 *
 * - JS `xtest(` and Java `@Disabled(...)` are un-skipped (Aider's
 *   `npm-test.sh` sed and `benchmark.py` strip). Exercism disables all but
 *   the first test in 48 of 49 JS and 48 Java exercises; graded as shipped, a
 *   stub that passed that one test scored as a solve. Rust is covered by
 *   `--include-ignored`, cpp by `EXERCISM_RUN_ALL_TESTS`.
 * - cpp's CMakeLists names its target after the directory, and a bench
 *   workdir is `<cell>-<hash>__<task>-<hash>`, so the name is pinned to the
 *   slug. Catch's `__COUNTER__` is also a `-Wpedantic` error on clang 23+
 *   (`-Wc2y-extensions`), toolchain noise unrelated to the solution.
 */
export function preparedText(meta: PolyglotMeta, rel: string, text: string): string {
  if (meta.testFiles.includes(rel)) {
    if (meta.language === 'javascript') return text.replace(/\bxtest\(/g, 'test(');
    if (meta.language === 'java') return text.replace(/@Disabled\([^)]*\)\s*\n/g, '');
  }
  if (meta.language === 'cpp' && rel === 'CMakeLists.txt') {
    let next = text.replace(
      '-Wall -Wextra -Wpedantic -Werror"',
      '-Wall -Wextra -Wpedantic -Werror -Wno-c2y-extensions"',
    );
    if (meta.slug) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal CMake text
      const derived = 'get_filename_component(exercise ${CMAKE_CURRENT_SOURCE_DIR} NAME)';
      next = next.replace(derived, `set(exercise ${meta.slug})`);
    }
    return next;
  }
  return text;
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
