import type { SlashCommand } from '@wrongstack/contracts/types';
import type { SlashCommandContext } from './command-context.js';

export function buildDiagCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'diag',
    category: 'Inspect',
    description: 'Show runtime diagnostics (provider, tokens, tools, MCP).',
    async run() {
      if (!opts.onDiag) return { message: 'Diag not available in this context.' };
      return { message: opts.onDiag() };
    },
  };
}

export function buildStatsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'stats',
    category: 'Inspect',
    description: 'Show session report: tokens, requests, tools, files, cost.',
    async run() {
      if (!opts.onStats) return { message: 'Stats not available in this context.' };
      const text = opts.onStats();
      return { message: text ?? 'No session activity recorded yet.' };
    },
  };
}
