import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/contracts/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';
import { detectProjectFacts, renderAgentsTemplate } from './helpers.js';

export function buildInitCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'init',
    category: 'Config',
    description: 'Create or update .wrongstack/AGENTS.md project context for the system prompt.',
    async run(_args, ctx) {
      // Per-dispatch ctx wins: the REPL/TUI pass the live run's projectRoot
      // (and tests pass a sandbox dir). The builder-level opts.projectRoot /
      // process.cwd() are fallbacks for dispatches without a Context — using
      // them unconditionally made /init write into the host repo's
      // .wrongstack/AGENTS.md regardless of the active project.
      const root = ctx?.projectRoot ?? opts.projectRoot ?? process.cwd();
      const dir = path.join(root, '.wrongstack');
      const file = path.join(dir, 'AGENTS.md');

      // Check BEFORE writing — was this file missing?
      const isFirstInit = !(await fileExists(file));

      const detected = await detectProjectFacts(root);
      const body = renderAgentsTemplate(detected);
      await fs.mkdir(dir, { recursive: true });
      // Back up any existing AGENTS.md before overwriting so hand-written
      // project context isn't silently lost on a re-init. One fixed `.bak`
      // overwritten on every run lost it on the SECOND /init (the backup became
      // the first run's template), and a failed backup used to be ignored.
      let backedUp: string | undefined;
      if (!isFirstInit) {
        try {
          const current = await fs.readFile(file, 'utf8');
          backedUp = current === body ? undefined : await backupWithoutClobbering(file, current);
        } catch (err) {
          const msg = `Did not rewrite ${file}: could not back it up first (${err instanceof Error ? err.message : String(err)}).`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
      }
      await fs.writeFile(file, body, 'utf8');

      // Detect Node.js project for tech stack scan suggestion
      let nodePkg = false;
      try {
        await fs.access(path.join(root, 'package.json'));
        nodePkg = true;
      } catch {
        // Not a Node.js project — skip techstack suggestion.
      }

      const lines: string[] = [];
      const wroteMsg = `Wrote ${file}`;
      lines.push(wroteMsg);
      opts.renderer.writeInfo(wroteMsg);
      if (backedUp) {
        const backupLine = `Backed up the previous AGENTS.md to ${backedUp}`;
        opts.renderer.writeInfo(backupLine);
        lines.push(backupLine);
      }

      if (detected.hints.length > 0) {
        const hintLine = `Pre-filled: ${detected.hints.join(', ')}. Edit the file with project context and instructions the system prompt should carry.`;
        opts.renderer.writeInfo(hintLine);
        lines.push(hintLine);
      } else {
        lines.push(
          'No project type auto-detected. Edit the file with project context and instructions the system prompt should carry.',
        );
      }

      // On first init of a Node.js project, suggest (or auto-run) tech stack scan
      if (nodePkg && isFirstInit) {
        const techHint = [
          '',
          `${color.cyan('💡')} ${color.bold('Tech Stack Audit')} — This is a Node.js project with a fresh init.`,
          color.dim('  The LLM may have suggested stale version numbers. Run'),
          `  ${color.cyan('/techstack --init')}  to scan dependencies and verify versions.`,
        ].join('\n');
        opts.renderer.write(techHint);
        lines.push(techHint);
      }

      return { message: lines.join('\n') };
    },
  };
}

/**
 * Copy `file` to a backup path that never replaces a different earlier backup:
 * `<file>.bak` when free (or already holding this exact content), otherwise a
 * timestamped sibling. Returns the backup path; throws when nothing was saved.
 */
async function backupWithoutClobbering(file: string, current: string): Promise<string> {
  const primary = `${file}.bak`;
  try {
    await fs.copyFile(file, primary, fsConstants.COPYFILE_EXCL);
    return primary;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  if ((await fs.readFile(primary, 'utf8')) === current) return primary;
  const stamped = `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  await fs.copyFile(file, stamped, fsConstants.COPYFILE_EXCL);
  return stamped;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
