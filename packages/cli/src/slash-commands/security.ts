import type { Context } from '@wrongstack/core/agent';
import type { Provider, SlashCommand } from '@wrongstack/core/types';
import { createSecuritySlashCommand } from '@wrongstack/security-scanner';
import type { SlashCommandContext } from './command-context.js';
import { unknownSubcommand } from './helpers.js';

export interface SecurityCommandHost {
  cwd: string;
  projectRoot: string;
  llmProvider?: Provider | undefined;
  llmModel?: string | undefined;
}

export type SecurityBackendCommand = Pick<SlashCommand, 'run'>;

const SUBCOMMANDS = ['scan', 'audit', 'audit-deps', 'report', 'redact-test', 'help'] as const;

function commandContext(host: SecurityCommandHost, current?: Context | undefined): Context {
  return {
    ...current,
    cwd: current?.cwd ?? host.cwd,
    projectRoot: current?.projectRoot ?? host.projectRoot,
    provider: current?.provider ?? host.llmProvider,
    model: current?.model ?? host.llmModel ?? '',
  } as Context;
}

function parseInvocation(args: string): {
  action: string;
  backendArgs: string;
  json: boolean;
} {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0 && token !== '--json');
  const requested = tokens[0] ?? 'help';
  const action = requested === '--help' || requested === '-h' ? 'help' : requested;
  if (action === 'help') tokens[0] = 'help';
  return { action, backendArgs: tokens.join(' '), json: /(?:^|\s)--json(?:\s|$)/.test(args) };
}

/** CLI-owned adapter over the package-owned security command implementation. */
export function createCliSecurityCommand(
  host: SecurityCommandHost,
  backend: SecurityBackendCommand = createSecuritySlashCommand(),
): SlashCommand {
  return {
    name: 'security',
    category: 'Inspect',
    description: 'Run source scans, dependency audits, reports, and redaction diagnostics.',
    argsHint: '[scan|audit|audit-deps|report|redact-test|help] [options] [--json]',
    help: [
      'Usage: /security [scan|audit|audit-deps|report|redact-test|help] [options] [--json]',
      '',
      '  scan          Run the real security-scanner pipeline.',
      '  audit         Run dependency audit plus source scan.',
      '  audit-deps    Run only the package-manager dependency audit.',
      '  report        List or read reports under <project>/security-reports.',
      '  redact-test   Verify the production secret scrubber with synthetic values.',
      '',
      'Scan options: --depth quick|standard|deep --format markdown|json|html',
    ].join('\n'),
    async run(args, ctx) {
      const invocation = parseInvocation(args);
      if (!SUBCOMMANDS.includes(invocation.action as (typeof SUBCOMMANDS)[number])) {
        const payload = {
          ok: false,
          action: invocation.action,
          error: {
            code: 'unknown_subcommand',
            message: unknownSubcommand(invocation.action, [...SUBCOMMANDS], 'security'),
          },
        };
        return {
          message: invocation.json ? JSON.stringify(payload, null, 2) : payload.error.message,
          metadata: { security: payload },
        };
      }

      const result = (await backend.run(invocation.backendArgs, commandContext(host, ctx))) ?? {};
      const message = result.message ?? '';
      const ok = !message.startsWith('❌');
      const payload: Record<string, unknown> = {
        ok,
        action: invocation.action,
        ...(invocation.action === 'help' ? { subcommands: [...SUBCOMMANDS] } : {}),
        ...(result.metadata ?? {}),
        ...(!ok
          ? { error: { code: 'security_command_failed', message: message.replace(/^❌\s*/, '') } }
          : {}),
      };
      return {
        ...result,
        message: invocation.json ? JSON.stringify(payload, null, 2) : result.message,
        metadata: { ...(result.metadata ?? {}), security: payload },
      };
    },
  };
}

export function buildSecurityCommand(opts: SlashCommandContext): SlashCommand {
  return createCliSecurityCommand(opts);
}
