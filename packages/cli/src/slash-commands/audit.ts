import type { SlashCommand } from '@wrongstack/core/types';
import type { SlashCommandContext } from './command-context.js';

/**
 * /audit — opens the TUI AuditPanel overlay showing the side-effect
 * timeline (bash commands, package installs, network requests).
 *
 * P2 #5 Phase 4: in the REPL (non-TUI) context, falls back to the /diag
 * output which already includes the side-effect section.
 */
export function buildAuditCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'audit',
    aliases: ['sideeffects', 'side'],
    category: 'Inspect',
    description:
      'Show the side-effect audit trail (bash, install, fetch). Filter: /audit [risk] [tool <name>] [<count>].',
    argsHint: '[risk] [tool <name>] [count]',
    async run(args) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      // Only open the TUI panel for the bare command; with filter args, render
      // the inline filtered view so the arguments actually take effect.
      if (tokens.length === 0 && opts.onPanelOpen.current) {
        const opened = opts.onPanelOpen.current('toggleAuditPanel');
        if (opened) return { message: '' };
      }
      // Fallback: render the side-effect section inline (REPL context).
      if (!opts.context) return { message: 'Audit not available in this context.' };
      let sideEffects = opts.context.sideEffects ?? [];
      if (sideEffects.length === 0) {
        return { message: 'No side effects recorded yet.' };
      }

      // Parse filters: a numeric token is the count; `tool <name>` filters by
      // tool; any other token is treated as a risk-level filter.
      const RISKS = new Set(['low', 'medium', 'high', 'critical']);
      let limit = 20;
      let riskFilter: string | undefined;
      let toolFilter: string | undefined;
      for (let i = 0; i < tokens.length; i++) {
        const tok = (tokens[i] ?? '').toLowerCase();
        if (/^\d+$/.test(tok)) {
          limit = Math.min(500, Math.max(1, Number.parseInt(tok, 10)));
        } else if ((tok === 'tool' || tok === '--tool') && tokens[i + 1]) {
          toolFilter = (tokens[++i] ?? '').toLowerCase();
        } else if (tok === '--risk' && tokens[i + 1]) {
          riskFilter = (tokens[++i] ?? '').toLowerCase();
        } else if (RISKS.has(tok)) {
          riskFilter = tok;
        }
      }
      if (riskFilter)
        sideEffects = sideEffects.filter((se) => se.risk.toLowerCase() === riskFilter);
      if (toolFilter)
        sideEffects = sideEffects.filter((se) => se.toolName.toLowerCase().includes(toolFilter));

      if (sideEffects.length === 0) {
        const what = [riskFilter && `risk=${riskFilter}`, toolFilter && `tool~${toolFilter}`]
          .filter(Boolean)
          .join(', ');
        return { message: `No side effects match the filter (${what}).` };
      }

      const lines = sideEffects.slice(-limit).map((se) => {
        const time = se.ts.slice(11, 19);
        const detail = se.outcome ? ` → ${se.outcome}` : '';
        const input = se.input['command'] ?? se.input['url'] ?? se.input['packages'] ?? '';
        return `  ${time}  ${se.toolName.padEnd(8)} ${se.risk.padEnd(7)} ${String(input).slice(0, 60)}${detail}`;
      });
      const filterNote = [riskFilter && `risk=${riskFilter}`, toolFilter && `tool~${toolFilter}`]
        .filter(Boolean)
        .join(', ');
      const heading = filterNote
        ? `Side Effects (last ${Math.min(limit, sideEffects.length)}, ${filterNote}):`
        : `Side Effects (last ${Math.min(limit, sideEffects.length)}):`;
      return { message: `${heading}\n${lines.join('\n')}` };
    },
  };
}
