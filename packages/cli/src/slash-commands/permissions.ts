import type { SessionPermissionOverride, SlashCommand } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import {
  compilePermissionRules,
  describeSessionPermissionOverride,
  isYoloLockedOff,
  readSessionPermissionOverrides,
  setSessionPermissionOverrides,
} from '@wrongstack/core/security';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import {
  explainCall,
  formatExplainedCall,
  formatPermissionRules,
} from '../permission-rules-view.js';
import type { SlashCommandContext } from './command-context.js';

const HELP = [
  'Usage:',
  '  /permissions                       List this session’s allow/deny rules',
  '  /permissions rules                 Every permission rule, in the order they are checked',
  '  /permissions explain <tool> [json] Which rule decides that call, and why',
  '  /permissions allow <tool> [pattern] Allow it for this session only',
  '  /permissions deny <tool> [pattern]  Refuse it for this session only',
  '  /permissions remove <n>            Drop session rule n',
  '  /permissions clear                 Drop every session rule',
  '',
  '<tool> is a tool name or a glob (mcp__github__*). [pattern] matches the',
  'call’s subject the way trust.json patterns do: the command line for a shell',
  '(`pnpm test*` stops at ; && |), the path for a file tool. No pattern means',
  'any input.',
  '',
  'Session rules are saved with the session (a resume brings them back) and',
  'never written to trust.json or any config. A deny wins over every allow. An',
  'allow does not cover a destructive call or a read of credentials: those',
  'still ask.',
].join('\n');

function sessionYolo(
  opts: SlashCommandContext,
  ctx: { meta?: Record<string, unknown> | undefined },
): boolean {
  if (isYoloLockedOff()) return false;
  const scoped = ctx.meta?.['yolo'];
  return typeof scoped === 'boolean' ? scoped : (opts.permissionPolicy?.getYolo?.() ?? false);
}

function listSessionRules(overrides: readonly SessionPermissionOverride[]): string {
  if (overrides.length === 0) {
    return 'No session rules. Add one with /permissions allow|deny <tool> [pattern].';
  }
  return [
    'Session rules (this session only):',
    ...overrides.map((o, i) => `  ${i + 1}. ${describeSessionPermissionOverride(o)}`),
  ].join('\n');
}

export function buildPermissionsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'permissions',
    category: 'Config',
    description:
      'Show the permission rules, explain a tool call, or allow/deny a tool for this session only.',
    argsHint:
      '[rules|explain <tool> [json]|allow <tool> [pattern]|deny <tool> [pattern]|remove <n>|clear]',
    help: HELP,
    async run(args, ctx) {
      const trimmed = args.trim();
      const sub = trimmed.split(/\s+/)[0] ?? '';
      const rest = trimmed.slice(sub.length).trim();
      if (!ctx) return { message: color.yellow('No active session.') };
      const overrides = readSessionPermissionOverrides(ctx);

      if (sub === '' || sub === 'list') return { message: listSessionRules(overrides) };
      if (sub === 'help') return { message: HELP };

      if (sub === 'rules' || sub === 'explain') {
        const policy = opts.permissionPolicy;
        if (!policy?.listRules) {
          return { message: color.yellow('The permission policy is not available here.') };
        }
        const yolo = sessionYolo(opts, ctx);
        if (sub === 'rules') {
          const rules = await compilePermissionRules(policy, ctx, { yolo });
          return { message: `YOLO: ${yolo ? 'on' : 'off'}\n\n${formatPermissionRules(rules)}` };
        }
        const toolName = rest.split(/\s+/)[0] ?? '';
        const rawInput = rest.slice(toolName.length).trim();
        const tool = toolName ? opts.toolRegistry.get(toolName) : undefined;
        if (!tool) {
          return {
            message: color.yellow(
              toolName
                ? `Unknown tool: "${toolName}".`
                : 'Usage: /permissions explain <tool> [input as JSON]',
            ),
          };
        }
        let input: unknown = {};
        if (rawInput) {
          try {
            input = JSON.parse(rawInput);
          } catch {
            return { message: color.red(`Invalid input JSON: ${rawInput}`) };
          }
        }
        try {
          const explained = await explainCall(policy, tool, input, ctx as Context, yolo);
          return { message: `YOLO: ${yolo ? 'on' : 'off'}\n\n${formatExplainedCall(explained)}` };
        } catch (err) {
          return { message: color.red(`Explain failed: ${toErrorMessage(err)}`) };
        }
      }

      let next: SessionPermissionOverride[];
      let done: string;
      if (sub === 'allow' || sub === 'deny') {
        if (sub === 'allow' && isYoloLockedOff()) {
          return {
            message: color.yellow(
              'Session allow rules are not honoured under --restricted (every write asks). Deny rules still apply.',
            ),
          };
        }
        const tool = rest.split(/\s+/)[0] ?? '';
        const pattern = rest.slice(tool.length).trim();
        if (!tool) return { message: color.yellow(`Usage: /permissions ${sub} <tool> [pattern]`) };
        if (!tool.includes('*') && !opts.toolRegistry.get(tool)) {
          return {
            message: color.yellow(`Unknown tool: "${tool}". Use a glob for tools that come later.`),
          };
        }
        const rule: SessionPermissionOverride = {
          effect: sub,
          tool,
          ...(pattern ? { pattern } : {}),
        };
        const exists = overrides.some(
          (o) => o.effect === rule.effect && o.tool === rule.tool && o.pattern === rule.pattern,
        );
        if (exists)
          return { message: `Already a session rule: ${describeSessionPermissionOverride(rule)}` };
        next = [...overrides, rule];
        done = `Session rule added: ${describeSessionPermissionOverride(rule)}. It holds for this session only.${
          sub === 'allow' ? ' Destructive calls and reads of credentials still ask.' : ''
        }`;
      } else if (sub === 'remove') {
        const n = Number(rest);
        if (!Number.isInteger(n) || n < 1 || n > overrides.length) {
          return {
            message: color.yellow(`Usage: /permissions remove <n> (1-${overrides.length || 1})`),
          };
        }
        const removed = overrides[n - 1];
        next = overrides.filter((_, i) => i !== n - 1);
        done = `Session rule removed: ${removed ? describeSessionPermissionOverride(removed) : n}.`;
      } else if (sub === 'clear') {
        if (overrides.length === 0) return { message: 'No session rules to clear.' };
        next = [];
        done = `Cleared ${overrides.length} session rule${overrides.length === 1 ? '' : 's'}.`;
      } else {
        return { message: color.yellow(`Unknown subcommand: ${sub}\n\n${HELP}`) };
      }

      try {
        await setSessionPermissionOverrides(ctx, next);
      } catch (err) {
        return { message: color.red(`Could not save the session rule: ${toErrorMessage(err)}`) };
      }
      return { message: color.green(done) };
    },
  };
}
