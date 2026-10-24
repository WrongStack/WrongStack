import type { SlashCommand } from '@wrongstack/contracts/types';
import { getResolvedSandboxConfig, getSandboxAuditLog } from '@wrongstack/core/sandbox';
import type { SlashCommandContext } from './command-context.js';

/** CLI active-tier indicator (plan 28 T3; TUI/WebUI panels remain T9). */
export function buildSandboxCommand(_opts: SlashCommandContext): SlashCommand {
  return {
    name: 'sandbox',
    category: 'Inspect',
    description: 'Show the active exec-sandbox tier and policy (plan 28).',
    argsHint: '[--audit]',
    help: [
      'Usage: /sandbox [--audit]',
      '',
      '  Shows the resolved exec-sandbox policy for bash/exec/git tools:',
      '  mode (off|enforced), tier (read-only|workspace-write|full-access),',
      '  backend, and writableRoots.',
      '',
      '  --audit   Additionally show the last audit records (denials and',
      '            expansion requests/outcomes) from this process.',
      '',
      'Configure via tools.sandbox in your profile config; a repo-committed',
      '.wrongstack/config.json may only set mode/tier (backend and',
      'writableRoots are stripped by the in-project policy).',
    ].join('\n'),
    async run(args) {
      const cfg = getResolvedSandboxConfig();
      const lines = [
        'Exec sandbox (plan 28)',
        `  mode:          ${cfg.mode}`,
        `  tier:          ${cfg.tier}`,
        `  backend:       ${cfg.backend}`,
        `  writableRoots: ${cfg.writableRoots.length === 0 ? '(none)' : cfg.writableRoots.slice(0, 5).join(', ') + (cfg.writableRoots.length > 5 ? ` (+${cfg.writableRoots.length - 5} more)` : '')}`,
      ];
      if (/--audit/.test(args)) {
        const log = getSandboxAuditLog();
        lines.push('', `Audit (last ${Math.min(log.length, 10)} of ${log.length}):`);
        if (log.length === 0) {
          lines.push('  (no records)');
        } else {
          for (const rec of log.slice(-10)) {
            lines.push(`  ${rec.at} ${rec.kind} ${rec.tool} ${JSON.stringify(rec.detail)}`);
          }
        }
      }
      return { message: lines.join('\n'), metadata: { sandbox: cfg } };
    },
  };
}
