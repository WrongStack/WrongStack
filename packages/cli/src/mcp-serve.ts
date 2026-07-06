/**
 * `wstack mcp serve` — run WrongStack itself as an MCP server over stdio.
 *
 * Exposes the built-in tool registry to any MCP client (Claude Desktop, another
 * agent, an IDE). stdout is the JSON-RPC channel — every status/log line goes to
 * stderr. By default a safe `AutoApprovePermissionPolicy` is used: read-only
 * tools are exposed, while shell/write/edit and dangerous-capability tools are
 * withheld. `--yolo` exposes everything; `--tools a,b,c` restricts the set.
 */
import {
  AutoApprovePermissionPolicy,
  Context,
  DefaultSecretScrubber,
  type PermissionPolicy,
  type Provider,
  type SessionWriter,
  type TokenCounter,
  type Tool,
  ToolRegistry,
} from '@wrongstack/core';
import { ToolExecutor } from '@wrongstack/core/execution';
import { MCPServer, type MCPServerToolHost, serveHttp, serveStdio } from '@wrongstack/mcp';
import { builtinToolsPack } from '@wrongstack/tools';
import type { SubcommandDeps } from './subcommands/index.js';

/** `--yolo` policy: auto-approve everything (inherits the rest of the contract). */
class AllowAllPermissionPolicy extends AutoApprovePermissionPolicy {
  override async evaluate(): ReturnType<AutoApprovePermissionPolicy['evaluate']> {
    return { permission: 'auto', source: 'default' };
  }
}

function parseToolsFlag(flags: Record<string, string | boolean>): Set<string> | null {
  const raw = flags['tools'];
  if (typeof raw !== 'string') return null;
  const set = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return set.size > 0 ? set : null;
}

/** Minimal run context — tools read cwd/projectRoot/signal; provider/session are stubs. */
export function makeServeContext(
  cwd: string,
  projectRoot: string,
  signal: AbortSignal,
  restrictFsToRoot = true,
): Context {
  const provider = {
    id: 'mcp-serve',
    capabilities: { maxContext: 0 },
    complete: async () => {
      throw new Error('no model provider in `mcp serve` mode');
    },
    stream: () => {
      throw new Error('no model provider in `mcp serve` mode');
    },
  } as never as Provider;
  const session = { append: async () => {} } as never as SessionWriter;
  const tokenCounter = {
    account: () => {},
    total: () => ({ input: 0, output: 0 }),
    estimateCost: () => ({ total: 0 }),
  } as never as TokenCounter;
  return new Context({
    systemPrompt: [],
    provider,
    session,
    signal,
    tokenCounter,
    cwd,
    projectRoot,
    allowOutsideProjectRoot: !restrictFsToRoot,
    model: 'mcp-serve',
    tools: [],
  });
}

/**
 * Compute the set of tools an MCP-serve session exposes: a tool is included
 * only if it passes the whitelist (when set) AND the permission policy returns
 * `auto`. With `AutoApprovePermissionPolicy` this withholds shell/write/edit and
 * dangerous-capability tools; with the `--yolo` policy everything passes.
 * Exported for testing — the live path calls it inside `serveMcpStdio`.
 */
export async function selectExposedTools(
  registry: ToolRegistry,
  ctx: Context,
  policy: PermissionPolicy,
  whitelist: Set<string> | null,
): Promise<Tool[]> {
  const allowed: Tool[] = [];
  for (const tool of registry.list()) {
    if (whitelist && !whitelist.has(tool.name)) continue;
    const decision = await policy.evaluate(tool, {}, ctx);
    if (decision.permission === 'auto') allowed.push(tool);
  }
  return allowed;
}

export async function serveMcpStdio(deps: SubcommandDeps): Promise<number> {
  const flags = deps.flags ?? {};
  const yolo = flags['yolo'] === true || flags['allow-all'] === true;
  const whitelist = parseToolsFlag(flags);
  const log = (m: string) => process.stderr.write(`${m}\n`);

  // Reuse the subcommand's pre-populated registry; fall back to a fresh one.
  let registry = deps.toolRegistry as ToolRegistry | undefined;
  if (!registry) {
    registry = new ToolRegistry();
    registry.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
  }

  const controller = new AbortController();
  const ctx = makeServeContext(
    deps.cwd,
    deps.projectRoot,
    controller.signal,
    deps.config.tools?.restrictToProjectRoot ?? false,
  );
  const permissionPolicy: PermissionPolicy = yolo
    ? new AllowAllPermissionPolicy()
    : new AutoApprovePermissionPolicy();
  const executor = new ToolExecutor(registry, {
    permissionPolicy,
    secretScrubber: new DefaultSecretScrubber(),
    maxToolTimeoutMs: deps.config.tools?.maxToolTimeoutMs ?? 300_000,
    perIterationOutputCapBytes: 1_000_000,
  });

  // Pre-compute the exposed set so tools/list and tools/call agree, and so a
  // withheld tool can never be invoked even if a client guesses its name.
  const allowed = await selectExposedTools(registry, ctx, permissionPolicy, whitelist);
  const allowedNames = new Set(allowed.map((t) => t.name));

  if (allowed.length === 0) {
    log(
      'wrongstack MCP server: no tools to expose (all withheld by policy or filtered out). ' +
        'Pass --yolo to expose write/exec tools, or --tools <names> to whitelist.',
    );
  }

  let counter = 0;
  const host: MCPServerToolHost = {
    listTools: () =>
      allowed.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
      })),
    callTool: async (name, callArgs) => {
      if (!allowedNames.has(name)) {
        return { content: `Tool "${name}" is not exposed by this server`, isError: true };
      }
      const use = {
        type: 'tool_use' as const,
        id: `srv_${++counter}`,
        name,
        input: callArgs,
      };
      const batch = await executor.executeBatch([use], ctx, 'sequential');
      const result = batch.outputs[0]?.result;
      if (!result || result.type === 'tool_confirm_pending') {
        return {
          content: `Tool "${name}" requires interactive confirmation, which is unavailable over MCP`,
          isError: true,
        };
      }
      return { content: result.content, isError: Boolean(result.is_error) };
    },
  };

  const server = new MCPServer({
    host,
    logger: { warn: (m) => log(`[mcp-serve] ${m}`) },
  });

  const mode = yolo ? 'yolo: all tools' : 'safe: read-only tools';

  // HTTP transport — network-reachable. Loopback by default; non-loopback
  // requires a token (enforced in serveHttp).
  if (
    flags['http'] === true ||
    typeof flags['http'] === 'string' ||
    flags['port'] ||
    flags['host']
  ) {
    const port = Number(flags['port'] ?? flags['http'] ?? 0) || 0;
    const httpHost = typeof flags['host'] === 'string' ? flags['host'] : '127.0.0.1';
    const token = typeof flags['token'] === 'string' ? flags['token'] : undefined;
    let handle: Awaited<ReturnType<typeof serveHttp>>;
    try {
      handle = await serveHttp(server, {
        port,
        host: httpHost,
        token,
        logger: { warn: (m) => log(`[mcp-serve] ${m}`) },
      });
    } catch (err) {
      log(`wrongstack MCP server: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    log(
      `wrongstack MCP server ready at ${handle.url} — exposing ${allowed.length} tool(s) (${mode})` +
        `${token ? ' [token auth]' : ''}.`,
    );
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await handle.close();
    controller.abort();
    return 0;
  }

  log(`wrongstack MCP server ready on stdio — exposing ${allowed.length} tool(s) (${mode}).`);

  const handle = serveStdio(server);
  await handle.done;
  controller.abort();
  return 0;
}
