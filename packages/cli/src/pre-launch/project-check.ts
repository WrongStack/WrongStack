// Project detection — scans the working directory for AGENTS.md or a recognized
// manifest, scaffolds AGENTS.md on request, and decides whether to bail out.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import type { ReadlineInputReader } from '../input-reader.js';
import type { TerminalRenderer } from '../renderer.js';
import { detectProjectFacts, renderAgentsTemplate } from '../services/project-facts.js';

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
        renderer.writeError(`Failed to scaffold AGENTS.md: ${toErrorMessage(err)}`);
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
        renderer.writeError(`git init failed: ${toErrorMessage(err)}\n`);
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
