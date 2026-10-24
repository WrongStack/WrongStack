import type { SlashCommand } from '@wrongstack/contracts/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

function statusIcon(status: string): string {
  if (status === 'healthy') return color.green('●');
  if (status === 'degraded') return color.yellow('●');
  return color.red('●');
}

export function buildHealthCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage: /health [--json]',
    '',
    'Runs the host health registry and reports the worst aggregate status.',
    'Use --json for stable machine-readable output and slash-command metadata.',
    'Health collection requires --metrics or --metrics-port.',
  ].join('\n');
  return {
    name: 'health',
    category: 'Inspect',
    argsHint: '[--json]',
    description: 'Run health checks (requires --metrics flag).',
    help,
    async run(args: string) {
      const json = args.trim().split(/\s+/).includes('--json');
      const healthRegistry = opts.healthRegistry;
      if (!healthRegistry) {
        if (json) {
          const unavailable = { enabled: false, status: 'unavailable', checks: [] };
          return {
            message: JSON.stringify(unavailable, null, 2),
            metadata: { health: unavailable },
          };
        }
        return { message: 'Health checks not enabled. Restart with --metrics.' };
      }
      const result = await healthRegistry.run();
      if (json) {
        return { message: JSON.stringify(result, null, 2), metadata: { health: result } };
      }
      const lines = [
        `${statusIcon(result.status)} overall: ${result.status}`,
        ...result.checks.map((c) => {
          const detail = c.detail ? color.dim(` — ${c.detail}`) : '';
          return `  ${statusIcon(c.status)} ${c.name}: ${c.status}${detail}`;
        }),
      ];
      return { message: lines.join('\n') };
    },
  };
}
