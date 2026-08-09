import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/core/types';
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
      // project context isn't silently lost on a re-init.
      let backedUp = false;
      if (!isFirstInit) {
        try {
          await fs.copyFile(file, `${file}.bak`);
          backedUp = true;
        } catch {
          // Best-effort backup — proceed with the write regardless.
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
        const backupLine = `Backed up the previous AGENTS.md to ${file}.bak`;
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
