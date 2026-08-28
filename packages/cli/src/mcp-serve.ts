/**
 * `wstack mcp serve` — run WrongStack itself as an MCP server over stdio.
 *
 * Exposes the built-in tool registry to any MCP client (Claude Desktop, another
 * agent, an IDE). stdout is the JSON-RPC channel — every status/log line goes to
 * stderr. By default a safe `AutoApprovePermissionPolicy` is used: read-only
 * tools are exposed, while shell/write/edit and dangerous-capability tools are
 * withheld. `--yolo` exposes everything; `--tools a,b,c` restricts the set.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@wrongstack/core/agent';
import { ToolExecutor } from '@wrongstack/core/execution';
import { ToolRegistry } from '@wrongstack/core/registry';
import { AutoApprovePermissionPolicy, DefaultSecretScrubber } from '@wrongstack/core/security';
import type {
  PermissionPolicy,
  Provider,
  SessionWriter,
  TokenCounter,
  Tool,
} from '@wrongstack/core/types';
import { normalizeTokenSavingTier } from '@wrongstack/core/types';
import {
  DEFAULT_MCP_INSERTION_MAX_BYTES,
  MCPServer,
  type MCPServerPrompt,
  type MCPServerResource,
  type MCPServerToolHost,
  serveHttp,
  serveStdio,
} from '@wrongstack/mcp';
import { registerBuiltinToolTier } from '@wrongstack/tools/tool-tier';
import { wireKanbanPorts } from '@wrongstack/runtime';
import type { SubcommandDeps } from './subcommands/contracts.js';

/** `--yolo` policy: auto-approve everything (inherits the rest of the contract). */
class AllowAllPermissionPolicy extends AutoApprovePermissionPolicy {
  override async evaluate(): ReturnType<AutoApprovePermissionPolicy['evaluate']> {
    return { permission: 'auto', source: 'default' };
  }
}

/**
 * Resolve the `--tools` whitelist for `mcp serve`.
 *
 * `'tools'` is in BOOLEAN_FLAGS (a `models add` capability toggle), so
 * parseArgs turns the space form `mcp serve --tools read,grep` into
 * `tools: true` plus a positional CSV instead of a string value. Accept both
 * shapes: a string value directly, or `true` + the following positional CSV.
 * Returns null only when no list was supplied at all — callers must treat
 * "flag present but no list" as an error, never as "no whitelist".
 */
export function parseToolsFlag(
  flags: Record<string, string | boolean>,
  positional?: readonly string[],
): Set<string> | null {
  const raw = flags['tools'];
  const csv = typeof raw === 'string' ? raw : raw === true ? (positional?.[0] ?? '') : '';
  if (!csv) return null;
  const set = new Set(
    csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return set.size > 0 ? set : null;
}

interface SelectedMcpServeContent {
  resources: MCPServerResource[];
  prompts: MCPServerPrompt[];
}

/** Load only files explicitly named by trusted CLI flags; nothing is auto-discovered. */
export async function loadSelectedMcpServeContent(
  flags: Record<string, string | boolean>,
  cwd: string,
): Promise<SelectedMcpServeContent> {
  const resources: MCPServerResource[] = [];
  const prompts: MCPServerPrompt[] = [];
  const resourceUris = new Set<string>();
  const promptNames = new Set<string>();
  for (const selected of commaSeparatedFlag(flags, 'resources')) {
    const file = path.resolve(cwd, selected);
    const data = await readSelectedFile(file);
    const uri = pathToFileURL(file).toString();
    if (resourceUris.has(uri)) throw new Error(`Duplicate MCP resource selection: ${selected}`);
    resourceUris.add(uri);
    const mimeType = mimeTypeFor(file);
    resources.push({
      uri,
      name: path.basename(file),
      mimeType,
      size: data.byteLength,
      contents: [
        isTextMime(mimeType)
          ? { uri, mimeType, text: data.toString('utf8') }
          : { uri, mimeType, blob: data.toString('base64') },
      ],
    });
  }
  for (const selected of commaSeparatedFlag(flags, 'prompts')) {
    const file = path.resolve(cwd, selected);
    const data = await readSelectedFile(file);
    const name = path
      .basename(file, path.extname(file))
      .replace(/[^A-Za-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!name) throw new Error(`Cannot derive an MCP prompt name from: ${selected}`);
    if (promptNames.has(name)) throw new Error(`Duplicate MCP prompt name: ${name}`);
    promptNames.add(name);
    const template = data.toString('utf8');
    const argumentNames = Array.from(
      template.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_.-]*)\}\}/g),
      (match) => match[1],
    ).filter((value, index, all): value is string => !!value && all.indexOf(value) === index);
    prompts.push({
      name,
      description: `Explicitly selected local prompt: ${path.basename(file)}`,
      arguments: argumentNames.map((argument) => ({ name: argument, required: true })),
      template,
    });
  }
  return { resources, prompts };
}

function commaSeparatedFlag(
  flags: Record<string, string | boolean>,
  name: 'resources' | 'prompts',
): string[] {
  const value = flags[name];
  if (value === undefined) return [];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`--${name} requires a comma-separated file list`);
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readSelectedFile(file: string): Promise<Buffer> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`Selected MCP content is not a regular file: ${file}`);
  if (stat.size > DEFAULT_MCP_INSERTION_MAX_BYTES) {
    throw new Error(
      `Selected MCP content exceeds ${DEFAULT_MCP_INSERTION_MAX_BYTES} bytes: ${file}`,
    );
  }
  return fs.readFile(file);
}

function mimeTypeFor(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.md':
    case '.mdx':
      return 'text/markdown';
    case '.json':
      return 'application/json';
    case '.yaml':
    case '.yml':
      return 'application/yaml';
    case '.html':
      return 'text/html';
    case '.css':
      return 'text/css';
    case '.js':
    case '.mjs':
      return 'text/javascript';
    case '.ts':
    case '.tsx':
      return 'text/typescript';
    case '.txt':
    case '.log':
      return 'text/plain';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/yaml'
  );
}

/**
 * Whether the file tools are confined to the project root for `mcp serve`.
 *
 * `mcp serve` is the one surface where the file tools are driven by a REMOTE
 * caller, so an unset config must inherit containment rather than invert it —
 * an unset value here previously became `false`, which short-circuited
 * `ensureInsideRoot` and let `tools/call read` return `~/.ssh/id_rsa`.
 *
 * This lives in one exported function rather than as a literal repeated at each
 * call site so the invariant is testable and a third call site cannot quietly
 * reintroduce the wrong default. Only a trusted user config can opt out:
 * `tools.restrictToProjectRoot` is on the in-project denylist, so a
 * checked-out repository cannot reach it.
 */
export function resolveServeFsRestriction(config: {
  tools?: { restrictToProjectRoot?: boolean | undefined } | undefined;
}): boolean {
  return config.tools?.restrictToProjectRoot ?? true;
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

export async function serveMcpStdio(
  deps: SubcommandDeps,
  positional?: readonly string[],
): Promise<number> {
  const flags = deps.flags ?? {};
  const yolo = flags['yolo'] === true || flags['allow-all'] === true;
  const whitelist = parseToolsFlag(flags, positional);
  // `--tools` present but no list resolvable: fail loudly instead of silently
  // exposing the default (policy-filtered) toolset — a dropped whitelist is a
  // security-relevant widening, not a convenience fallback.
  if (flags['tools'] !== undefined && whitelist === null) {
    process.stderr.write(
      'wrongstack MCP server: --tools requires a comma-separated tool list ' +
        '(e.g. `--tools read,grep` or `--tools=read,grep`)\n',
    );
    return 1;
  }
  const log = (m: string) => process.stderr.write(`${m}\n`);
  let selectedContent: SelectedMcpServeContent;
  try {
    selectedContent = await loadSelectedMcpServeContent(flags, deps.cwd);
  } catch (err) {
    log(`wrongstack MCP server: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // Reuse the subcommand's pre-populated registry; fall back to a fresh one.
  wireKanbanPorts();
  let registry = deps.toolRegistry as ToolRegistry | undefined;
  if (!registry) {
    registry = new ToolRegistry();
    registerBuiltinToolTier({
      registry,
      tier: normalizeTokenSavingTier(deps.config.features.tokenSavingMode),
    });
  }

  const controller = new AbortController();
  // This context is only used while deciding which tools to expose. Tool calls
  // must receive a fresh Context below: Context carries mutable per-run state
  // such as workingDir and file tracking, which must never bleed between MCP
  // clients or concurrent requests.
  const selectionCtx = makeServeContext(
    deps.cwd,
    deps.projectRoot,
    controller.signal,
    resolveServeFsRestriction(deps.config),
  );
  const permissionPolicy: PermissionPolicy = yolo
    ? new AllowAllPermissionPolicy()
    : new AutoApprovePermissionPolicy();
  const executor = new ToolExecutor(registry, {
    permissionPolicy,
    secretScrubber: new DefaultSecretScrubber(),
    maxToolTimeoutMs: deps.config.tools?.maxToolTimeoutMs ?? 300_000,
    perIterationOutputCapBytes: 1_000_000,
    // Kanban tracks work; it does not gate it. Off unless the operator opts in.
    // See wiring/pipeline.ts for why all four hosts must agree.
    requireKanbanGovernance: deps.config.tools?.kanbanGovernance ?? false,
  });

  // Pre-compute the exposed set so tools/list and tools/call agree, and so a
  // withheld tool can never be invoked even if a client guesses its name.
  const allowed = await selectExposedTools(registry, selectionCtx, permissionPolicy, whitelist);
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
      // `sequential` applies only within this one-item batch. It does not
      // serialize requests from other MCP clients, while the fresh Context
      // prevents their mutable run state from being shared.
      const requestCtx = makeServeContext(
        deps.cwd,
        deps.projectRoot,
        controller.signal,
        resolveServeFsRestriction(deps.config),
      );
      const batch = await executor.executeBatch([use], requestCtx, 'sequential');
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
    resources: selectedContent.resources,
    prompts: selectedContent.prompts,
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
    // Keep bearer credentials out of the process list where possible. The
    // standalone MCP packages use the same environment variable.
    const tokenFromArg = typeof flags['token'] === 'string' ? flags['token'] : undefined;
    const token = tokenFromArg ?? process.env.WRONGSTACK_MCP_TOKEN?.trim() ?? undefined;
    if (tokenFromArg) {
      log(
        '[mcp-serve] --token puts the auth token in this process command line, which other local ' +
          'processes can read. Prefer WRONGSTACK_MCP_TOKEN.',
      );
    }
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
      `wrongstack MCP server ready at ${handle.url} — exposing ${allowed.length} tool(s), ` +
        `${selectedContent.resources.length} resource(s), ${selectedContent.prompts.length} prompt(s) (${mode})` +
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

  log(
    `wrongstack MCP server ready on stdio — exposing ${allowed.length} tool(s), ` +
      `${selectedContent.resources.length} resource(s), ${selectedContent.prompts.length} prompt(s) (${mode}).`,
  );

  const handle = serveStdio(server);
  await handle.done;
  controller.abort();
  return 0;
}
