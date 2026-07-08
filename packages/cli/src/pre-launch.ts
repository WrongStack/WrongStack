import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, color } from '@wrongstack/core';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';
import { detectProjectFacts, renderAgentsTemplate } from './slash-commands/index.js';
import { toErrorMessage } from '@wrongstack/core/utils';

export type ProjectKind =
  /** `.wrongstack/AGENTS.md` exists — fully set up. */
  | 'initialized'
  /** Has a recognizable manifest (package.json, pyproject.toml, etc.) but no AGENTS.md yet. */
  | 'project'
  /** No manifest, no AGENTS.md — probably an empty/scratch directory. */
  | 'empty';

const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'Makefile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
];

export async function detectProjectKind(projectRoot: string): Promise<ProjectKind> {
  try {
    await fs.access(path.join(projectRoot, '.wrongstack', 'AGENTS.md'));
    return 'initialized';
  } catch {
    // not initialized
  }
  for (const m of MANIFESTS) {
    try {
      await fs.access(path.join(projectRoot, m));
      return 'project';
    } catch {
      // try next
    }
  }
  return 'empty';
}

async function scaffoldAgentsMd(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, '.wrongstack');
  const file = path.join(dir, 'AGENTS.md');
  const facts = await detectProjectFacts(projectRoot);
  const body = renderAgentsTemplate(facts);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, body, 'utf8');
  return file;
}

/**
 * Print a one-line project status banner and, when relevant, prompt the
 * user about scaffolding `AGENTS.md` or continuing in a directory that
 * doesn't look like a project. Returns `false` if the user bailed out.
 */
export async function runProjectCheck(opts: {
  projectRoot: string;
  /** The actual working directory — where the user is standing. Git init
   *  always happens here, never in a parent projectRoot that the walk-up
   *  detected. */
  cwd: string;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
}): Promise<boolean> {
  const { projectRoot, cwd, renderer, reader } = opts;
  const kind = await detectProjectKind(projectRoot);

  if (kind === 'initialized') {
    renderer.write(
      `\n  ${color.green('✓')} Project initialized ${color.dim(`(${path.join(projectRoot, '.wrongstack', 'AGENTS.md')})`)}\n`,
    );
    return true;
  }

  if (kind === 'project') {
    renderer.write(
      `\n  ${color.amber('●')} Project detected ${color.dim(`(${projectRoot})`)} but ${color.bold('.wrongstack/AGENTS.md')} is missing.\n`,
    );
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Scaffold ${color.bold('AGENTS.md')} now? ${color.dim('[y/N/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Cancelled.\n'));
      return false;
    }
    if (answer === 'y' || answer === 'yes') {
      try {
        const file = await scaffoldAgentsMd(projectRoot);
        renderer.write(`  ${color.green('✓')} Wrote ${color.dim(file)}\n`);
      } catch (err) {
        renderer.writeError(
          `Failed to scaffold AGENTS.md: ${toErrorMessage(err)}`,
        );
      }
    }
    return true;
  }

  // 'empty' — no manifest, no AGENTS.md, possibly no git
  const gitDir = path.join(projectRoot, '.git');
  let hasGit = false;
  try {
    await fs.access(gitDir);
    hasGit = true;
  } catch {
    // no git
  }

  if (!hasGit) {
    renderer.write(
      `\n  ${color.dim('○')} ${color.dim(`No project manifest in ${projectRoot} — running in a scratch directory.`)}\n`,
    );
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} No git repo found. ${color.bold('Initialize git?')} ${color.dim('[y/N/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Cancelled.\n'));
      return false;
    }
    if (answer === 'y' || answer === 'yes') {
      try {
        const { spawn } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          const child = spawn('git', ['init'], {
            cwd,
            signal: AbortSignal.timeout(10_000),
            windowsHide: true,
          });
          child.on('error', reject);
          child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`git init failed with ${code}`)),
          );
        });
        renderer.write(`  ${color.green('✓')} Git repository initialized\n`);
      } catch (err) {
        renderer.writeError(
          `git init failed: ${toErrorMessage(err)}\n`,
        );
      }
    }
  } else {
    renderer.write(
      `\n  ${color.dim('○')} ${color.dim(`No project manifest in ${projectRoot} — running in a scratch directory.`)}\n`,
    );
  }

  const answer = (
    await reader.readLine(`  ${color.amber('?')} Continue anyway? ${color.dim('[Y/n/q]')} `)
  )
    .trim()
    .toLowerCase();
  if (answer === 'q' || answer === 'n' || answer === 'no') {
    renderer.write(color.dim('  Cancelled.\n'));
    return false;
  }
  return true;
}

export interface LaunchModeChoices {
  /** TUI or plain REPL. */
  mode: 'tui' | 'repl';
  /** Auto-approve normal project work; destructive-gated calls may still prompt. */
  yolo: boolean;
  /** Start with Director mode on (fleet manifest + scratchpad enabled). */
  director: boolean;
  /** Initial autonomy mode. 'off' = stops after each turn; 'auto' = self-driving. */
  autonomy: 'off' | 'auto';
}

/**
 * Thrown by runLaunchPrompts when the user presses q to cancel.
 * Caught by boot.ts so it can exit cleanly without process.exit().
 */
export class LaunchAbortedError extends Error {
  readonly exitCode = 0;
  constructor() {
    super('Launch cancelled by user');
    this.name = 'LaunchAbortedError';
  }
}

/**
 * Ask for interactive mode (TUI vs REPL), YOLO, Director, and Autonomy.
 * Each prompt is skipped when the corresponding option is pinned via CLI
 * flag. Returns the resolved set.
 *
 * When `lastChoices` is provided (from saved config), the function shows a
 * one-line summary and asks **one** question: "Continue with these?" instead
 * of re-asking every prompt individually.
 *
 * @throws LaunchAbortedError when the user presses q to cancel.
 */
export async function runLaunchPrompts(opts: {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  modePinned?: 'tui' | 'repl' | undefined;
  yoloPinned?: boolean | undefined;
  directorPinned?: boolean | undefined;
  autonomyPinned?: 'off' | 'auto' | undefined;
  /** Saved launch preferences from a previous session (persisted to config). */
  lastChoices?: LaunchModeChoices | undefined;
}): Promise<LaunchModeChoices> {
  const { renderer, reader, modePinned, yoloPinned, directorPinned, autonomyPinned, lastChoices } =
    opts;

  // If EVERY field is pinned by CLI flags, skip all prompts entirely.
  if (
    modePinned !== undefined &&
    yoloPinned !== undefined &&
    directorPinned !== undefined &&
    autonomyPinned !== undefined
  ) {
    return {
      mode: modePinned,
      yolo: yoloPinned,
      director: directorPinned,
      autonomy: autonomyPinned,
    };
  }

  // --- Summary gate: when saved preferences exist, show them + one question ---
  if (lastChoices) {
    // Merge: pinned values override saved preferences.
    const effective = {
      mode: modePinned ?? lastChoices.mode,
      yolo: yoloPinned ?? lastChoices.yolo,
      director: directorPinned ?? lastChoices.director,
      autonomy: autonomyPinned ?? lastChoices.autonomy,
    };

    const onOff = (v: boolean) => (v ? color.green('on') : color.dim('off'));
    const modeLabel = effective.mode.toUpperCase();

    renderer.write(
      `\n  ${color.dim('Last settings:')} ${color.bold(modeLabel)} · YOLO ${onOff(effective.yolo)} · Director ${onOff(effective.director)} · Autonomy ${effective.autonomy === 'auto' ? color.green('auto') : color.dim('off')}\n`,
    );

    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Continue with these? ${color.dim('[Y/n/q]')} ${color.dim('(auto Y in 5s)')} `,
        { timeoutMs: 5000, defaultAnswer: 'y' },
      )
    )
      .trim()
      .toLowerCase();

    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }

    if (answer !== 'n' && answer !== 'no') {
      // User accepted — proceed with effective values.
      const badges = buildBadges(effective);
      const badgeStr = badges.length > 0 ? ` (${badges.join(' · ')})` : '';
      renderer.write(
        `\n  ${color.green('▶')} Launching in ${color.bold(modeLabel)} mode${badgeStr}\n\n`,
      );
      return effective;
    }

    // User said no — fall through to individual prompts.
  }

  // --- Individual prompts (existing behavior, one at a time) ---
  let mode: 'tui' | 'repl';
  if (modePinned) {
    mode = modePinned;
  } else {
    const answer = (
      await reader.readLine(
        `\n  ${color.amber('?')} Interactive mode: ${color.bold('T')}UI / ${color.bold('R')}EPL ${color.dim('[T/r/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }
    mode = answer === 'r' || answer === 'repl' ? 'repl' : 'tui';
  }

  let yolo: boolean;
  if (yoloPinned !== undefined) {
    yolo = yoloPinned;
  } else {
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} YOLO mode ${color.dim('(auto-approve normal project work)')} ${color.dim('[Y/n/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }
    yolo = answer !== 'n' && answer !== 'no';
  }

  let director: boolean;
  if (directorPinned !== undefined) {
    director = directorPinned;
  } else {
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Director mode ${color.dim('(fleet manifest + multi-agent orchestration)')} ${color.dim('[Y/n/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }
    director = answer !== 'n' && answer !== 'no';
  }

  let autonomy: 'off' | 'auto';
  if (autonomyPinned !== undefined) {
    autonomy = autonomyPinned;
  } else {
    const answer = (
      await reader.readLine(
        `  ${color.amber('?')} Autonomy mode ${color.dim('(auto-continue — agent picks next step)')} ${color.dim('[Y/n/q]')} `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') {
      renderer.write(color.dim('  Goodbye!\n'));
      throw new LaunchAbortedError();
    }
    autonomy = answer !== 'n' && answer !== 'no' ? 'auto' : 'off';
  }

  const badges = buildBadges({ mode, yolo, director, autonomy });
  const badgeStr = badges.length > 0 ? ` (${badges.join(' · ')})` : '';
  renderer.write(
    `\n  ${color.green('▶')} Launching in ${color.bold(mode.toUpperCase())} mode${badgeStr}\n\n`,
  );

  return { mode, yolo, director, autonomy };
}

/** Build the mode-badge labels shown in the launch line. */
function buildBadges(chosen: LaunchModeChoices): string[] {
  const badges: string[] = [];
  if (chosen.yolo) badges.push(color.yellow('YOLO'));
  if (chosen.director) badges.push(color.cyan('DIRECTOR'));
  if (chosen.autonomy !== 'off')
    badges.push(color.magenta(`AUTONOMY:${chosen.autonomy.toUpperCase()}`));
  return badges;
}

/**
 * Persist the user's launch-mode choices (mode, yolo, director, autonomy)
 * back to the global config file so the next boot can offer a one-line
 * "Continue with these?" summary instead of re-asking every question.
 *
 * Reads the existing config, updates only the `yolo` and `launch` keys,
 * and writes back atomically. Other fields (including encrypted secrets)
 * pass through round-trip unchanged.
 */
export async function persistLaunchChoices(
  configPath: string,
  choices: LaunchModeChoices,
): Promise<void> {
  let fileExists = false;
  try {
    await fs.access(configPath);
    fileExists = true;
  } catch {}

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (fileExists) {
      throw new Error(
        `Refusing to overwrite corrupt config at ${configPath} ` +
          `(${(err as Error).message}). Fix or move the file aside before retrying.`,
        { cause: err },
      );
    }
    // No existing file — start fresh, that's fine.
    existing = {};
  }

  existing.yolo = choices.yolo;
  existing.launch = {
    mode: choices.mode,
    director: choices.director,
    autonomy: choices.autonomy,
  };

  await atomicWrite(configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
}

// ─── Indexing question ────────────────────────────────────────────────────────

/**
 * File extensions the codebase indexer can parse. Matches `extToLang` in
 * `packages/tools/src/codebase-index/ts-parser.ts`.
 */
const INDEXABLE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.go',
  '.py',
  '.rs',
  '.json',
  '.yaml',
  '.yml',
]);

/**
 * Directories that should never be descended into when counting files.
 * Mirrors `DEFAULT_IGNORE` in the indexer.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '__snapshots__',
  '.nyc_output',
]);

/** Minimum number of indexable files before we consider asking about indexing. */
const DEFAULT_INDEX_QUESTION_THRESHOLD = 500;

/**
 * Resolve the indexing question threshold from the env var
 * `WRONGSTACK_INDEX_QUESTION_THRESHOLD`. Falls back to 500 when unset or invalid.
 *
 * Exported for testing only — callers should use {@link maybeAskAboutIndexing}.
 */
export function resolveIndexThreshold(): number {
  const raw = process.env['WRONGSTACK_INDEX_QUESTION_THRESHOLD'];
  if (raw === undefined || raw === '') return DEFAULT_INDEX_QUESTION_THRESHOLD;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_INDEX_QUESTION_THRESHOLD;
}

/**
 * Count indexable source files in the project. Stops early once the
 * threshold is reached — large codebases don't need a precise count.
 */
async function countProjectFiles(projectRoot: string, threshold: number): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission errors, missing dirs — skip
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (count >= threshold) return; // early exit
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        if (INDEXABLE_EXTS.has(path.extname(e.name))) {
          count++;
        }
      }
    }
  };
  await walk(projectRoot);
  return count;
}

/**
 * When the project has many indexable files, ask the user whether to run
 * startup codebase indexing now. Large codebases can take a while to index
 * on first launch — this lets the user skip it for the current session.
 *
 * The answer is **not persisted** — it affects only this session.
 *
 * @returns `true` (yes, index), `false` (skip), or `undefined` when
 *   no question was asked (codebase is small enough or indexing isn't
 *   configured).
 */
export async function maybeAskAboutIndexing(opts: {
  projectRoot: string;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  /** Only ask when the config has an `indexing` block (non-bare mode). */
  indexingConfigured: boolean;
}): Promise<boolean | undefined> {
  const { projectRoot, renderer, reader, indexingConfigured } = opts;

  // In bare mode there's no indexing block — the question is meaningless.
  if (!indexingConfigured) return undefined;

  const threshold = resolveIndexThreshold();
  const fileCount = await countProjectFiles(projectRoot, threshold);

  // Small / medium codebases — indexing is fast enough, don't bother the user.
  if (fileCount < threshold) return undefined;

  renderer.write(
    `\n  ${color.dim('○')} Large codebase detected ${color.dim(`(~${fileCount}+ indexable files)`)}\n`,
  );
  renderer.write(
    `  ${color.amber('⚠')} ${color.dim('Codebase search requires indexing — skipped by default.')}\n`,
  );

  const answer = (
    await reader.readLine(
      `  ${color.amber('?')} Run codebase indexing now? ${color.dim('[n/Y/q]')} ${color.dim('(auto n in 5s)')} `,
      { timeoutMs: 5000, defaultAnswer: 'n' },
    )
  )
    .trim()
    .toLowerCase();

  // 'q' means skip indexing (not abort launch — we're past the project check).
  if (answer === 'q') {
    renderer.write(color.dim('  Skipping indexing for this session.\n'));
    return false;
  }

  // Default on timeout or explicit 'n': skip.
  if (answer === 'n' || answer === 'no' || answer === '') {
    renderer.write(color.dim('  Skipping indexing for this session.\n'));
    return false;
  }

  // 'y' or 'yes' means yes.
  return true;
}
