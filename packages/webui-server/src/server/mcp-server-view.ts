import { DefaultSecretScrubber, isSecretField } from '@wrongstack/core/security';
import {
  MCP_ENV_MASK,
  type MCPRegistry,
  type MCPServerOperationalHealth,
  type MCPToolAnnotations,
  type McpServerInfo,
} from '@wrongstack/mcp';

/**
 * Browser wire view of an MCP server: status mapping, tool-annotation hints,
 * and env redaction applied before `mcp.list` / `mcp.*` results leave the host.
 */

/** Wire view of a server as the browser MCP panel consumes it. */
interface MCPServerView {
  name: string;
  transport: string;
  status: 'stopped' | 'connecting' | 'connected' | 'sleeping' | 'discovering' | 'error';
  enabled: boolean;
  description?: string;
  tools?: string[];
  /**
   * Behaviour hints each tool's server CLAIMED about itself (MCP annotations),
   * keyed by tool name. Optional + additive: older clients ignore it. This is
   * the server's untrusted self-report, surfaced for operator display only —
   * nothing in the permission path reads it.
   */
  toolAnnotations?: Record<string, MCPToolHintView>;
  error?: string;
  pid?: number;
  lazy?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Header names; every value is {@link MCP_ENV_MASK}, which `mcp.update` reads as "keep". */
  headers?: Record<string, string>;
  url?: string;
  health?: MCPServerOperationalHealth;
}

/**
 * The annotation fields carried on the wire. Reuses the sanitized
 * `@wrongstack/mcp` contract but drops `idempotentHint` — the WebUI renders
 * only these four.
 */
type MCPToolHintView = Pick<
  MCPToolAnnotations,
  'title' | 'readOnlyHint' | 'destructiveHint' | 'openWorldHint'
>;

/**
 * Collect the per-tool annotation hints a server claimed, keyed by tool name.
 *
 * Returns `undefined` when there is nothing to show (unknown server, no
 * annotated tools, or a registry that predates `describeTools`) so the wire
 * field stays absent rather than empty — absence must not read as a claim.
 */
export function toolAnnotationsFor(
  registry: MCPRegistry,
  serverName: string,
): Record<string, MCPToolHintView> | undefined {
  if (typeof registry.describeTools !== 'function') return undefined;
  const described = registry.describeTools(serverName);
  if (!described) return undefined;
  const out: Record<string, MCPToolHintView> = {};
  for (const tool of described) {
    const hints = tool.annotations;
    if (!hints) continue;
    const view: MCPToolHintView = {};
    if (hints.title !== undefined) view.title = hints.title;
    if (hints.readOnlyHint !== undefined) view.readOnlyHint = hints.readOnlyHint;
    if (hints.destructiveHint !== undefined) view.destructiveHint = hints.destructiveHint;
    if (hints.openWorldHint !== undefined) view.openWorldHint = hints.openWorldHint;
    out[tool.name] = view;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Map a raw registry state to the UI status union. */
function mapStatus(raw: string): MCPServerView['status'] {
  switch (raw) {
    case 'connected':
      return 'connected';
    case 'connecting':
    case 'reconnecting':
      return 'connecting';
    case 'failed':
      return 'error';
    case 'dormant':
      // Lazy server registered from cache, process not spawned — show as sleeping.
      return 'sleeping';
    default:
      // idle / disconnected / stopped
      return 'stopped';
  }
}

const envScrubber = new DefaultSecretScrubber();

/**
 * Replace secret-bearing MCP env values with {@link MCP_ENV_MASK}.
 *
 * WS-036: `mcp.list` echoed this map verbatim to the browser, and MCP server
 * env is exactly where server credentials live — `GITHUB_TOKEN`, `*_API_KEY`,
 * and so on. Two independent signals decide, because either alone misses real
 * cases:
 *
 *   - the KEY looks secret (`isSecretField`, the project's own answer), which
 *     catches `FOO_TOKEN=<anything>`;
 *   - the VALUE looks like a credential to the scrubber, which catches a
 *     secret hiding behind an innocuous name like `GH_PAT=ghp_…`.
 *
 * Non-secret env (`NODE_ENV`, a path) still shows through, so editing a server
 * in the UI stays workable. Sending the mask back means "leave that value
 * alone" — `buildConfig` restores it from the stored config.
 */
function maskServerEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // A hand-edited config.json can hold a truthy non-string env value
    // (`"PORT": 8080`); `scrub()` calls `text.includes(...)` and would throw a
    // TypeError, breaking `mcp.list` for that whole config. Only strings can be
    // credentials, so guard the value signal — a secret-named KEY still masks a
    // non-string value through the first signal.
    const secret =
      isSecretField(key) || (typeof value === 'string' && envScrubber.scrub(value) !== value);
    out[key] = secret ? MCP_ENV_MASK : value;
  }
  return out;
}

/** Project the shared {@link McpServerInfo} into the browser wire shape. */
export function toView(
  info: McpServerInfo,
  health?: MCPServerOperationalHealth | undefined,
  toolAnnotations?: Record<string, MCPToolHintView> | undefined,
): MCPServerView {
  const view: MCPServerView = {
    name: info.name,
    transport: info.transport,
    // A dormant lazy server is "asleep", not stopped — preserve that even when
    // it's enabled in config.
    status:
      info.status === 'dormant'
        ? 'sleeping'
        : info.enabled === false
          ? 'stopped'
          : mapStatus(info.status),
    enabled: info.enabled,
    tools: info.tools,
  };
  if (info.description !== undefined) view.description = info.description;
  if (info.lazy !== undefined) view.lazy = info.lazy;
  if (info.command !== undefined) view.command = info.command;
  if (info.args !== undefined) view.args = info.args;
  if (info.env !== undefined) view.env = maskServerEnv(info.env);
  // Header values are credentials far more often than not (`Authorization`,
  // API-key headers), so none is shown; names stay editable.
  if (info.headers !== undefined)
    view.headers = Object.fromEntries(Object.keys(info.headers).map((key) => [key, MCP_ENV_MASK]));
  if (info.url !== undefined) view.url = info.url;
  if (health !== undefined) view.health = health;
  if (toolAnnotations !== undefined) view.toolAnnotations = toolAnnotations;
  return view;
}

/**
 * Build the shared management deps. Returns null (and sends a failure result)
 * when the live registry isn't wired — both WebUI servers now pass one, so this
 * is a defensive guard rather than the normal path.
 */
