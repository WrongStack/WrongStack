import type { Context } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { resetIndexCircuitBreaker, runStartupIndex } from '@wrongstack/tools';
import type { SlashCommandContext } from './command-context.js';

/**
 * `/codebase-reindex` — manually refresh the `codebase-search` symbol index.
 *
 * Incremental by default (unchanged files skipped via mtime); `force` clears and
 * rebuilds from scratch. Runs through the shared background indexer's mutex, so
 * it serializes safely with the session-start scan and live per-edit reindexes.
 */
export function buildCodebaseReindexCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'codebase-reindex',
    category: 'Inspect',
    aliases: ['reindex'],
    description: 'Rebuild the codebase symbol index used by codebase-search.',
    argsHint: '[force]',
    help: [
      'Usage:',
      '  /codebase-reindex          Incremental reindex (only changed files).',
      '  /codebase-reindex force    Clear the index and rebuild from scratch.',
      '',
      'The index powers codebase-search. It is normally kept fresh automatically',
      '(at session start and as files change); use this when you want to force a',
      'refresh — e.g. after a large branch switch, merge, or external edit.',
    ].join('\n'),
    async run(args: string, _ctx: Context) {
      const force = /\b(force|--force|-f)\b/.test(args.trim());

      opts.renderer.write(color.dim(`${force ? 'Rebuilding' : 'Reindexing'} codebase index…\n`));

      try {
        // A manual reindex is an explicit user override — close the circuit
        // breaker (it opens after repeated index failures/timeouts) so this
        // run is admitted instead of failing fast.
        resetIndexCircuitBreaker();
        const r = await runStartupIndex({ projectRoot: opts.projectRoot, force });
        const summary =
          `${color.green('✓')} codebase index ${force ? 'rebuilt' : 'updated'} ` +
          color.dim(`— ${r.symbolsIndexed} symbols · ${r.filesIndexed} files · ${r.durationMs}ms`) +
          (r.errors.length ? `\n${color.yellow(`  ${r.errors.length} file(s) had errors`)}` : '');
        return { message: summary };
      } catch (err) {
        const msg = `${color.red('Codebase reindex failed:')} ${toErrorMessage(err)}`;
        return { message: msg };
      }
    },
  };
}
