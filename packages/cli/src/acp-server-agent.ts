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

import type { McpServer, RunTurnApi, SessionSystemPrompt } from '@wrongstack/acp/agent';
import { EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import {
  type Logger,
  type PermissionPolicy,
  type SessionWriter,
  type Tool,
  ToolValidationError,
} from '@wrongstack/contracts/types';
import { Agent, Context, createDefaultPipelines } from '@wrongstack/core/agent';
import { createModelRuntimeMiddleware, ToolExecutor } from '@wrongstack/core/execution';
import { DefaultLogger, DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { ToolRegistry } from '@wrongstack/core/registry';
import { AutoApprovePermissionPolicy } from '@wrongstack/core/security';
import type { WstackPaths } from '@wrongstack/core/utils';
import { WRONGFORGE_REASONING } from '@wrongstack/fleet';
import { type MCPRegistry, mcpServerInstructionsSection } from '@wrongstack/mcp';
import { catalogProviderIdFor, withCatalogCapabilities } from '@wrongstack/providers';
import {
  createDefaultContainer,
  createProjectPermissionPolicy,
  wireKanbanPorts,
} from '@wrongstack/runtime';
import { connectAcpSessionMcpServers } from './acp-mcp-servers.js';
import { ACPClientPermissionPolicy } from './acp-session-modes.js';

export { ACPClientPermissionPolicy } from './acp-session-modes.js';

import type { SubcommandDeps } from './subcommands/contracts.js';
import { setupProvider } from './wiring/provider.js';
import { buildProviderForId, resolveProviderCfgWithProxy } from './wiring/provider-runtime.js';

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
 * A complete no-op `SessionWriter` for an ACP session. It must implement the
 * whole interface, not just `append`: the agent loop calls `writeCheckpoint`
 * before the first provider request and `RunController.dispose` calls
 * `flush`, so a partial writer failed every turn before the model was ever
 * called (#421).
 */
export function createAcpSessionWriter(sessionId: string): SessionWriter {
  return {
    id: sessionId,
    pendingToolUses: [],
    append: async () => {},
    appendBatch: async () => {},
    flush: async () => {},
    close: async () => {},
    recordFileChange: () => {},
    recordSideEffect: () => {},
    writeCheckpoint: async () => {},
    writeFileSnapshot: async () => {},
    truncateToCheckpoint: async () => 0,
    clearSession: async () => {},
    writeInFlightMarker: async () => {},
    clearInFlightMarker: async () => {},
  };
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
    systemPrompt?: SessionSystemPrompt,
  ): Promise<Agent>;
  /** Stop and forget the MCP servers connected for this ACP session. */
  disposeSession(sessionId: string): void;
  /**
   * Run a session's agent on another provider/model, built the way the
   * `/model` switch builds it (saved credentials, catalog capabilities). A
   * no-op when the agent already runs it; throws when the provider cannot be
   * built, leaving the agent on its current model.
   */
  selectModel(agent: Agent, providerId: string, modelId: string): Promise<void>;
  /**
   * Apply a per-session reasoning effort override (`thought_level` config option).
   * Pass `undefined` or `'default'` to clear the override and fall back to the
   * project/provider default.
   */
  selectReasoningEffort(agent: Agent, effort: string | undefined): void;
}

interface AcpAgentFactoryOptions {
  /** Caller-supplied logger; a minimal stderr logger is created when omitted. */
  logger?: Logger | undefined;
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
    if (caps.fs?.readTextFile) {
      swap('edit', (base) => makeAcpEdit(base, api));
    }
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
        : // A string replacer expands $$, $&, $`, and $'. The replacement is exact text.
          before.replace(i.old_string, () => i.new_string ?? '');
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
      providerBoot = setupProvider({ config, modelsRegistry: deps.modelsRegistry, logger }).catch(
        (err) => {
          providerBoot = null;
          throw err;
        },
      );
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
  // A broken `.wrongstack/directory-rules.json` leaves no arbiter: `yolo` and
  // `auto-edit` then ask for every gated call rather than guess.
  const yoloArbiter = (cwd: string): PermissionPolicy | undefined => {
    try {
      return createProjectPermissionPolicy({
        projectRoot: cwd,
        trustFile: wpaths.projectTrust,
        config,
        permission: { yolo: true },
      })();
    } catch (err) {
      logger.warn(`ACP: permission rules for ${cwd} are unreadable; every gated call asks`, err);
      return undefined;
    }
  };
  const sessionGeneration = new Map<string, number>();
  const disposedSessions = new Set<string>();

  const agentFor = async function agentFor(
    sessionId: string,
    cwd: string,
    api?: RunTurnApi,
    mcpServers?: readonly McpServer[],
    systemPrompt?: SessionSystemPrompt,
  ): Promise<Agent> {
    disposedSessions.delete(sessionId);
    const generation = (sessionGeneration.get(sessionId) ?? 0) + 1;
    sessionGeneration.set(sessionId, generation);
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
    const previous = sessionMcp.get(sessionId);
    if (previous) {
      sessionMcp.delete(sessionId);
      void previous.stopAll().catch(() => {});
    }
    let mcpInstructions: string | undefined;
    if (mcpServers && mcpServers.length > 0 && !disposedSessions.has(sessionId)) {
      const mcp = await connectAcpSessionMcpServers({
        servers: mcpServers,
        toolRegistry: tools,
        events,
        logger,
        ...(wpaths.cacheDir ? { cacheDir: wpaths.cacheDir } : {}),
        cwd,
      });
      if (mcp) {
        if (disposedSessions.has(sessionId) || sessionGeneration.get(sessionId) !== generation) {
          void mcp.stopAll().catch((err) => {
            logger.warn(`ACP session ${sessionId}: MCP teardown failed`, err);
          });
        } else {
          sessionMcp.set(sessionId, mcp);
          // The servers' own `initialize` instructions, as `--mcp-config` gives them.
          mcpInstructions = mcpServerInstructionsSection(mcp);
        }
      }
    }

    // Permission posture: when the ACP client exposes a permission channel
    // (the live `wstack acp` path always does), route side-effecting tools
    // to the client for approval. Without a channel (tests, --echo) fall
    // back to the headless auto-approve, matching the subagent posture in
    // fleet/host.ts.
    // The session mode (`session/set_mode`) is read at each call; `yolo` and
    // `auto-edit` ask the policy `wstack --yolo` runs under (see acp-session-modes.ts).
    const permissionPolicy: PermissionPolicy = api?.requestPermission
      ? new ACPClientPermissionPolicy(api.requestPermission, {
          mode: () => api.currentModeId?.(),
          arbiter: yoloArbiter(cwd),
        })
      : new AutoApprovePermissionPolicy();

    const tokenCounter = new DefaultTokenCounter({
      registry: deps.modelsRegistry,
      providerId: config.provider,
      events,
    });

    // No-op session writer — ACP sessions don't persist to the JSONL
    // transcript store yet. It carries the ACP session id: the run pins
    // `activeRunSessionId` from it, and background `delegate` results are
    // routed to (and drained for) the leader by that id. Without it the
    // leader-delivery drain matched no session and a queued result could
    // never reach this conversation.
    const session = createAcpSessionWriter(sessionId);

    const context = new Context({
      systemPrompt: [
        ...(systemPrompt?.text ? [{ type: 'text' as const, text: systemPrompt.text }] : []),
        ...(mcpInstructions ? [{ type: 'text' as const, text: mcpInstructions }] : []),
      ],
      provider,
      session,
      signal: new AbortController().signal,
      tokenCounter,
      cwd,
      projectRoot: cwd,
      allowOutsideProjectRoot: config.features?.allowOutsideProjectRoot ?? false,
      model: config.model,
      tools: [...tools.listForProvider()] as Tool[],
      // The per-session agent IS that ACP session's leader. Leader-only loop
      // behaviour keys on this id — notably draining background delegation
      // results (`isLeaderAgentId`), which never matched 'acp-server'.
      agentId: 'leader',
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

    const catalogIdOf = (providerId: string): string =>
      catalogProviderIdFor(providerId, config.providers?.[providerId]?.type);
    const pipelines = createDefaultPipelines();
    pipelines.request.use(
      createModelRuntimeMiddleware({
        getSettings: () => config.modelRuntime,
        getReasoningConfig: () => undefined,
        resolveReasoningConfig: async (req, bound) => {
          const pid = bound?.id ?? context.provider?.id ?? config.provider;
          if (!pid) return undefined;
          const catalogId = catalogIdOf(pid);
          if (catalogId === 'wrongforge') return WRONGFORGE_REASONING;
          try {
            return (await deps.modelsRegistry?.getModel?.(catalogId, req.model))?.capabilities
              .reasoningConfig;
          } catch {
            return undefined;
          }
        },
        getCapabilities: () => context.provider?.capabilities,
      }),
    );

    return new Agent({
      container,
      tools,
      providers: providerRegistry,
      events,
      pipelines,
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

  agentFor.selectModel = async (agent: Agent, providerId: string, modelId: string) => {
    const ctx = agent.ctx;
    if (ctx.provider?.id === providerId && ctx.model === modelId) return;
    const { providerRegistry } = await bootProvider();
    await ctx.runModelTransition(async () => {
      let next = buildProviderForId({ config, providerRegistry, logger }, providerId);
      if (config.features?.modelsRegistry) {
        const { cfg } = resolveProviderCfgWithProxy(config, providerId);
        next = await withCatalogCapabilities(
          deps.modelsRegistry,
          providerId,
          next,
          { ...cfg, type: cfg.type ?? providerId, model: modelId },
          logger,
        );
      }
      ctx.provider = next;
      ctx.model = modelId;
    });
  };

  agentFor.selectReasoningEffort = (agent: Agent, effort: string | undefined): void => {
    if (!effort || effort === 'default') {
      delete agent.ctx.meta['reasoningEffort'];
    } else {
      agent.ctx.meta['reasoningEffort'] = effort;
    }
  };

  agentFor.disposeSession = (sessionId: string): void => {
    disposedSessions.add(sessionId);
    sessionGeneration.set(sessionId, (sessionGeneration.get(sessionId) ?? 0) + 1);
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
