import {
  ALL_DESTRUCTIVE_KINDS,
  type DestructiveKind,
  isDestructiveKind,
  LOCKED_DESTRUCTIVE_KINDS,
} from '@wrongstack/core/security';
import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

/** One line of prose per kind, so the list reads without opening the source. */
const KIND_BLURBS: Record<DestructiveKind, string> = {
  'disk-wipe': 'mkfs, dd to a raw device, format C:, fork bomb',
  'system-halt': 'shutdown, reboot',
  'delete-outside': 'recursive force-delete that leaves the project, or hits a system/home root',
  'git-history': 'reset --hard, clean -f, push --force, filter-branch',
  publish: 'npm publish, docker push, kubectl delete namespace',
  'download-and-run': 'curl | sh, and inline payloads that fetch then execute',
  'bulk-delete': 'find -exec rm, inline rmSync across many paths',
  'agent-state': "writes to WrongStack's own config.json / trust.json / auth.json",
  'credential-bind': 'attaching a well-known API key to a chosen provider endpoint',
};

function renderConfirmList(
  opts: SlashCommandContext,
  map: Record<string, boolean>,
): { message: string } {
  const lines = ['Kinds that still prompt while YOLO is on:', ''];
  for (const kind of ALL_DESTRUCTIVE_KINDS) {
    const locked = LOCKED_DESTRUCTIVE_KINDS.has(kind);
    const state = map[kind]
      ? locked
        ? color.dim('ALWAYS ASKS')
        : color.yellow('ASKS')
      : color.green('runs');
    lines.push(`  ${kind.padEnd(17)} ${state.padEnd(20)} ${color.dim(KIND_BLURBS[kind])}`);
  }
  lines.push('', color.dim('  /yolo confirm <kind> off   lets YOLO run that kind unattended'));
  lines.push(
    color.dim('  ALWAYS ASKS cannot be turned off — those writes can disable approval itself'),
  );
  const msg = lines.join('\n');
  opts.renderer.write(msg);
  return { message: msg };
}

function runConfirm(opts: SlashCommandContext, rest: string): { message: string } {
  if (!opts.onYoloConfirm) {
    const msg = 'Per-kind YOLO confirmation is not available in this session.';
    opts.renderer.writeWarning(msg);
    return { message: msg };
  }
  if (!rest) return renderConfirmList(opts, opts.onYoloConfirm());

  const [rawKind, rawState] = rest.split(/\s+/);
  if (!isDestructiveKind(rawKind)) {
    const msg = `Unknown kind: ${rawKind}. Known kinds: ${ALL_DESTRUCTIVE_KINDS.join(', ')}.`;
    opts.renderer.writeWarning(msg);
    return { message: msg };
  }
  if (rawState === undefined) {
    const msg = `Usage: /yolo confirm ${rawKind} on|off`;
    opts.renderer.writeWarning(msg);
    return { message: msg };
  }
  const confirm = rawState === 'on' || rawState === 'true' || rawState === '1';
  if (!confirm && !['off', 'false', '0'].includes(rawState)) {
    const msg = `Unknown state: ${rawState}. Use on or off.`;
    opts.renderer.writeWarning(msg);
    return { message: msg };
  }

  const after = opts.onYoloConfirm({ kind: rawKind, confirm });
  // The locked kinds ignore an "off": say so rather than reporting a change
  // that did not happen.
  if (!confirm && after[rawKind]) {
    const msg = `${color.amber(rawKind)} always asks — ${KIND_BLURBS[rawKind]} can switch the approval system itself off.`;
    opts.renderer.writeWarning(msg);
    return { message: msg };
  }
  const msg = confirm
    ? `${color.yellow(rawKind)} will keep asking under YOLO.`
    : `${color.green(rawKind)} will now run unattended under YOLO.`;
  opts.renderer.write(msg);
  return { message: msg };
}

export function buildYoloCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'yolo',
    category: 'Config',
    description: 'Toggle or query YOLO (auto-approve) mode.',
    help: [
      'Usage:',
      '  /yolo              Show current YOLO status',
      '  /yolo on           Enable YOLO mode (auto-approve tool calls)',
      '  /yolo off          Disable YOLO mode (restore permission prompts)',
      '  /yolo confirm            List which kinds of damage still prompt under YOLO',
      '  /yolo confirm <kind> on  Keep prompting for that kind',
      '  /yolo confirm <kind> off Let YOLO run that kind unattended',
      '',
      'YOLO auto-approves tool calls unless an explicit deny rule blocks them, or',
      'the call would do damage of a kind still listed under `/yolo confirm`.',
      `Kinds: ${ALL_DESTRUCTIVE_KINDS.join(', ')}.`,
      `Always gated (they can switch approval itself off): ${[...LOCKED_DESTRUCTIVE_KINDS].join(', ')}.`,
    ].join('\n'),
    async run(args) {
      const arg = args.trim().toLowerCase();

      if (!opts.onYolo) {
        const msg = 'YOLO toggle is not available in this session.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      // No argument — show current status
      if (!arg) {
        const current = opts.onYolo();
        const status = current
          ? `${color.yellow('ON')} ${color.dim('(auto-approving tool calls)')}`
          : `${color.green('OFF')} ${color.dim('(permission prompts active)')}`;
        const msg = `YOLO mode: ${status}`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      // Explicit set
      let newState: boolean;
      if (arg === 'on' || arg === 'enable' || arg === 'true' || arg === '1') {
        newState = true;
      } else if (arg === 'off' || arg === 'disable' || arg === 'false' || arg === '0') {
        newState = false;
      } else if (arg === 'toggle') {
        newState = !opts.onYolo();
      } else if (arg === 'confirm' || arg.startsWith('confirm ')) {
        return runConfirm(opts, arg.slice('confirm'.length).trim());
      } else {
        const msg = `Unknown argument: ${arg}. Use /yolo on, /yolo off, /yolo toggle, or /yolo confirm.`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      opts.onYolo(newState);
      const label = newState
        ? `${color.yellow('ENABLED')} — tool calls will be auto-approved unless explicitly denied`
        : `${color.green('DISABLED')} — permission prompts are active`;
      const msg = `YOLO mode: ${label}`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}
