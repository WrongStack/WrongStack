import type { SlashCommand } from '@wrongstack/core/types';
import type { SlashCommandContext } from './command-context.js';

/**
 * /worktree — inspect and manage the git worktrees Goal uses for per-phase
 * isolation. Subcommands: list (default), merge <branch>, prune, clean.
 */
export function buildWorktreeCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'worktree',
    category: 'Config',
    aliases: ['wt'],
    description: 'Inspect/manage git worktrees used for Goal per-phase isolation.',
    argsHint: '[list | merge <branch> | prune | clean]',
    help: [
      'Usage: /worktree [subcommand]',
      '',
      '  list             List active worktrees (default).',
      '  merge <branch>   Squash-merge <branch> into the current branch.',
      '  prune            Remove stale worktree administrative entries.',
      '  clean            Remove all wstack-managed worktrees and branches.',
      '',
      'merge and clean are destructive — they prompt for confirmation. Pass',
      '--yes (-y) to skip the prompt. Goal allocates one worktree per phase',
      'under .wrongstack/worktrees/ so parallelizable phases run isolated.',
    ].join('\n'),

    async run(args) {
      if (!opts.onWorktree) {
        return { message: '⚠ No worktree manager active in this session.' };
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const skipConfirm = parts.includes('--yes') || parts.includes('-y');
      const positional = parts.filter((p) => p !== '--yes' && p !== '-y');
      const sub = (positional[0] ?? 'list').toLowerCase();

      // Confirm destructive actions when an interactive prompt is available.
      // confirm() resolves to its default on non-TTY/EOF, so non-interactive
      // callers (and tests) proceed without hanging.
      const confirmDestructive = async (question: string): Promise<boolean> => {
        if (skipConfirm || !opts.confirm) return true;
        const answer = await opts.confirm(question, false);
        return answer === true;
      };

      switch (sub) {
        case 'list':
          return { message: await opts.onWorktree('list') };
        case 'merge': {
          const branch = positional[1];
          if (!branch) return { message: 'Usage: /worktree merge <branch> [--yes]' };
          if (!(await confirmDestructive(`Squash-merge "${branch}" into the current branch?`))) {
            return { message: 'Merge cancelled.' };
          }
          return { message: await opts.onWorktree('merge', branch) };
        }
        case 'prune':
          return { message: await opts.onWorktree('prune') };
        case 'clean': {
          if (
            !(await confirmDestructive('Remove ALL wstack-managed worktrees and their branches?'))
          ) {
            return { message: 'Clean cancelled.' };
          }
          return { message: await opts.onWorktree('clean') };
        }
        default:
          return {
            message: `Unknown subcommand "${sub}". Valid: list, merge <branch>, prune, clean.`,
          };
      }
    },
  };
}
