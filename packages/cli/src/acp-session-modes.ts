/**
 * Session modes and the permission policy of `wstack acp`.
 *
 * An ACP client picks how much the agent may do unasked with standard
 * `session/set_mode`; `wstack acp serve --yolo` / `--mode <id>` pick the mode a
 * new session opens in. The policy reads the session's mode at every tool call,
 * so a mode changed in the middle of a turn governs the turn's next call.
 *
 * `yolo` and `auto-edit` do not judge risk themselves: they ask the same
 * project policy `wstack --yolo` runs under (trust-file and directory deny
 * rules, `autonomy.yoloConfirm`, the locked destructive kinds). What that
 * policy would still confirm goes to the client as a permission request.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { RunTurnApi, WrongStackACPServerOptions } from '@wrongstack/acp/agent';
import type { PermissionDecision, PermissionPolicy, Tool } from '@wrongstack/contracts/types';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import { ToolCapabilities } from '@wrongstack/core/security';

export const ACP_MODE_IDS = ['default', 'plan', 'auto-edit', 'yolo'] as const;
export type AcpModeId = (typeof ACP_MODE_IDS)[number];
export type SessionMode = NonNullable<WrongStackACPServerOptions['modes']>[number];

const MODES: Record<AcpModeId, SessionMode> = {
  default: {
    id: 'default',
    name: 'Default',
    description: 'Asks before file edits, shell commands and other gated actions.',
  },
  plan: {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only: reads and searches, never writes files or runs commands.',
  },
  'auto-edit': {
    id: 'auto-edit',
    name: 'Auto-edit',
    description:
      'Edits project files without asking; still asks before shell commands and destructive actions.',
  },
  yolo: {
    id: 'yolo',
    name: 'YOLO',
    description:
      'Acts without asking, like `wstack --yolo`; still asks before destructive actions and calls your deny rules forbid.',
  },
};

export function isAcpModeId(value: unknown): value is AcpModeId {
  return typeof value === 'string' && (ACP_MODE_IDS as readonly string[]).includes(value);
}

/** The advertised modes, the start mode first: a new session opens in the first one. */
export function acpSessionModes(start: AcpModeId = 'default'): SessionMode[] {
  return [MODES[start], ...ACP_MODE_IDS.filter((id) => id !== start).map((id) => MODES[id])];
}

/**
 * The start mode from `--yolo` / `--mode <id>`. Both may be given only when they
 * agree; an unknown id is an error rather than a silent `default`.
 */
export function resolveAcpStartMode(
  flags: Record<string, unknown> | undefined,
): { modeId: AcpModeId } | { error: string } {
  const yolo = flags?.['yolo'] === true || flags?.['yolo'] === 'true';
  const raw = flags?.['mode'];
  if (raw === undefined || raw === false) return { modeId: yolo ? 'yolo' : 'default' };
  if (!isAcpModeId(raw)) {
    return {
      error: `Unknown ACP mode "${String(raw)}". Choose one of: ${ACP_MODE_IDS.join(', ')}.`,
    };
  }
  if (yolo && raw !== 'yolo') return { error: `--yolo conflicts with --mode ${raw}.` };
  return { modeId: raw };
}

/** Capabilities considered safe to auto-approve without asking the client. */
const SAFE_CAPS = new Set<string>([
  ToolCapabilities.FS_READ,
  ToolCapabilities.NET_OUTBOUND,
  ToolCapabilities.COORDINATION_FLEET_READ,
]);

type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'fetch'
  | 'think'
  | 'other';

const KIND_LABEL: Record<ToolKind, string> = {
  read: 'file reads',
  edit: 'file edits',
  delete: 'deletions',
  move: 'file moves',
  search: 'searches',
  execute: 'shell commands',
  fetch: 'web requests',
  think: 'planning steps',
  other: 'calls',
};

export interface ACPClientPermissionPolicyOptions {
  /** The session's current mode; `default` when absent or unknown. */
  mode?: (() => string | undefined) | undefined;
  /**
   * The project policy `wstack --yolo` runs under, without a prompt delegate:
   * `auto` runs, `deny` refuses, `confirm` asks the client. Without it `yolo`
   * and `auto-edit` ask, as `default` does.
   */
  arbiter?: PermissionPolicy | undefined;
}

/**
 * Permission policy that routes side-effecting tool calls to the connected
 * ACP client via `session/request_permission`, while auto-approving read-only
 * tools.
 *
 * "Always" answers last for the session. Their scope is the tool (`write`,
 * `bash`, an MCP tool), named in the option: "Always allow file edits (write) in
 * this session". A call the project policy still guards (a destructive command,
 * a deny rule) is scoped to that exact call instead, so allowing `bash` once
 * for `ls` never lets a later `rm -rf` through unasked.
 *
 * Exported for direct regression testing of the malformed-response path.
 */
export class ACPClientPermissionPolicy implements PermissionPolicy {
  private readonly alwaysAllowed = new Set<string>();
  private readonly alwaysDenied = new Set<string>();

  constructor(
    private readonly requestPermission: RunTurnApi['requestPermission'],
    private readonly opts: ACPClientPermissionPolicyOptions = {},
  ) {}

  async evaluate(tool: Tool, input: unknown, ctx?: AgentContext): Promise<PermissionDecision> {
    const caps = tool.capabilities ?? [];
    // Safe iff every declared capability is in the safe set (and at least
    // one exists). A tool with no declared caps is treated as unsafe.
    if (caps.length > 0 && caps.every((c) => SAFE_CAPS.has(c))) {
      return { permission: 'auto', source: 'default' };
    }
    if (this.alwaysDenied.has(tool.name)) {
      return { permission: 'deny', source: 'user', reason: 'always rejected by ACP client' };
    }
    const mode = this.opts.mode?.();
    if (mode === 'plan') {
      return { permission: 'deny', source: 'default', reason: 'plan mode is read-only' };
    }
    const verdict = await this.arbiterVerdict(tool, input, ctx);
    if (verdict?.permission === 'deny') return verdict;
    const guarded = verdict?.permission === 'confirm';
    const exactKey = guarded ? `${tool.name}\u0000${stableJson(input)}` : undefined;
    if (
      exactKey !== undefined ? this.alwaysAllowed.has(exactKey) : this.alwaysAllowed.has(tool.name)
    ) {
      return { permission: 'auto', source: 'user' };
    }
    if (verdict?.permission === 'auto') {
      if (mode === 'yolo') return { permission: 'auto', source: 'yolo' };
      if (mode === 'auto-edit' && isProjectEdit(tool) && (await editsInsideProject(input, ctx)))
        return { permission: 'auto', source: 'default' };
    }
    return this.ask(tool, input, exactKey, verdict?.reason);
  }

  private async arbiterVerdict(
    tool: Tool,
    input: unknown,
    ctx: AgentContext | undefined,
  ): Promise<PermissionDecision | undefined> {
    if (!this.opts.arbiter || !ctx) return undefined;
    try {
      return await this.opts.arbiter.evaluate(tool, input, ctx);
    } catch {
      // An unreadable trust or rule file must not run anything unasked.
      return { permission: 'confirm', source: 'default', reason: 'permission rules unreadable' };
    }
  }

  private async ask(
    tool: Tool,
    input: unknown,
    exactKey: string | undefined,
    reason: string | undefined,
  ): Promise<PermissionDecision> {
    const kind = permissionToolKind(tool.name);
    const scope =
      exactKey !== undefined
        ? 'this exact call'
        : kind === 'other'
          ? `${tool.name} calls`
          : `${KIND_LABEL[kind]} (${tool.name})`;
    const title = describeToolCall(tool.name, input);
    try {
      const outcome = await this.requestPermission({
        toolCall: {
          toolCallId: `tc_${tool.name}_${Date.now()}`,
          title: reason && exactKey !== undefined ? `${title} — ${reason}` : title,
          kind,
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          {
            optionId: 'allow_always',
            name: `Always allow ${scope} in this session`,
            kind: 'allow_always',
          },
          { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
          {
            optionId: 'reject_always',
            name: `Always reject ${tool.name} calls in this session`,
            kind: 'reject_always',
          },
        ],
      });
      const optionId = outcome.outcome === 'selected' ? outcome.optionId : undefined;
      if (optionId === 'allow_always') {
        this.alwaysDenied.delete(tool.name);
        this.alwaysAllowed.add(exactKey ?? tool.name);
      } else if (optionId === 'reject_always') {
        this.alwaysAllowed.delete(tool.name);
        this.alwaysDenied.add(tool.name);
      }
      const allowed = typeof optionId === 'string' && optionId.startsWith('allow');
      return allowed
        ? { permission: 'auto', source: 'user' }
        : { permission: 'deny', source: 'user', reason: 'rejected by ACP client' };
    } catch {
      // No client channel or the request timed out. Fail safe: deny the
      // side-effecting tool rather than silently running it.
      return { permission: 'deny', source: 'deny', reason: 'no permission channel' };
    }
  }

  async trust(rule: { tool: string; pattern: string; ttlMs?: number | undefined }): Promise<void> {
    if (rule.tool.length > 0) {
      this.alwaysDenied.delete(rule.tool);
      this.alwaysAllowed.add(rule.tool);
    }
  }
  async deny(rule: { tool: string; pattern: string }): Promise<void> {
    if (rule.tool.length > 0) {
      this.alwaysAllowed.delete(rule.tool);
      this.alwaysDenied.add(rule.tool);
    }
  }
  denyOnce(): void {}
  allowOnce(): void {}
  async reload(): Promise<void> {}
}

/** A write inside the project and nothing more: what `auto-edit` runs unasked. */
function isProjectEdit(tool: Tool): boolean {
  const caps = tool.capabilities ?? [];
  return (
    caps.includes(ToolCapabilities.FS_WRITE) &&
    caps.every((c) => c === ToolCapabilities.FS_WRITE || SAFE_CAPS.has(c)) &&
    permissionToolKind(tool.name) !== 'delete'
  );
}

const PATH_KEYS = ['path', 'file', 'file_path', 'filePath'] as const;

/**
 * Every path the call names resolves, symlinks followed, inside the session's
 * project root. A client-backed write (`fs/write_text_file`) skips the write
 * tool's own realpath check, so a link inside the project pointing out of it
 * must ask here. A call whose target cannot be read (no path field) or resolved
 * is not an auto-edit: it asks.
 */
async function editsInsideProject(input: unknown, ctx: AgentContext | undefined): Promise<boolean> {
  const root = ctx?.projectRoot;
  if (!root || !input || typeof input !== 'object') return false;
  const targets: string[] = [];
  const collect = (record: Record<string, unknown>): void => {
    for (const key of PATH_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) targets.push(value);
    }
  };
  collect(input as Record<string, unknown>);
  for (const list of ['edits', 'files'] as const) {
    const items = (input as Record<string, unknown>)[list];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && typeof item === 'object') collect(item as Record<string, unknown>);
    }
  }
  if (targets.length === 0) return false;
  try {
    const base = await fsp.realpath(path.resolve(root));
    for (const target of targets) {
      const real = await realpathOfDeepestAncestor(path.resolve(ctx.cwd ?? root, target));
      const rel = path.relative(base, real);
      if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The realpath of `target`'s deepest existing ancestor, with the missing tail re-attached. */
async function realpathOfDeepestAncestor(target: string): Promise<string> {
  const tail: string[] = [];
  let probe = target;
  for (;;) {
    try {
      return path.join(await fsp.realpath(probe), ...tail.reverse());
    } catch (err) {
      const parent = path.dirname(probe);
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === probe) throw err;
      // ENOENT on an entry that exists is a dangling link: a write through it
      // creates its target, wherever that is. Refuse; the caller asks.
      const entry = await fsp.lstat(probe).catch(() => undefined);
      if (entry) throw new Error(`unresolvable link: ${probe}`);
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? // F104: code-unit order. localeCompare ties on canonically
          // equivalent keys ('é' vs 'e\u0301'), leaving the sort insertion-
          // order-dependent — the always-allow grant key then misses when
          // the same logical input is rebuilt in another property order.
          Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    );
  } catch {
    return String(value);
  }
}

export function permissionToolKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.includes('read') || n.includes('cat')) return 'read';
  if (n.includes('write') || n.includes('edit') || n.includes('apply') || n.includes('patch'))
    return 'edit';
  if (n.includes('delete') || n === 'rm' || n.startsWith('rm_') || n.endsWith('_rm'))
    return 'delete';
  if (n.includes('move') || n.includes('rename') || n.includes('mv')) return 'move';
  if (n.includes('grep') || n.includes('glob') || n.includes('search') || n.includes('find'))
    return 'search';
  if (
    n.includes('bash') ||
    n.includes('shell') ||
    n.includes('exec') ||
    n.includes('run') ||
    n.includes('terminal')
  )
    return 'execute';
  if (n.includes('fetch') || n.includes('http') || n.includes('web') || n.includes('url'))
    return 'fetch';
  if (n.includes('think') || n.includes('plan')) return 'think';
  return 'other';
}

export function describeToolCall(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const r = input as Record<string, unknown>;
    const arg = r.path ?? r.file ?? r.command ?? r.pattern;
    if (typeof arg === 'string') return `${name}: ${arg}`;
  }
  return name;
}
