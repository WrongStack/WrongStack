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

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

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
  | { calls: WrongStackCall[]; mcp?: boolean }
  | { safe: true }
  | { refuse: string; call: WrongStackCall };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const MCP_TOOL = /^mcp__[^_].*__.+/;
const VALID_MCP_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Known WrongStack bridge MCP server names that may appear in non-Claude tool titles. */
const DEFAULT_KNOWN_MCP_SERVERS: ReadonlySet<string> = new Set([
  'wrongstack-sage',
  'wrongstack-index',
  'wrongstack-kanban',
  'wrongstack-mailbox',
  'wrongstack-intake',
  'wrongstack-fleet',
]);

/**
 * Exact bare tool names exposed by WrongStack's internal MCP servers.
 * Some ACP clients (e.g. GitHub Copilot CLI) send only the bare tool name
 * (like `codebase_stats`) in `session/request_permission`. Mapping only this
 * exact allowlist keeps unknown tool names fail-closed.
 */
const KNOWN_BRIDGE_TOOL_TO_SERVER: Readonly<Record<string, string>> = {
  // wrongstack-index
  codebase_context: 'wrongstack-index',
  codebase_search: 'wrongstack-index',
  codebase_stats: 'wrongstack-index',
  codebase_package_graph: 'wrongstack-index',
  codebase_file_graph: 'wrongstack-index',
  codebase_symbol_graph: 'wrongstack-index',
  codebase_incoming_calls: 'wrongstack-index',
  codebase_outgoing_calls: 'wrongstack-index',
  codebase_read_symbol: 'wrongstack-index',
  codebase_skeleton: 'wrongstack-index',
  codebase_impact_analysis: 'wrongstack-index',
  codebase_repo_map: 'wrongstack-index',
  codebase_invariant_check: 'wrongstack-index',
  codebase_diff_impact: 'wrongstack-index',
  codebase_flow_trace: 'wrongstack-index',
  codebase_onboard: 'wrongstack-index',
  codebase_atlas: 'wrongstack-index',
  dead_code_scan: 'wrongstack-index',
  // wrongstack-sage
  memory_for_file: 'wrongstack-sage',
  memory_for_path: 'wrongstack-sage',
  memory_search: 'wrongstack-sage',
  memory_search_explain: 'wrongstack-sage',
  memory_graph: 'wrongstack-sage',
  memory_gather_batch: 'wrongstack-sage',
  memory_candidates: 'wrongstack-sage',
  // wrongstack-kanban
  kanban_read: 'wrongstack-kanban',
  kanban_watch: 'wrongstack-kanban',
  kanban_manage: 'wrongstack-kanban',
  kanban_destructive: 'wrongstack-kanban',
  // wrongstack-mailbox
  mailbox_read: 'wrongstack-mailbox',
  mailbox_watch: 'wrongstack-mailbox',
  mailbox_manage: 'wrongstack-mailbox',
  mailbox_admin: 'wrongstack-mailbox',
  // wrongstack-intake
  requirement_intake_list: 'wrongstack-intake',
  requirement_intake_submit: 'wrongstack-intake',
};

/**
 * Normalize an MCP tool call from any ACP client into WrongStack's canonical
 * `mcp__<server>__<tool>` form so user deny rules on `mcp__*` bind uniformly.
 *
 * Recognizes:
 * - Claude Code `_meta.claudeCode.toolName` or title matching `mcp__<server>__<tool>`
 * - Structured `_meta.mcp` (`{ serverName, toolName }` or `{ server, tool }`)
 * - Non-Claude client title conventions (`<server>/<tool>`, `<server>:<tool>`,
 *   `<server>.<tool>`, `<server>__<tool>`, `<tool> on <server>`) when `<server>`
 *   is a registered/known MCP server (fail-closed: unknown strings are rejected).
 */
function mcpToolName(
  call: AcpPermissionRequest['toolCall'],
  knownServers: ReadonlySet<string>,
): string | undefined {
  const meta = (
    call as {
      _meta?: {
        claudeCode?: { toolName?: unknown };
        mcp?: { serverName?: unknown; server?: unknown; toolName?: unknown; tool?: unknown };
      };
    }
  )._meta;

  const metaServer = str(meta?.mcp?.serverName) ?? str(meta?.mcp?.server);
  const metaTool = str(meta?.mcp?.toolName) ?? str(meta?.mcp?.tool);
  if (
    metaServer &&
    metaTool &&
    VALID_MCP_SEGMENT.test(metaServer) &&
    VALID_MCP_SEGMENT.test(metaTool)
  ) {
    return `mcp__${metaServer}__${metaTool}`;
  }

  const rawName = str(meta?.claudeCode?.toolName) ?? str(call.title);
  if (!rawName) return undefined;
  const trimmed = rawName.trim();
  if (MCP_TOOL.test(trimmed)) return trimmed;

  // `<tool> on <server>` (format emitted by WrongStack's adaptNames() for non-Claude agents)
  const onMatch = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+on\s+([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(
    trimmed,
  );
  if (onMatch?.[1] && onMatch[2] && knownServers.has(onMatch[2])) {
    return `mcp__${onMatch[2]}__${onMatch[1]}`;
  }

  // `mcp.<server>.<tool>`, `mcp:<server>:<tool>`, `mcp/<server>/<tool>` (e.g. codex-acp)
  const prefixedMatch =
    /^mcp(?:\.|:|\/)([A-Za-z0-9][A-Za-z0-9_-]*)(?:\.|:|\/)([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(
      trimmed,
    );
  if (prefixedMatch?.[1] && prefixedMatch[2] && knownServers.has(prefixedMatch[1])) {
    return `mcp__${prefixedMatch[1]}__${prefixedMatch[2]}`;
  }

  // `<server>/<tool>`, `<server>:<tool>`, `<server>.<tool>`, `<server>__<tool>`
  const sepMatch = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:\/|:|\.|__)([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(
    trimmed,
  );
  if (sepMatch?.[1] && sepMatch[2] && knownServers.has(sepMatch[1])) {
    return `mcp__${sepMatch[1]}__${sepMatch[2]}`;
  }

  // `<tool> (<knownServer> MCP Server)[: ...]` (format used by Qwen Code)
  const parenServerMatch =
    /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+\(([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+MCP\s+Server)?\)(?::.*)?$/i.exec(
      trimmed,
    );
  if (parenServerMatch?.[1] && parenServerMatch[2] && knownServers.has(parenServerMatch[2])) {
    return `mcp__${parenServerMatch[2]}__${parenServerMatch[1]}`;
  }

  // `<knownServer>: <humanized tool name>[ · <arg summary>]` (format used by Goose)
  const colonSpaceMatch = /^([A-Za-z0-9][A-Za-z0-9_-]*):\s+([^·]+?)(?:\s+·.*)?$/.exec(trimmed);
  if (colonSpaceMatch?.[1] && colonSpaceMatch[2] && knownServers.has(colonSpaceMatch[1])) {
    const normalizedTool = colonSpaceMatch[2].trim().toLowerCase().replace(/\s+/g, '_');
    if (VALID_MCP_SEGMENT.test(normalizedTool)) {
      return `mcp__${colonSpaceMatch[1]}__${normalizedTool}`;
    }
  }

  // `<knownServer>-<tool>` (format used by GitHub Copilot CLI, e.g. `wrongstack-index-codebase_stats`)
  for (const server of knownServers) {
    const prefix = `${server}-`;
    if (trimmed.startsWith(prefix)) {
      const toolPart = trimmed.slice(prefix.length);
      if (VALID_MCP_SEGMENT.test(toolPart)) return `mcp__${server}__${toolPart}`;
    }
  }

  // Bare known WrongStack bridge tool name (e.g. Copilot sends `codebase_stats` in permission title)
  const mappedServer = Object.hasOwn(KNOWN_BRIDGE_TOOL_TO_SERVER, trimmed)
    ? KNOWN_BRIDGE_TOOL_TO_SERVER[trimmed]
    : undefined;
  if (mappedServer && knownServers.has(mappedServer)) {
    return `mcp__${mappedServer}__${trimmed}`;
  }

  return undefined;
}

function extractBashCommandFromContent(call: AcpPermissionRequest['toolCall']): string | undefined {
  const content = (call as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as {
      type?: unknown;
      text?: unknown;
      content?: { type?: unknown; text?: unknown };
    };
    const text =
      block.type === 'content' && block.content?.type === 'text'
        ? str(block.content.text)
        : block.type === 'text'
          ? str(block.text)
          : undefined;
    if (text) {
      const cleaned = text.replace(/^Running:\s*/i, '').trim();
      if (cleaned) return cleaned;
    }
  }
  return undefined;
}

/**
 * Translate a worker's permission request into the WrongStack call with the
 * same effect. Kinds with nothing behind them to gate — thinking, reading or
 * searching the working tree without naming a path, and a mode switch, which
 * this policy only ever answers with the agent's ask-again option — need no
 * check. Anything else the policy cannot see the effect of is refused.
 */
function translate(
  req: Pick<AcpPermissionRequest, 'toolCall'>,
  knownServers: ReadonlySet<string>,
): Translation {
  const call = req.toolCall;
  const label = str(call.title) ?? call.kind ?? 'unknown';
  if (
    call.rawInput !== undefined &&
    call.rawInput !== null &&
    (typeof call.rawInput !== 'object' || Array.isArray(call.rawInput))
  ) {
    return { refuse: 'malformed tool call input', call: { tool: label, input: {} } };
  }
  const raw = (call.rawInput ?? {}) as Record<string, unknown>;
  const refuse = (why: string): Translation => ({
    refuse: why,
    call: { tool: label, input: raw },
  });
  const rawPaths = [str(raw.file_path), str(raw.path), str(raw.notebook_path)].filter(
    (p): p is string => p !== undefined,
  );
  const locPaths = (call.locations ?? [])
    .map((loc) => str(loc?.path))
    .filter((p): p is string => p !== undefined);
  const paths = [...new Set([...rawPaths, ...locPaths])];
  switch (call.kind) {
    case 'execute': {
      const command = str(raw.command) ?? str(raw.cmd);
      return command
        ? { calls: [{ tool: 'bash', input: { command } }] }
        : refuse('a command request that names no command');
    }
    case 'edit':
      if (paths.length === 0) return refuse('an edit that names no file');
      return typeof raw.old_string === 'string'
        ? {
            calls: paths.map((path) => ({
              tool: 'edit',
              input: { path, old_string: raw.old_string, new_string: str(raw.new_string) ?? '' },
            })),
          }
        : {
            calls: paths.map((path) => ({
              tool: 'write',
              input: { path, content: typeof raw.content === 'string' ? raw.content : '' },
            })),
          };
    case 'delete':
      return paths.length > 0
        ? {
            calls: paths.map((path) => ({
              tool: 'bash',
              input: { command: `rm ${shellQuote(path)}` },
            })),
          }
        : refuse('a delete that names no file');
    case 'move': {
      const from = rawPaths[0] ?? str(call.locations?.[0]?.path);
      const to = str(raw.destination) ?? str(raw.new_path) ?? str(call.locations?.[1]?.path);
      if (!from || !to) return refuse('a move that names no source or destination');
      const allowed = new Set([from, to]);
      if (
        (call.locations?.length ?? 0) > 2 ||
        rawPaths.some((p) => !allowed.has(p)) ||
        locPaths.some((p) => !allowed.has(p))
      ) {
        return refuse('a move with ambiguous locations');
      }
      return {
        calls: [
          {
            tool: 'bash',
            input: { command: `mv ${shellQuote(from)} ${shellQuote(to)}` },
          },
        ],
      };
    }
    case 'read':
    case 'search':
      return paths.length > 0
        ? { calls: paths.map((path) => ({ tool: 'read', input: { path } })) }
        : { safe: true };
    case 'fetch': {
      // A page fetch names a URL; a web search names a query; a sandbox
      // network request names a host. All reach the network as `fetch` does.
      const host = str(raw.host);
      const url = str(raw.url) ?? (host ? `https://${host}` : undefined);
      if (url) return { calls: [{ tool: 'fetch', input: { url } }] };
      const query = str(raw.query);
      return query
        ? { calls: [{ tool: 'fetch', input: { query } }] }
        : refuse('a network request that names no URL or query');
    }
    case 'think':
    case 'switch_mode':
      return { safe: true };
    default: {
      const mcp = mcpToolName(call, knownServers);
      if (mcp) return { calls: [{ tool: mcp, input: raw }], mcp: true };
      // Some ACP clients (e.g. Kimi) send `title: "Bash"` / `"Shell"` / `"Terminal"`
      // with `kind: "other"` (or omitted `kind`) and `rawInput.command`.
      const titleLower = (str(call.title) ?? '').trim().toLowerCase();
      const command =
        str(raw.command) ?? str(raw.cmd) ?? str(raw.script) ?? extractBashCommandFromContent(call);
      if (
        command &&
        (titleLower === 'bash' || titleLower === 'shell' || titleLower === 'terminal')
      ) {
        return { calls: [{ tool: 'bash', input: { command } }] };
      }
      return refuse('no WrongStack counterpart to check it against');
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
   * Additional MCP server names attached to this session so non-Claude ACP
   * clients' `<server>/<tool>` or `<server>:<tool>` titles can be normalized
   * into `mcp__<server>__<tool>` without weakening fail-closed refusal.
   */
  registeredMcpServers?: readonly string[] | undefined;
  /**
   * Ask the user when the policy wants a question (`confirm`). A worker has
   * no one to ask, so without this a `confirm` is refused; a leader runs in
   * front of the user and passes the session's own confirmation prompt.
   */
  confirm?:
    | ((
        tool: Tool,
        call: WrongStackCall,
        request: {
          toolCallId: string | undefined;
          signal: AbortSignal;
          child?: AcpPermissionRequest['child'];
        },
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
  const knownServers: ReadonlySet<string> =
    opts.registeredMcpServers && opts.registeredMcpServers.length > 0
      ? new Set([...DEFAULT_KNOWN_MCP_SERVERS, ...opts.registeredMcpServers])
      : DEFAULT_KNOWN_MCP_SERVERS;
  const refuse = (req: AcpPermissionRequest, call: WrongStackCall, reason: string) => {
    opts.onRefused?.(call, reason);
    return pick(req, false);
  };
  return async (req) => {
    if (req.signal.aborted) return { outcome: 'cancelled' };
    const translated = translate(req, knownServers);
    if ('safe' in translated) return pick(req, true);
    if ('refuse' in translated) return refuse(req, translated.call, translated.refuse);
    for (const call of translated.calls) {
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
      if (req.signal.aborted) return { outcome: 'cancelled' };
      if (decision.permission === 'auto') continue;
      if (decision.permission === 'confirm' && opts.confirm) {
        let approved = false;
        try {
          approved = await opts.confirm(tool, call, {
            toolCallId: req.toolCall.toolCallId,
            signal: req.signal,
            ...(req.child ? { child: req.child } : {}),
          });
        } catch {
          approved = false;
        }
        if (req.signal.aborted) return { outcome: 'cancelled' };
        if (approved) continue;
        return refuse(req, call, 'declined by the user');
      }
      // Without a way to ask, `confirm` is a question nobody can answer.
      return refuse(req, call, decision.reason ?? decision.source);
    }
    return pick(req, true);
  };
}
