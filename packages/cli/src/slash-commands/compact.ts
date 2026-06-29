import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildCompactCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'compact',
    category: 'Session',
    description: 'Compact the context window.',
    help: [
      'Usage:',
      '  /compact              Run the configured compactor with default settings.',
      '  /compact aggressive   Compact more aggressively.',
      '',
      'The compactor summarizes older turns to reclaim tokens.',
    ].join('\n'),
    async run(args, ctx) {
      if (!ctx) {
        const msg = 'No agent context available.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }
      if (!opts.compactor) {
        const msg = 'No compactor configured.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }
      const aggressive = args.trim() === 'aggressive';
      const report = await opts.compactor.compact(ctx, { aggressive });

      // Update token stash and token counter so the TUI/REPL context bar
      // reflects the post-compaction size immediately (no API request was made).
      if (report.fullRequestTokensAfter !== undefined) {
        ctx.lastRequestTokens = report.fullRequestTokensAfter;
        ctx.tokenCounter?.setCurrentRequestTokens(report.fullRequestTokensAfter);
      }

      // Compute context fill percentage for the output message.
      const metaMax = ctx.meta?.['effectiveMaxContext'];
      const maxCtx =
        (typeof metaMax === 'number' ? metaMax : undefined) ??
        ctx.provider?.capabilities?.maxContext ??
        0;
      const afterTokens = report.fullRequestTokensAfter ?? report.after;
      const pct = maxCtx > 0 ? Math.round((afterTokens / maxCtx) * 100) : -1;
      const ctxInfo = pct >= 0 ? ` at ${pct}%` : '';

      const reductions = report.reductions
        .map((r: { phase: string; saved: number }) => `${r.phase}: ${r.saved}`)
        .join(', ');
      const repaired = report.repaired
        ? `; repaired ${report.repaired.removedToolUses.length} tool_use, ${report.repaired.removedToolResults.length} tool_result, ${report.repaired.removedMessages} empty messages`
        : '';

      if (report.before === report.after && !report.repaired) {
        const msg = `Context${ctxInfo} (${report.after} tokens) already optimal — nothing to compact.`;
        opts.renderer.writeInfo(msg);
        return { message: msg };
      }

      const msg = `Compacted${ctxInfo}: ${report.before} → ${report.after} tokens${reductions ? ` (${reductions})` : ''}${repaired}`;
      opts.renderer.writeInfo(msg);
      return { message: msg };
    },
  };
}
