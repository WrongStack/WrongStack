/**
 * ACP server → real WrongStack Agent wiring.
 *
 * `wstack acp` exposes WrongStack as an ACP v1 agent so any ACP-capable
 * client (Zed, JetBrains, VS Code ACP extension, etc.) can drive it. The
 * server-side `runTurn` adapter (`makeACPServerAgentTurn` in `@wrongstack/acp`)
 * needs a factory that produces a fresh, isolated `Agent` per session — this
 * module is that factory, reusing the same boot pieces the interactive CLI
 * uses (`setupProvider`, `createDefaultContainer`, builtin tools).
 *
 * Scope: a minimal but real agent. It deliberately does NOT wire compaction
 * middleware, model-runtime overlays, or lifecycle hooks — those belong in the
 * interactive host. It DOES wire the MCP servers the ACP client supplies with
 * `session/new`, because the spec makes those part of the session contract:
 * the client hands over its MCP configuration and expects the tools to be
 * there (see `acp-mcp-servers.ts`).
 */

import type { McpServer, RunTurnApi } from '@wrongstack/acp/agent';
import { Agent, Context, createDefaultPipelines } from '@wrongstack/core/agent';
import { ToolExecutor } from '@wrongstack/core/execution';
import { DefaultLogger, DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { EventBus, TOKENS } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import { AutoApprovePermissionPolicy, ToolCapabilities } from '@wrongstack/core/security';
import {
  type Logger,
  type PermissionDecision,
  type PermissionPolicy,
  type Tool,
  ToolValidationError,
} from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { MCPRegistry } from '@wrongstack/mcp';
import { createDefaultContainer, wireKanbanPorts } from '@wrongstack/runtime';
import { connectAcpSessionMcpServers } from './acp-mcp-servers.js';
import type { SubcommandDeps } from './subcommands/contracts.js';
import { setupProvider } from './wiring/provider.js';

/**
 * Error thrown when the server cannot start because no model provider is
 * configured. The CLI handler catches this and prints a actionable message
 * (`wstack auth`) rather than a stack trace.
 */
export class AcpServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpServerConfigError';
  }
}

/**
 * The per-session Agent factory, plus the teardown hook for anything the
 * session owns outside the Agent itself (currently the client's MCP servers).
 * `dispose` on the turn adapter drops the Agent; this drops the connections.
 */
export interface AcpServerAgentFactory {
  (
    sessionId: string,
    cwd: string,
    api?: RunTurnApi,
    mcpServers?: readonly McpServer[],
  ): Promise<Agent>;
  /** Stop and forget the MCP servers connected for this ACP session. */
  disposeSession(sessionId: string): void;
}

interface AcpAgentFactoryOptions {
  /** Caller-supplied logger; a minimal stderr logger is created when omitted. */
  logger?: Logger | undefined;
}

/** Capabilities considered safe to auto-approve without asking the client. */
const SAFE_CAPS = new Set<string>([
  ToolCapabilities.FS_READ,
  ToolCapabilities.NET_OUTBOUND,
  ToolCapabilities.COORDINATION_FLEET_READ,
]);

/**
 * Permission policy that routes side-effecting tool calls to the connected
 * ACP client via `session/request_permission` (the v1-correct behavior),
 * while auto-approving read-only/safe tools. This replaces the blanket
 * auto-approve so an editor driving WrongStack-as-agent gets a real
 * permission prompt before file writes / shell commands run.
 *
 * Exported for direct regression testing of the malformed-response path —
 * `acp-server-agent.test.ts` injects a response whose `optionId` is missing
 * (which previously threw a TypeError at `outcome.optionId.startsWith(...)`
 * and was misattributed to "no permission channel" by the surrounding
 * try/catch). Production callers go through `buildAcpServerAgentFactory`,
 * which constructs this internally when the client exposes a permission
 * channel.
 */
export class ACPClientPermissionPolicy implements PermissionPolicy {
  constructor(private readonly requestPermission: RunTurnApi['requestPermission']) {}

  async evaluate(tool: Tool, input: unknown): Promise<PermissionDecision> {
    const caps = tool.capabilities ?? [];
    // Safe iff every declared capability is in the safe set (and at least
    // one exists). A tool with no declared caps is treated as unsafe.
    const isSafe = caps.length > 0 && caps.every((c) => SAFE_CAPS.has(c));
    if (isSafe) {
      return { permission: 'auto', source: 'default' };
    }

    const title = describeToolCall(tool.name, input);
    try {
      const outcome = await this.requestPermission({
        toolCall: { toolCallId: `tc_${tool.name}_${Date.now()}`, title },
        options: [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const optionId = outcome.outcome === 'selected' ? outcome.optionId : undefined;
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

  async trust(): Promise<void> {}
  async deny(): Promise<void> {}
  denyOnce(): void {}
  allowOnce(): void {}
  async reload(): Promise<void> {}
}

function describeToolCall(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const r = input as Record<string, unknown>;
    const arg = r.path ?? r.file ?? r.command ?? r.pattern;
    if (typeof arg === 'string') return `${name}: ${arg}`;
  }
  return name;
}

/**
 * Swap filesystem/terminal tools for ACP-backed versions that operate on the
 * connected client's `fs/*` + `terminal/*`, gated on the client's advertised
 * capabilities. Each ACP tool reuses the builtin's name/description/inputSchema
 * so the model calls it identically — only execution is redirected.
 *
 * Note: for a local (stdio) client the agent and editor share a filesystem, so
 * tools that aren't redirected still operate on the same real files; this swap
 * adds editor-buffer awareness and makes remote (WebSocket) agents correct.
 */
function wireClientBackedTools(tools: ToolRegistry, api: RunTurnApi): void {
  const caps = api.clientCapabilities ?? {};
  const swap = (name: string, make: (base: Tool) => Tool): void => {
    const base = tools.get(name);
    if (!base) return;
    tools.unregister(name);
    tools.register(make(base));
  };
  if (caps.fs?.readTextFile) {
    swap('read', (base) => makeAcpRead(base, api));
  }
  if (caps.fs?.writeTextFile) {
    swap('write', (base) => makeAcpWrite(base, api));
    swap('edit', (base) => makeAcpEdit(base, api));
  }
  if (caps.terminal) {
    swap('bash', (base) => makeAcpBash(base, api));
  }
}

function makeAcpRead(base: Tool, api: RunTurnApi): Tool {
  return {
    ...base,
    mutating: false,
    execute: async (input: unknown) => {
      const i = (input ?? {}) as { path?: string; offset?: number; limit?: number };
      if (!i.path)
        throw new ToolValidationError({ message: 'read: path is required', field: 'path' });
      const content = await api.readTextFile({
        path: i.path,
        ...(typeof i.offset === 'number' ? { line: i.offset } : {}),
        ...(typeof i.limit === 'number' ? { limit: i.limit } : {}),
      });
      const lines = content.split(/\r\n|\r|\n/);
      const start = Math.max(1, i.offset ?? 1);
      const width = String(start + lines.length - 1).length;
      const text = lines
        .map((l, idx) => `${String(start + idx).padStart(width, ' ')}→${l}`)
        .join('\n');
      return { text, total_lines: lines.length, encoding: 'utf8', truncated: false };
    },
  } as Tool;
}

function makeAcpWrite(base: Tool, api: RunTurnApi): Tool {
  return {
    ...base,
    execute: async (input: unknown) => {
      const i = (input ?? {}) as { path?: string; content?: string };
      if (!i.path)
        throw new ToolValidationError({ message: 'write: path is required', field: 'path' });
      await api.writeTextFile({ path: i.path, content: i.content ?? '' });
      return { path: i.path, ok: true };
    },
  } as Tool;
}

function makeAcpEdit(base: Tool, api: RunTurnApi): Tool {
  return {
    ...base,
    execute: async (input: unknown) => {
      const i = (input ?? {}) as {
        path?: string;
        old_string?: string;
        new_string?: string;
        replace_all?: boolean;
      };
      if (!i.path)
        throw new ToolValidationError({ message: 'edit: path is required', field: 'path' });
      if (!i.old_string)
        throw new ToolValidationError({
          message: 'edit: old_string is required',
          field: 'old_string',
        });
      const before = await api.readTextFile({ path: i.path });
      const occurrences = before.split(i.old_string).length - 1;
      if (occurrences === 0) {
        throw new ToolValidationError({
          message: `edit: old_string not found in "${i.path}"`,
          field: 'old_string',
          context: { path: i.path },
        });
      }
      if (occurrences > 1 && !i.replace_all) {
        throw new ToolValidationError({
          message: `edit: old_string appears ${occurrences} times in "${i.path}"; pass replace_all or use a more specific string`,
          field: 'old_string',
          context: { path: i.path, occurrences, replaceAll: false },
        });
      }
      const after = i.replace_all
        ? before.split(i.old_string).join(i.new_string ?? '')
        : before.replace(i.old_string, i.new_string ?? '');
      await api.writeTextFile({ path: i.path, content: after });
      return { path: i.path, replacements: i.replace_all ? occurrences : 1 };
    },
  } as Tool;
}

function makeAcpBash(base: Tool, api: RunTurnApi): Tool {
  return {
    ...base,
    execute: async (input: unknown) => {
      const i = (input ?? {}) as { command?: string; cwd?: string };
      if (!i.command)
        throw new ToolValidationError({ message: 'bash: command is required', field: 'command' });
      // ACP terminals run the command through the client's shell; we pass it
      // as `sh -c "<command>"` so pipelines/operators work as the model expects.
      const { output, exitCode } = await api.runTerminal({
        command: 'sh',
        args: ['-c', i.command],
        ...(i.cwd ? { cwd: i.cwd } : {}),
      });
      return { stdout: output, exit_code: exitCode, command: i.command };
    },
  } as Tool;
}

/**
 * Build a per-session `Agent` factory suitable for `makeACPServerAgentTurn`.
 *
 * The provider registry + container are built once (they're stateless across
 * sessions); each `agentFor(sessionId, cwd)` call builds a fresh `EventBus`,
 * `Context`, and `Agent` so sessions stay isolated per the v1 spec.
 *
 * Throws `AcpServerConfigError` up front if no provider is configured.
 */
export function buildAcpServerAgentFactory(
  deps: SubcommandDeps,
  options: AcpAgentFactoryOptions = {},
): AcpServerAgentFactory {
  const config = deps.config;
  if (!config.provider || !config.model) {
    throw new AcpServerConfigError(
      'No model provider is configured. Run `wstack auth` to add credentials, ' +
        'or start the server with `wstack acp --echo` for a no-op connectivity test.',
    );
  }

  const logger = options.logger ?? new DefaultLogger({ stderr: true });
  const wpaths: WstackPaths = deps.paths;

  // Provider + registry — built once, reused across sessions.
  // setupProvider is async, but factory consumers expect a sync `agentFor`.
  // We kick it off lazily and memoize so the first session pays the one-time
  // models.dev lookup cost; later sessions reuse the resolved registry.
  type ProviderBoot = Awaited<ReturnType<typeof setupProvider>>;
  let providerBoot: Promise<ProviderBoot> | null = null;
  const bootProvider = (): Promise<ProviderBoot> => {
    if (!providerBoot) {
      providerBoot = setupProvider({ config, modelsRegistry: deps.modelsRegistry, logger });
    }
    return providerBoot;
  };

  // Container — built once; safe to share across sessions (it only holds
  // stateless service bindings, not per-run state).
  const container = createDefaultContainer({
    config,
    wpaths,
    logger,
    modelsRegistry: deps.modelsRegistry,
  });

  // Per-session MCP registries, keyed by ACP session id. Held here (not on the
  // Agent) because teardown is driven by `session/close`, which reaches this
  // module through `disposeSession` rather than through the Agent.
  const sessionMcp = new Map<string, MCPRegistry>();

  const agentFor = async function agentFor(
    sessionId: string,
    cwd: string,
    api?: RunTurnApi,
    mcpServers?: readonly McpServer[],
  ): Promise<Agent> {
    await container.resolve(TOKENS.MemoryStore).initialize();
    const { provider, providerRegistry } = await bootProvider();

    // Per-session event bus — keeps each ACP session's tool/iteration events
    // isolated from the others.
    const events = new EventBus();

    // Per-session tool registry: start from the builtins, then (when the
    // client advertises fs/terminal) swap read/write/edit/bash for
    // ACP-backed versions that operate on the CLIENT's filesystem and
    // terminal — so the editor's view (incl. unsaved buffers) is the source
    // of truth. A fresh registry avoids mutating the shared builtin one.
    // Composition-root wiring (#11): governance port fires per tool call.
    wireKanbanPorts();
    const source = deps.toolRegistry ?? new ToolRegistry();
    const tools = source.clone();
    if (api) {
      wireClientBackedTools(tools, api);
    }

    // The client's own MCP servers, connected before the Context below
    // snapshots `listForProvider()` — a tool registered after that snapshot
    // would be missing from the first turn's provider payload.
    if (mcpServers && mcpServers.length > 0) {
      const previous = sessionMcp.get(sessionId);
      if (previous) void previous.stopAll().catch(() => {});
      const mcp = await connectAcpSessionMcpServers({
        servers: mcpServers,
        toolRegistry: tools,
        events,
        logger,
        ...(wpaths.cacheDir ? { cacheDir: wpaths.cacheDir } : {}),
      });
      if (mcp) sessionMcp.set(sessionId, mcp);
    }

    // Permission posture: when the ACP client exposes a permission channel
    // (the live `wstack acp` path always does), route side-effecting tools
    // to the client for approval. Without a channel (tests, --echo) fall
    // back to the headless auto-approve, matching the subagent posture in
    // fleet/host.ts.
    const permissionPolicy: PermissionPolicy = api?.requestPermission
      ? new ACPClientPermissionPolicy(api.requestPermission)
      : new AutoApprovePermissionPolicy();

    const tokenCounter = new DefaultTokenCounter({
      registry: deps.modelsRegistry,
      providerId: config.provider,
      events,
    });

    // Minimal session writer — ACP sessions don't persist to the JSONL
    // transcript store yet. A no-op writer keeps the Context contract happy.
    const session = { append: async () => {} } as never;

    const context = new Context({
      systemPrompt: [],
      provider,
      session,
      signal: new AbortController().signal,
      tokenCounter,
      cwd,
      projectRoot: cwd,
      allowOutsideProjectRoot: config.features?.allowOutsideProjectRoot ?? false,
      model: config.model,
      tools: [...tools.listForProvider()] as Tool[],
      agentId: 'acp-server',
      agentName: 'wrongstack-acp',
    });

    const toolExecutor = new ToolExecutor(tools, {
      permissionPolicy,
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      renderer: undefined,
      events,
      confirmAwaiter: undefined,
      iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? 120_000,
      maxToolTimeoutMs: config.tools?.maxToolTimeoutMs ?? 300_000,
      perIterationOutputCapBytes: config.tools?.perIterationOutputCapBytes ?? 100_000,
      tracer: undefined,
      // Kanban tracks work; it does not gate it. Off unless the operator opts
      // in. See wiring/pipeline.ts for why all four hosts must agree.
      requireKanbanGovernance: config.tools?.kanbanGovernance ?? false,
    });

    return new Agent({
      container,
      tools,
      providers: providerRegistry,
      events,
      pipelines: createDefaultPipelines(),
      context,
      permissionPolicy,
      toolExecutor,
      loopDetection: config.tools?.loopDetection,
      // `tools.maxIterations` was never read on this host, so an operator who
      // set a turn budget got it honoured on the CLI and WebUI hosts and
      // silently ignored here. Only a POSITIVE value is forwarded: the shipped
      // default is `0` ("no hard limit"), and handing that to the agent loop
      // would trade a missing setting for a missing safety net. Absent an
      // explicit budget the Agent keeps its own DEFAULT_MAX_ITERATIONS.
      ...(typeof config.tools?.maxIterations === 'number' &&
      Number.isFinite(config.tools.maxIterations) &&
      config.tools.maxIterations > 0
        ? { maxIterations: config.tools.maxIterations }
        : {}),
    });
  } as AcpServerAgentFactory;

  agentFor.disposeSession = (sessionId: string): void => {
    const mcp = sessionMcp.get(sessionId);
    if (!mcp) return;
    sessionMcp.delete(sessionId);
    // Fire-and-forget: `session/close` must not block on child processes
    // shutting down, and a stuck server would otherwise stall the client.
    void mcp.stopAll().catch((err) => {
      logger.warn(`ACP session ${sessionId}: MCP teardown failed`, err);
    });
  };

  return agentFor;
}
