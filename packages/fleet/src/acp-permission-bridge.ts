/**
 * WrongStack's permission rules for an external ACP worker.
 *
 * A delegated agent must not be a one-hop bypass of the user's approval
 * system. WrongStack's own subagents run every tool call through
 * `AutoApprovePermissionPolicy`: the user's deny rules bind them, destructive
 * commands and credential reads are refused (a worker cannot ask), and the
 * user's YOLO+ lifts those refusals. An ACP worker gets the same treatment:
 * the host starts it in a mode where it asks before edits, commands and
 * fetches, and each `session/request_permission` is translated into the
 * matching WrongStack tool call and decided by that policy. A request it
 * cannot evaluate — an unknown kind, a call naming no target, a tool the run
 * does not have — is refused, never waved through.
 */
import type {
  PermissionPolicy as AcpPermissionPolicy,
  PermissionRequest as AcpPermissionRequest,
} from '@wrongstack/acp';
import type { PermissionDecision, Tool } from '@wrongstack/contracts/types';
import { ToolCapabilities } from '@wrongstack/core/security';
import { toErrorMessage } from '@wrongstack/core/utils';

/** The WrongStack tool call an ACP permission request stands for. */
export interface WrongStackCall {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * What a worker's permission request amounts to: a WrongStack call to decide,
 * an MCP tool to decide under its own name, a request with nothing to check,
 * or one the policy cannot evaluate (refused — never waved through).
 */
type Translation =
  | { call: WrongStackCall; mcp?: boolean }
  | { safe: true }
  | { refuse: string; call: WrongStackCall };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const MCP_TOOL = /^mcp__[^_].*__.+/;

/** The `mcp__<server>__<tool>` name of a request, from Claude's `_meta` or the title. */
function mcpToolName(call: AcpPermissionRequest['toolCall']): string | undefined {
  const meta = (call as { _meta?: { claudeCode?: { toolName?: unknown } } })._meta;
  const name = str(meta?.claudeCode?.toolName) ?? str(call.title);
  return name && MCP_TOOL.test(name) ? name : undefined;
}

/**
 * Translate a worker's permission request into the WrongStack call with the
 * same effect. Kinds with nothing behind them to gate — thinking, reading or
 * searching the working tree without naming a path, and a mode switch, which
 * this policy only ever answers with the agent's ask-again option — need no
 * check. Anything else the policy cannot see the effect of is refused.
 */
function translate(req: Pick<AcpPermissionRequest, 'toolCall'>): Translation {
  const call = req.toolCall;
  const raw = call.rawInput ?? {};
  const label = str(call.title) ?? call.kind ?? 'unknown';
  const refuse = (why: string): Translation => ({
    refuse: why,
    call: { tool: label, input: raw },
  });
  const path =
    str(raw.file_path) ?? str(raw.path) ?? str(raw.notebook_path) ?? call.locations?.[0]?.path;
  switch (call.kind) {
    case 'execute': {
      const command = str(raw.command);
      return command
        ? { call: { tool: 'bash', input: { command } } }
        : refuse('a command request that names no command');
    }
    case 'edit':
      if (!path) return refuse('an edit that names no file');
      return typeof raw.old_string === 'string'
        ? {
            call: {
              tool: 'edit',
              input: { path, old_string: raw.old_string, new_string: str(raw.new_string) ?? '' },
            },
          }
        : {
            call: {
              tool: 'write',
              input: { path, content: typeof raw.content === 'string' ? raw.content : '' },
            },
          };
    case 'delete':
      return path
        ? { call: { tool: 'bash', input: { command: `rm ${JSON.stringify(path)}` } } }
        : refuse('a delete that names no file');
    case 'move': {
      const to = str(raw.destination) ?? str(raw.new_path) ?? call.locations?.[1]?.path;
      return path && to
        ? {
            call: {
              tool: 'bash',
              input: { command: `mv ${JSON.stringify(path)} ${JSON.stringify(to)}` },
            },
          }
        : refuse('a move that names no source or destination');
    }
    case 'read':
    case 'search':
      return path ? { call: { tool: 'read', input: { path } } } : { safe: true };
    case 'fetch': {
      // A page fetch names a URL; a web search names a query; a sandbox
      // network request names a host. All reach the network as `fetch` does.
      const host = str(raw.host);
      const url = str(raw.url) ?? (host ? `https://${host}` : undefined);
      if (url) return { call: { tool: 'fetch', input: { url } } };
      const query = str(raw.query);
      return query
        ? { call: { tool: 'fetch', input: { query } } }
        : refuse('a network request that names no URL or query');
    }
    case 'think':
    case 'switch_mode':
      return { safe: true };
    default: {
      const mcp = mcpToolName(call);
      return mcp
        ? { call: { tool: mcp, input: raw }, mcp: true }
        : refuse('no WrongStack counterpart to check it against');
    }
  }
}

export interface AcpPermissionBridgeOptions {
  /** WrongStack's subagent policy (an `AutoApprovePermissionPolicy`). */
  evaluate: (
    tool: Tool,
    input: unknown,
    ctx: { projectRoot: string; cwd: string },
  ) => Promise<PermissionDecision>;
  /** Resolve a WrongStack tool by name (the host's tool registry). */
  getTool: (name: string) => Tool | undefined;
  projectRoot: string;
  /**
   * Whether MCP tools may run at all. False under `--restricted`, which keeps
   * MCP tools out of the registry and so out of a worker's reach too.
   */
  allowMcp?: boolean | undefined;
  /**
   * Ask the user when the policy wants a question (`confirm`). A worker has
   * no one to ask, so without this a `confirm` is refused; a leader runs in
   * front of the user and passes the session's own confirmation prompt.
   */
  confirm?:
    | ((
        tool: Tool,
        call: WrongStackCall,
        request: { toolCallId: string | undefined; signal: AbortSignal },
      ) => Promise<boolean>)
    | undefined;
  /** Told about every refusal, for the host's log. */
  onRefused?: ((call: WrongStackCall, reason: string) => void) | undefined;
}

function pick(req: AcpPermissionRequest, allow: boolean) {
  const kinds = allow ? ['allow_once'] : ['reject_once', 'reject_always'];
  const option = req.options.find((o) => kinds.includes(o.kind));
  return option
    ? ({ outcome: 'selected', optionId: option.optionId } as const)
    : ({ outcome: 'cancelled' } as const);
}

/**
 * An MCP tool WrongStack has not registered itself (the bridge's own servers,
 * the user's Claude servers), checked as what it is: an MCP proxy, so the
 * user's deny rules on `mcp__*` names bind it.
 */
function mcpToolFor(name: string): Tool {
  return { name, capabilities: [ToolCapabilities.MCP_PROXY] } as unknown as Tool;
}

export function wrongstackAcpPermissionPolicy(
  opts: AcpPermissionBridgeOptions,
): AcpPermissionPolicy {
  const refuse = (req: AcpPermissionRequest, call: WrongStackCall, reason: string) => {
    opts.onRefused?.(call, reason);
    return pick(req, false);
  };
  return async (req) => {
    if (req.signal.aborted) return { outcome: 'cancelled' };
    const translated = translate(req);
    if ('safe' in translated) return pick(req, true);
    if ('refuse' in translated) return refuse(req, translated.call, translated.refuse);
    const { call } = translated;
    let tool = opts.getTool(call.tool);
    if (!tool && translated.mcp) {
      if (opts.allowMcp === false) return refuse(req, call, 'MCP tools are off in this run');
      tool = mcpToolFor(call.tool);
    }
    // A tool the host left out of its registry (`--restricted`, a launch
    // allowlist) is one the user took away; the worker must not have it back.
    if (!tool) return refuse(req, call, `${call.tool} is not available in this run`);
    let decision: PermissionDecision;
    try {
      decision = await opts.evaluate(tool, call.input, {
        projectRoot: opts.projectRoot,
        cwd: opts.projectRoot,
      });
    } catch (err) {
      // Fail closed: a policy that cannot decide must not wave a call through.
      decision = {
        permission: 'deny',
        source: 'default',
        reason: `permission check failed: ${toErrorMessage(err)}`,
      };
    }
    if (decision.permission === 'auto') return pick(req, true);
    if (decision.permission === 'confirm' && opts.confirm) {
      let approved = false;
      try {
        approved = await opts.confirm(tool, call, {
          toolCallId: req.toolCall.toolCallId,
          signal: req.signal,
        });
      } catch {
        approved = false;
      }
      if (req.signal.aborted) return { outcome: 'cancelled' };
      return approved ? pick(req, true) : refuse(req, call, 'declined by the user');
    }
    // Without a way to ask, `confirm` is a question nobody can answer.
    return refuse(req, call, decision.reason ?? decision.source);
  };
}
