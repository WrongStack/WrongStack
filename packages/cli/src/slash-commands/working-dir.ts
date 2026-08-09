import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/core/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

/**
 * Register the `/working_dir` slash command (aliases: `/wd`, `/cd`).
 *
 * Usage:
 *   /working_dir                Show current working directory
 *   /working_dir <path>         Change working directory to <path>
 *
 * The path must be inside the project root. Relative paths resolve from
 * the project root, not the current working directory (by convention).
 */
export function buildWorkingDirCommand(_opts: SlashCommandContext): SlashCommand {
  return {
    name: 'working_dir',
    category: 'Session',
    aliases: ['wd', 'cd'],
    description: 'Show or change the current working directory within the project.',
    help: [
      'Usage:',
      '  /working_dir               Show current working directory',
      '  /working_dir <path>        Navigate to a subdirectory within the project',
      '',
      'Aliases: /wd, /cd',
      'The path must be inside the project root. Relative paths resolve',
      'from the project root. Use `.` to reset to the project root.',
      'Changes propagate to the statusline and WebUI via WebSocket.',
    ].join('\n'),
    async run(args, ctx) {
      if (!ctx) {
        return { message: color.yellow('No active context. Start a session first.') };
      }

      const trimmed = args.trim();

      // Show current directory
      if (!trimmed) {
        const rel = path.relative(ctx.projectRoot, ctx.workingDir) || '.';
        return {
          message: [
            `Working directory: ${color.bold(ctx.workingDir)}`,
            color.dim(`  (relative to root: ${rel})`),
            color.dim(`  Project root: ${ctx.projectRoot}`),
          ].join('\n'),
        };
      }

      // Resolve the target path
      const resolved = path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : path.resolve(ctx.projectRoot, trimmed);

      // Check containment within project root
      const root = path.resolve(ctx.projectRoot);
      const rel = path.relative(root, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return {
          message: color.red(
            `Directory "${trimmed}" is outside the project root.\n` +
              `  Resolved: ${resolved}\n` +
              `  Root:     ${root}`,
          ),
        };
      }

      // Check the directory exists
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) {
          return { message: color.red(`Not a directory: ${resolved}`) };
        }
      } catch {
        return { message: color.red(`Directory does not exist: ${resolved}`) };
      }

      // Change it
      const previous = ctx.workingDir;
      try {
        ctx.setWorkingDir(resolved);
      } catch (err) {
        return {
          message: color.red(toErrorMessage(err)),
        };
      }

      const prevRel = path.relative(ctx.projectRoot, previous) || '.';
      const newRel = path.relative(ctx.projectRoot, resolved) || '.';

      return {
        message: [
          color.green(`  ✓ ${prevRel} → ${color.bold(newRel)}`),
          color.dim(`    ${resolved}`),
        ].join('\n'),
      };
    },
  };
}
