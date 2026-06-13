import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
/**
 * L1-E: Multi-agent CLI integration. The coordinator + per-task agent
 * factory is created lazily on the first `/spawn` so users who never use
 * subagents don't pay the construction cost.
 */
import { ACP_AGENT_COMMANDS, makeACPSubagentRunner } from '@wrongstack/acp';
import type { BrainArbiter, SubagentRunner, TextBlock } from '@wrongstack/core';
import {
  Agent,
  type AgentFactory,
  AutoApprovePermissionPolicy,
  type Config,
  type ConfigStore,
  type Container,
  Context,
  createDefaultPipelines,
  DEFAULT_SUBAGENT_BASELINE,
  type DefaultMultiAgentCoordinator,
  Director,
  type DirectorSessionFactory,
  EventBus,
  FLEET_ROSTER,
  FleetManager,
  GlobalMailbox,
  type ModelsRegistry,
  makeDirectorSessionFactory,
  makeFleetEmitTool,
  makeFleetStatusTool,
  type Provider,
  type ProviderRegistry,
  resolveModelMatrix,
  type SessionWriter,
  type SubagentConfig,
  type SystemPromptBuilder,
  type TaskResult,
  type TokenCounter,
  type Tool,
  ToolRegistry,
} from '@wrongstack/core';
import { ToolExecutor } from '@wrongstack/core/execution';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { resolveRuntimeMaxContext } from '../context-limit.js';
import { createFallbackModelExtension } from '../fallback-model.js';
import { buildRoutingRunner } from './routing.js';

export interface MultiAgentDeps {
  container: Container;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  configStore: ConfigStore;
  /**
   * Models catalog used to resolve a subagent provider's real context
   * window. Without it, an `openai-compatible` subagent (DeepSeek, Groq,
   * …) falls back to the 32k family default and the fleet panel reports
   * the wrong window per subagent. Optional so callers/tests that don't
   * wire it still build providers (the family default applies).
   */
  modelsRegistry?: ModelsRegistry | undefined;
  events: EventBus;
  systemPromptBuilder: SystemPromptBuilder;
  session: SessionWriter;
  tokenCounter: TokenCounter;
  projectRoot: string;
  cwd: string;
  secretScrubber: import('@wrongstack/core').SecretScrubber;
  renderer?: import('@wrongstack/core').Renderer | undefined;
}

/**
 * Per-session options that flip the orchestration mode. Director mode
 * routes lifecycle through a `Director`, which unlocks manifest writing
 * and (later) FleetBus observability — at the cost of building a slightly
 * heavier wrapper around the same coordinator. Default mode is the plain
 * coordinator path that existing `/spawn` users already rely on.
 */
export interface MultiAgentHostOptions {
  /**
   * Enable Director-backed orchestration. The host still exposes the same
   * `spawn` / `status` / `usage` / `kill` API; under the hood, calls flow
   * through a `Director` so manifest writing works and the FleetBus is
   * available for future observability hooks.
   */
  directorMode?: boolean | undefined;
  /**
   * Absolute file path the director writes its fleet manifest to on
   * shutdown (and on-demand via `manifest()`). Only meaningful when
   * `directorMode` is true; ignored otherwise.
   */
  manifestPath?: string | undefined;
  /**
   * Absolute path to the fleet's shared scratchpad directory. When set,
   * subagent system prompts are augmented with a "Shared notes" block
   * pointing here so agents can pass conclusions through the filesystem
   * without going through the bridge. Directory is created on first
   * spawn. Only meaningful in director mode.
   */
  sharedScratchpadPath?: string | undefined;
  /**
   * Absolute path to the directory under which per-subagent JSONL
   * transcripts land — typically `<projectSessions>/<sessionId>/subagents/`.
   * When set, the host builds a `DirectorSessionFactory` rooted there and
   * each spawned subagent gets its own session writer (instead of sharing
   * the parent session). Director mode only.
   */
  sessionsRoot?: string | undefined;
  /**
   * Director run id for namespacing per-subagent JSONLs. Defaults to the
   * coordinator id when omitted. Pass an explicit id when resuming from a
   * prior fleet manifest.
   */
  directorRunId?: string | undefined;
  /**
   * Base directory for fleet artifacts (manifest, shared scratchpad,
   * subagent sessions). When set and director mode is promoted at runtime
   * (via /director), paths are derived as:
   *   <fleetRoot>/fleet.json        (manifest)
   *   <fleetRoot>/shared/           (scratchpad)
   *   <fleetRoot>/subagents/        (per-subagent JSONL)
   */
  fleetRoot?: string | undefined;
  /**
   * Absolute path the director writes its live state checkpoint to. Distinct
   * from `manifestPath` (final record) — the checkpoint mirrors pending /
   * running / completed tasks on every mutation so `wstack resume` can show
   * a "you had N tasks in flight" banner after a crash. Only meaningful in
   * director mode.
   */
  stateCheckpointPath?: string | undefined;
  /**
   * Fleet-wide cost ceiling for the director. When set, the director
   * refuses any new spawn that would push total fleet spend above this
   * limit. In-flight subagents complete normally; only new spawns are
   * blocked. Only meaningful in director mode.
   */
  directorBudget?: {
    maxCostUsd?: number | undefined;
  };
  /**
   * Maximum auto-extensions per subagent per budget kind before the
   * director denies further extensions. Default: 2. Only meaningful in
   * director mode.
   */
  maxBudgetExtensions?: number | undefined;
  /** Optional global Brain arbiter for director-level policy decisions. */
  brain?: BrainArbiter | undefined;
  /**
   * Maximum number of subagent tasks that may run concurrently. Extra
   * tasks queue in the coordinator's pending list and dispatch as slots
   * free. Default: 4. Raising this lets more work proceed in parallel
   * at the cost of provider rate-limit pressure (each subagent makes
   * its own API calls).
   */
  maxConcurrent?: number | undefined;
  /**
   * Live max context window for the leader model. Director spawn guards read
   * this lazily so runtime provider/model switches do not leave the fleet
   * using the launch-time family default.
   */
  getLeaderMaxContext?: (() => number) | undefined;
  /**
   * Debounce window for state-checkpoint writes in milliseconds.
   * Default: 250. Only meaningful in director mode.
   */
  checkpointDebounceMs?: number | undefined;
  /**
   * Session writer the director forwards task lifecycle events to
   * (agent_spawned, task_created, task_completed, task_failed). The CLI
   * passes the same writer the host Agent uses so all events land in one
   * JSONL. Optional — when omitted, those events stay in-memory.
   */
  sessionWriter?: import('@wrongstack/core').SessionWriter | undefined;
}

/**
 * Lazy holder — created on first /spawn call, reused across the session
 * so /agents can list everyone running.
 */
export class MultiAgentHost {
  private director?: Director | undefined;
  /** Own FleetManager — created in buildDirector(), used for pending task
   *  tracking so status() can show descriptions without host-side state. */
  private fleetManager?: import('@wrongstack/core').FleetManager | undefined;
  /** Own FleetEmitTool — created in buildDirector() so subagents in director
   *  mode can publish structured events (bug.found, refactor.plan,
   *  critic.evaluation) onto the fleet bus without needing the tool registered
   *  in the host's ToolRegistry. */
  private fleetEmitTool?: import('@wrongstack/core').Tool | undefined;
  /** Own FleetStatusTool — created in buildDirector() so subagents in director
   *  mode can read fleet state (subagent statuses, task progress) without the
   *  tool being in the host's ToolRegistry. */
  private fleetStatusTool?: import('@wrongstack/core').Tool | undefined;
  /** Lazily built alongside the director — produces per-subagent JSONL
   *  writers under `<sessionsRoot>/<runId>/`. Null without sessionsRoot. */
  private sessionFactory?: DirectorSessionFactory | undefined;
  private readonly opts: MultiAgentHostOptions;
  /**
   * Populated by `promoteToDirector` when it refuses to promote. The delegate
   * tool reads this through `getPromotionBlockReason` to render an
   * actionable error instead of a generic "Director could not be activated".
   */
  private promotionBlockReason: string | null = null;

  constructor(
    private readonly deps: MultiAgentDeps,
    opts: MultiAgentHostOptions = {},
  ) {
    this.opts = opts;
  }

  /**
   * Force the lazy build path to run *now* and return the live Director,
   * or null when director mode is off. Used by the CLI to register the
   * fleet's LLM-callable orchestration tools (spawn_subagent,
   * assign_task, await_tasks, ask_subagent, roll_up, terminate_subagent,
   * fleet_status, fleet_usage) into the leader's ToolRegistry before the
   * agent starts — without this, the leader literally cannot see the
   * orchestration tools and `--director` becomes a no-op.
   */
  async ensureDirector(): Promise<Director | null> {
    if (this.director) return this.director;
    if (!this.opts.directorMode) return null;
    await this.buildDirector();
    return this.director ?? null;
  }

  /** Access the Director's internal coordinator. Returns the concrete
   *  `DefaultMultiAgentCoordinator` so callers can use class-only surface
   *  (`on`, `setRunner`) that isn't part of the `MultiAgentCoordinator`
   *  interface. */
  private getCoordinator(): DefaultMultiAgentCoordinator {
    return (this.director as unknown as { coordinator: DefaultMultiAgentCoordinator }).coordinator;
  }

  /** Public accessor for the Director — used by buildRoutingRunner. */
  getDirector(): Director | undefined {
    return this.director;
  }

  private async ensureCoordinator(_config: Config): Promise<void> {
    await this.buildDirector();
  }

  private async buildDirector(): Promise<void> {
    if (this.director) return; // Already built — idempotent.
    const config: Config = this.deps.configStore.get() as Config;

    // Create the FleetManager FIRST so we can pass it to the Director.
    // The FleetManager owns pending task tracking (addPendingTask /
    // removePendingTask) used by status(), plus manifest + checkpointing.
    const fleetManager = new FleetManager({
      manifestPath: this.opts.manifestPath,
      sessionsRoot: this.opts.sessionsRoot,
      directorRunId: this.opts.directorRunId,
      stateCheckpointPath: this.opts.stateCheckpointPath,
      sessionWriter: this.opts.sessionWriter,
      directorBudget: this.opts.directorBudget,
      manifestDebounceMs: 2000,
      checkpointDebounceMs: this.opts.checkpointDebounceMs ?? 250,
      maxSpawnDepth: 5,
      maxContext: this.opts.getLeaderMaxContext,
    });
    this.fleetManager = fleetManager;

    if (this.opts.sessionsRoot && !this.sessionFactory) {
      this.sessionFactory = makeDirectorSessionFactory({
        sessionsRoot: this.opts.sessionsRoot,
        directorRunId: this.opts.directorRunId,
      });
    }

    const coordinatorConfig = {
      coordinatorId: randomUUID(),
      doneCondition: { type: 'all_tasks_done' as const },
      maxConcurrent: this.opts.maxConcurrent ?? 4,
    };

    const defaultScratchpad: string | undefined =
      this.opts.sharedScratchpadPath ||
      (this.opts.sessionsRoot && this.opts.directorRunId
        ? path.join(this.opts.sessionsRoot, this.opts.directorRunId, 'shared')
        : undefined);
    this.director = new Director({
      config: coordinatorConfig,
      manifestPath: this.opts.manifestPath,
      sharedScratchpadPath: defaultScratchpad,
      stateCheckpointPath: this.opts.stateCheckpointPath,
      sessionWriter: this.opts.sessionWriter,
      directorBudget: this.opts.directorBudget,
      maxBudgetExtensions: this.opts.maxBudgetExtensions,
      checkpointDebounceMs: this.opts.checkpointDebounceMs,
      sessionsRoot: this.opts.sessionsRoot,
      directorRunId: this.opts.directorRunId,
      maxSpawnDepth: 5,
      maxContext: this.opts.getLeaderMaxContext,
      // Live getter (not a snapshot) so a mid-session `/setmodel` takes
      // effect on the next spawn — the director is built lazily + once.
      modelMatrix: () => this.deps.configStore.get().modelMatrix,
      fleetManager, // pass so director.fleetManager is never undefined
      brain: this.opts.brain,
    });
    this.director.on('task.completed', ({ task, result }) => {
      this.fleetManager?.removePendingTask(task.id);
      this.emitLifecycleCompleted(task.id, result);
    });
    this.director.fleet.filter('budget.threshold_reached', (e) => {
      const payload = e.payload as { kind: string; used: number; limit: number };
      this.deps.events.emit('subagent.budget_warning', {
        subagentId: e.subagentId,
        kind: payload.kind,
        used: payload.used,
        limit: payload.limit,
      });
    });
    // The director resolves a threshold negotiation by granting an extension
    // and broadcasting budget.extended on the FleetBus. Bridge it to the host
    // bus so the TUI monitor / REPL fleet line can show a "⚡ extended ×N"
    // badge — the live proof that never-die kept the agent running.
    this.director.fleet.filter('budget.extended', (e) => {
      const payload = e.payload as { kind: string; newLimit: number; totalExtensions: number };
      this.deps.events.emit('subagent.budget_extended', {
        subagentId: e.subagentId,
        kind: payload.kind,
        newLimit: payload.newLimit,
        totalExtensions: payload.totalExtensions,
      });
    });
    // Forward ctx.pct events from the FleetBus to the host EventBus so the TUI
    // can render live context-window fill bars per subagent.
    this.director.fleet.filter('ctx.pct', (e) => {
      const payload = e.payload as { load: number; tokens: number; maxContext: number };
      this.deps.events.emit('subagent.ctx_pct', {
        subagentId: e.subagentId,
        load: payload.load,
        tokens: payload.tokens,
        maxContext: payload.maxContext,
      });
    });
    // Forward subagent.spawned from FleetBus to host EventBus so the TUI can
    // track collab agents (bug-hunter, refactor-planner, critic) that bypass
    // MultiAgentHost.spawn and go through director.spawn directly.
    this.director.fleet.filter('subagent.spawned', (e) => {
      const payload = e.payload as {
        subagentId: string;
        taskId: string;
        name?: string | undefined;
        role?: string | undefined;
        provider?: string | undefined;
        model?: string | undefined;
      };
      this.deps.events.emit('subagent.spawned', {
        subagentId: payload.subagentId,
        taskId: payload.taskId,
        name: payload.name,
        provider: payload.provider,
        model: payload.model,
      });
    });
    this.getCoordinator().on(
      'task.assigned',
      ({
        task,
        subagentId,
      }: {
        task: { id: string; description?: string | undefined };
        subagentId: string;
      }) => {
        this.deps.events.emit('subagent.task_started', {
          subagentId,
          taskId: task.id,
          description: task.description,
        });
      },
    );
    this.fleetEmitTool = makeFleetEmitTool(this.director);
    this.fleetStatusTool = makeFleetStatusTool(this.director);
    const runner = await this.buildSubagentRunner(config);
    this.getCoordinator().setRunner(runner);
  }

  /**
   * Returns the FleetEmitTool for director-mode subagents, if the director
   * has been built. Used by makeSubagentFactory to inject the tool into
   * the filtered tool registry so collab session agents can emit fleet events.
   */
  getFleetEmitTool(): import('@wrongstack/core').Tool | undefined {
    return this.fleetEmitTool;
  }

  /**
   * Build a per-role subagent factory: given a SubagentConfig, construct a
   * fresh, isolated Agent with the role's filtered tools and (when the config
   * carries one) the role's persona as an appended system-prompt block. Public
   * so the autonomy-parallel engine can reuse the exact same agent-construction
   * path the director/spawn flow uses — each parallel slot then runs as a real,
   * specialized, concurrency-safe agent instead of sharing the leader's Context.
   */
  makeSubagentFactory(config: Config): AgentFactory {
    return async (subCfg: SubagentConfig) => {
      const events = new EventBus();
      // Per-task model matrix safety net. Director.spawn already fills these in
      // for director-routed spawns, but direct-factory paths (e.g. the
      // autonomy-parallel engine) call the factory without going through the
      // director — resolve here too so they honor the matrix. Explicit
      // per-subagent model/provider always win.
      const matrixEntry = subCfg.model
        ? undefined
        : resolveModelMatrix(this.deps.configStore.get().modelMatrix, subCfg.role);
      const effProvider = subCfg.provider ?? matrixEntry?.provider ?? config.provider;
      const effModel = subCfg.model ?? matrixEntry?.model ?? config.model;
      const provider = await this.buildSubagentProvider(config, effProvider, effModel);

      // Per-subagent cwd (defaults to the factory cwd). AutoPhase points this
      // at a phase's git worktree so isolated checkouts don't collide.
      const subCwd = subCfg.cwd ?? this.deps.cwd;

      // Fetch online agents from the shared mailbox to include in subagent prompt
      let onlineAgents: Awaited<ReturnType<GlobalMailbox['getAgentStatuses']>> = [];
      try {
        const subagentMailbox = new GlobalMailbox(this.deps.projectRoot);
        onlineAgents = await subagentMailbox.getAgentStatuses();
      } catch {
        // Non-fatal — mailbox errors should not block subagent creation
      }

      const baseSystem: TextBlock[] = await this.deps.systemPromptBuilder.build({
        cwd: subCwd,
        projectRoot: this.deps.projectRoot,
        tools: this.filterTools(subCfg.tools),
        model: effModel,
        provider: effProvider,
        // Tell the builder this is a subagent build — skips the host's
        // plan injection so each subagent gets a clean, task-scoped
        // prompt instead of inheriting strategic context that's
        // meaningless to a single delegated subtask.
        subagent: true,
        onlineAgents,
      });

      // Prepend bridge contract so the subagent knows it has a parent it
      // can ask for clarification. Placed first so the subagent reads its
      // role in the hierarchy before absorbing the full identity block.
      // The builder already includes the identity + tools + skills layers.
      baseSystem.unshift({ type: 'text', text: DEFAULT_SUBAGENT_BASELINE });

      // Append the role persona. Priority:
      //   1. Explicit `systemPromptOverride` on the SubagentConfig (caller control)
      //   2. Roster lookup by `subCfg.role` — matches catalog agents (bug-hunter, etc.)
      //   3. Nothing — subagent runs with generic identity + bridge contract only
      const rolePrompt =
        subCfg.systemPromptOverride ??
        (subCfg.role ? FLEET_ROSTER[subCfg.role]?.prompt : undefined);
      if (rolePrompt) {
        baseSystem.push({ type: 'text', text: rolePrompt });
      }

      const subagentName = subCfg.id ?? subCfg.name ?? `sub_${randomUUID().slice(0, 8)}`;
      let subSession: SessionWriter;
      if (this.sessionFactory) {
        subSession = await this.sessionFactory.createSubagentSession({
          subagentId: subagentName,
          provider: effProvider,
          model: effModel,
          title: `subagent: ${subagentName}`,
        });
      } else {
        // No session factory — interleave subagent events into the parent's
        // JSONL. This shim must implement the FULL SessionWriter surface the
        // agent loop touches: runInner calls flush()/writeCheckpoint()
        // unguarded and the tool handler calls appendBatch(); a partial shim
        // crashes the subagent on its first input. Checkpoints, in-flight
        // markers, and lifecycle calls are deliberate no-ops — subagent
        // promptIndices/markers in the PARENT log would corrupt the parent's
        // rewind and crash-recovery state, and the parent owns close().
        const parentSession = this.deps.session;
        subSession = {
          id: parentSession.id,
          transcriptPath: parentSession.transcriptPath,
          get pendingToolUses(): string[] {
            return [];
          },
          append: (ev) => parentSession.append({ ...ev }),
          appendBatch: (evs) => parentSession.appendBatch(evs.map((e) => ({ ...e }))),
          flush: () => parentSession.flush(),
          close: async () => {},
          recordFileChange: () => {},
          writeCheckpoint: async () => {},
          writeFileSnapshot: async () => {},
          truncateToCheckpoint: async () => 0,
          clearSession: async () => {},
          writeInFlightMarker: async () => {},
          clearInFlightMarker: async () => {},
        } satisfies SessionWriter;
      }

      // Expand fleet_emit and fleet_status: when a subagent requests these tools
      // and the director has been built (director mode), inject them directly into
      // the subagent's registry. This is the path that makes collab session agents
      // (BugHunter, RefactorPlanner, Critic) able to emit and query fleet events
      // without the host registering these tools in its own ToolRegistry.
      const tools = subCfg.tools ? [...subCfg.tools] : undefined;
      let injectedFleetEmit: Tool | undefined;
      let injectedFleetStatus: Tool | undefined;
      if (tools) {
        const emitIdx = tools.indexOf('fleet_emit');
        if (emitIdx >= 0 && this.fleetEmitTool) {
          tools.splice(emitIdx, 1);
          injectedFleetEmit = this.fleetEmitTool;
        }
        const statusIdx = tools.indexOf('fleet_status');
        if (statusIdx >= 0 && this.fleetStatusTool) {
          tools.splice(statusIdx, 1);
          injectedFleetStatus = this.fleetStatusTool;
        }
      }

      const ctx = new Context({
        systemPrompt: baseSystem,
        provider,
        session: subSession,
        signal: new AbortController().signal,
        tokenCounter: this.deps.tokenCounter,
        cwd: subCwd,
        projectRoot: this.deps.projectRoot,
        model: effModel,
        tools: this.filterTools(tools),
        // Distinct mailbox identity: without these, every subagent fell back
        // to the host's 'leader' base id and they all collided in the shared
        // project mailbox registry (and consumed each other's read receipts).
        agentId: subagentName,
        agentName: subCfg.name ?? subagentName,
      });
      if (subCfg.role) ctx.meta['agentRole'] = subCfg.role;

      const baseRegistry = this.subagentToolRegistry(tools);
      if (injectedFleetEmit) baseRegistry.register(injectedFleetEmit);
      if (injectedFleetStatus) baseRegistry.register(injectedFleetStatus);
      const toolExecutor = new ToolExecutor(baseRegistry, {
        permissionPolicy: new AutoApprovePermissionPolicy(),
        secretScrubber: this.deps.secretScrubber,
        renderer: this.deps.renderer,
        events,
        confirmAwaiter: undefined,
        iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? 120_000,
        perIterationOutputCapBytes: config.tools?.perIterationOutputCapBytes ?? 100_000,
        tracer: undefined,
      });

      const agent = new Agent({
        container: this.deps.container,
        tools: baseRegistry,
        providers: this.deps.providerRegistry,
        events,
        pipelines: createDefaultPipelines(),
        context: ctx,
        // Subagents cannot answer interactive permission prompts — they
        // run under a director, not the user. Auto-approve everything
        // (except tool-level hard denies); the user already authorized
        // the work when they invoked the leader.
        permissionPolicy: new AutoApprovePermissionPolicy(),
        toolExecutor,
      });

      // Subagents inherit the same fallback chain as the leader (explicit
      // `fallbackModels` or the smart default). Without this a 429/529/5xx on a
      // subagent's model — after its own retries — fails the whole task instead
      // of rotating to a working model. Emits `provider.fallback` on the
      // subagent's own bus, mirroring its other provider.* events.
      agent.extensions.register(
        createFallbackModelExtension({
          getConfig: () => this.deps.configStore.get(),
          buildProvider: (id) => this.buildSubagentProvider(config, id, effModel),
          events,
        }),
      );

      // Close the per-subagent JSONL writer when the task ends. Without
      // this each completed task leaks one open file descriptor; over a
      // long fleet run (1000+ tasks) the process eventually hits the OS
      // limit. We only close writers we created via `sessionFactory` —
      // the fallback path forwards into the parent's session, which the
      // host owns and must not close here — the fallback shim's `close()`
      // is a no-op, so calling it unconditionally is safe in both cases.
      // Bridge per-subagent tool.executed to the host EventBus so the
      // TUI can update its compact live agent surfaces regardless of
      // director mode. The FleetBus path (director-only) covers the
      // richer FleetPanel stream; this bridge gives baseline visibility
      // for plain /spawn without forcing tool calls into chat history.
      // Capture the subagentId from the caller-supplied config — the
      // factory itself doesn't know the id until spawn() assigns one,
      // but director.spawn/coord.spawn both pass it back via subCfg.id
      // when in director mode; in legacy non-director mode the id is
      // discovered post-spawn, so we wire the bridge lazily with a
      // mutable holder and let the legacy emit path fill it.
      const hostEvents = this.deps.events;
      const offToolBridge = events.on('tool.executed', (e) => {
        // subCfg.id is populated by Director.spawn before this factory
        // is invoked, and by coord.spawn for the non-director path
        // (the runner re-uses the same config object). When it's
        // missing we still emit with a fallback so the bridge never
        // drops events — observability is more useful than perfect
        // attribution in that edge case.
        hostEvents.emit('subagent.tool_executed', {
          subagentId: subCfg.id ?? subCfg.name ?? 'subagent',
          name: e.name,
          durationMs: e.durationMs,
          ok: e.ok,
          input: e.input,
          outputBytes: e.outputBytes,
        });
      });

      const offSummaryBridge = events.on('subagent.iteration_summary', (e) => {
        hostEvents.emit('subagent.iteration_summary', {
          ...e,
          subagentId: subCfg.id ?? subCfg.name ?? 'subagent',
        });
      });

      const offCtxBridge = events.on('ctx.pct', (e) => {
        hostEvents.emit('subagent.ctx_pct', {
          subagentId: subCfg.id ?? subCfg.name ?? 'subagent',
          load: e.load,
          tokens: e.tokens,
          maxContext: e.maxContext,
        });
      });

      const dispose = async () => {
        offToolBridge();
        offSummaryBridge();
        offCtxBridge();
        try {
          await subSession.close?.();
        } catch {
          // see runner-side comment — cleanup must not mask the result
        }
      };

      return { agent, events, dispose };
    };
  }

  /**
   * Build the per-subagent runner.
   *
   * ACP agents (provider: 'acp') get their own runner via
   * makeACPSubagentRunner — they run external processes and don't go
   * through the Agent factory. Regular agents use the standard
   * makeAgentSubagentRunner path.
   */
  async buildSubagentRunner(config: Config): Promise<SubagentRunner> {
    // Detect which subagent type(s) will be spawned. If any ACP agent
    // is configured in the roster, we use a routing runner that branches
    // per spawn based on the subagent config's provider.
    return buildRoutingRunner(config, this);
  }

  async buildACPRunner(subagentId: string): Promise<SubagentRunner> {
    const cmd = ACP_AGENT_COMMANDS[subagentId];
    if (!cmd) throw new Error(`Unknown ACP agent: ${subagentId}`);
    return makeACPSubagentRunner(cmd);
  }

  /**
   * Build a Provider for a subagent. When `overrideId` is supplied (from
   * `SubagentConfig.provider`), looks that provider up in
   * `config.providers` and constructs it with its own apiKey/baseUrl.
   * Falls back to the leader's provider when `overrideId` is absent or
   * not configured (so a typo doesn't crash the whole run — we just
   * use the leader and the calling code can decide to error later).
   */
  private async buildSubagentProvider(
    config: Config,
    overrideId?: string | undefined,
    model?: string | undefined,
  ): Promise<Provider> {
    const requestedProviderId = overrideId ?? config.provider;
    const providerId =
      requestedProviderId === config.provider ||
      config.providers?.[requestedProviderId] !== undefined ||
      this.deps.providerRegistry.has(requestedProviderId)
        ? requestedProviderId
        : config.provider;
    const newCfg = config.providers?.[providerId] ?? {
      type: providerId,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    const cfgWithType = {
      ...newCfg,
      type: providerId,
    };
    const provider = this.deps.providerRegistry.has(providerId)
      ? this.deps.providerRegistry.create(cfgWithType)
      : makeProviderFromConfig(providerId, cfgWithType);
    // Overlay the runtime context window. Catalog model limits are accurate
    // for normal hosted providers, but custom baseUrl/proxy configs may route
    // the same model id to a smaller backend. Keep this aligned with the
    // leader's compaction denominator.
    if (this.deps.modelsRegistry) {
      const resolvedModel = model ?? config.model;
      const mc = await resolveRuntimeMaxContext({
        modelsRegistry: this.deps.modelsRegistry,
        config,
        provider,
        runtimeProviderConfig: cfgWithType,
        providerId,
        modelId: resolvedModel,
      });
      if (mc && mc > 0) provider.capabilities.maxContext = mc;
    }
    return provider;
  }

  async spawnACP(subagentId: string, task: string, config: Config): Promise<string> {
    const taskId = randomUUID();
    await this.ensureCoordinator(config);
    const coordinator = this.getCoordinator();

    const acpRunner = await this.buildACPRunner(subagentId);
    coordinator.setRunner(acpRunner);
    await coordinator.spawn({
      id: subagentId,
      name: subagentId,
      role: subagentId,
      provider: 'acp',
    });
    await coordinator.assign({
      id: taskId,
      description: task,
    });

    // Emit for TUI visibility - ACP agents use subagentId as their name
    // (e.g. "bug-hunter", "refactor-planner" - already meaningful names)
    this.deps.events.emit('subagent.spawned', {
      subagentId,
      taskId,
      name: subagentId,
      provider: 'acp',
      model: undefined,
      description: task,
    });

    return taskId;
  }

  /** Returns a tool slice for the subagent — full set unless restricted. */
  private filterTools(allow?: string[]): Tool[] {
    const all = this.deps.toolRegistry.list();
    if (!allow || allow.length === 0) return all;
    const allowSet = new Set(allow);
    return all.filter((t) => allowSet.has(t.name));
  }

  private subagentToolRegistry(allow?: string[]): ToolRegistry {
    if (!allow || allow.length === 0) return this.deps.toolRegistry;
    // Build a *filtered* registry containing only the allow-listed tools.
    // Start from an empty registry (not a clone of the full one — cloning
    // copies every tool, defeating the filter and throwing a duplicate
    // error when we re-register the allowed slice).
    const sub = new ToolRegistry();
    for (const t of this.filterTools(allow)) sub.register(t);
    return sub;
  }

  /**
   * Spawn a fresh subagent and assign a single task. Returns task id.
   *
   * Optional `opts` lets the caller (a `/spawn` slash command or the
   * future director surface) override the subagent's provider, model,
   * and tool slice on a per-spawn basis. Without options, the legacy
   * behavior holds: the subagent uses the leader's provider/model and
   * the full tool registry.
   */
  async spawn(
    description: string,
    opts?: {
      provider?: string | undefined;
      model?: string | undefined;
      tools?: string[] | undefined;
      name?: string | undefined;
    },
  ): Promise<{ subagentId: string; taskId: string }> {
    // Always build a Director (directorMode or not) so that spawn routes
    // through the same code path. The Director handles all orchestration.
    await this.buildDirector();
    const subagentConfig = {
      name: opts?.name ?? 'adhoc',
      role: 'general',
      provider: opts?.provider,
      model: opts?.model,
      tools: opts?.tools,
    };
    // In director mode we route through `Director.spawn` / `Director.assign`
    // so the director's manifest entries get populated. Calling the
    // underlying coordinator directly would still execute the task, but
    // the manifest would be empty — that surprised the first test.
    const { subagentId, taskId } = await this._spawnAndAssign(subagentConfig, description);
    // Track the pending task via FleetManager so status() can show descriptions
    // without host-side state duplication.
    this.fleetManager?.addPendingTask(taskId, subagentId, description);
    // NOTE: subagent.spawned is now emitted via FleetBus in Director.spawn()
    // and bridged to EventBus in buildDirector(). This ensures the correct
    // nickname (e.g. "Einstein (Bug Hunter)") is captured, not the placeholder.
    return { subagentId, taskId };
  }

  /**
   * Spawn a fresh subagent, assign a task, and **await** its completion.
   *
   * Unlike `spawn()`, which returns immediately with spawn metadata, this
   * method blocks until the subagent finishes (success, failure, or timeout)
   * and returns the full `TaskResult`. Use this when the caller needs the
   * subagent's actual output — e.g. `/techstack` displaying the generated report
   * in chat, or `/spawn` showing the result inline.
   *
   * Optional `opts` lets the caller override the subagent's provider, model,
   * and tool slice per spawn.
   */
  async spawnAndWait(
    description: string,
    opts?: {
      provider?: string | undefined;
      model?: string | undefined;
      tools?: string[] | undefined;
      name?: string | undefined;
    },
  ): Promise<TaskResult> {
    const { taskId } = await this.spawn(description, opts);
    if (!this.director) throw new Error('Director is not initialized');
    const results = await this.director.awaitTasks([taskId]);
    const result = results[0];
    if (!result) throw new Error(`Task ${taskId} completed but no result returned`);
    return result;
  }

  /**
   * Common spawn + assign logic shared by both director mode and raw
   * coordinator mode. Extracts the identical body from the two branches
   * in `spawn()` so future changes (e.g. adding a new field to both
   * paths) are made in one place.
   *
   * Returns `{ subagentId, taskId }`. Caller holds `pending` tracking
   * and event emission — the helper only talks to the coordinator.
   */
  private async _spawnAndAssign(
    subagentConfig: {
      name: string;
      role?: string | undefined;
      provider?: string | undefined;
      model?: string | undefined;
      tools?: string[] | undefined;
    },
    description: string = '',
  ): Promise<{ subagentId: string; taskId: string }> {
    const taskId = randomUUID();
    // Always goes through the Director — single code path after buildDirector()
    if (!this.director) throw new Error('Director is not initialized');
    const subagentId = await this.director.spawn(subagentConfig);
    await this.director.assign({ id: taskId, description, subagentId });
    return { subagentId, taskId };
  }

  /**
   * Relay a `task.completed` notification (from either the Director or
   * the raw coordinator) to the EventBus so non-director TUIs and any
   * other observer can react. We forward the full result shape rather
   * than mutating the existing `task.completed` schema — coordination
   * code already binds to that event, and adding subscribers there
   * would change ordering semantics for those listeners.
   */
  private emitLifecycleCompleted(taskId: string, result: TaskResult): void {
    this.deps.events.emit('subagent.task_completed', {
      subagentId: result.subagentId,
      taskId,
      status: result.status,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      durationMs: result.durationMs,
      error: result.error,
    });
  }

  status(): {
    pending: { taskId: string; description: string; subagentId: string }[];
    completed: TaskResult[];
    live: { subagentId: string; status: string; task?: string | undefined }[];
    summary: string;
  } {
    const activeSubagentIds = new Set<string>();
    const live: { subagentId: string; status: string; task?: string | undefined }[] = [];
    if (this.director) {
      const coord = this.getCoordinator();
      const s = coord.getStatus();
      for (const a of s.subagents) {
        if (a.status === 'running' || a.status === 'idle') {
          activeSubagentIds.add(a.id);
        }
        live.push({ subagentId: a.id, status: a.status, task: a.currentTask });
      }
    }
    // Pending tasks come from the host's FleetManager (passed to Director)
    const fleetStatus = this.fleetManager?.getFleetStatus() ?? { pending: [], live: [] };
    const pending = fleetStatus.pending.filter((p) => activeSubagentIds.has(p.subagentId));
    // Results always from Director (single source of truth)
    const completed = this.director ? this.director.completedResults() : [];
    const completedCount = completed.length;
    const liveCount = live.filter((s) => s.status === 'running' || s.status === 'idle').length;
    const summary = !this.director
      ? 'No subagents have been spawned.'
      : liveCount > 0
        ? `${pending.length} pending, ${liveCount} active, ${completedCount} completed.`
        : `${pending.length} pending, ${completedCount} completed.`;
    return { pending, completed, live, summary };
  }

  /**
   * Roll up per-subagent runtime cost from completed TaskResults. We don't
   * yet have FleetUsageAggregator wired into the simple MultiAgentHost
   * path (that lives on `Director`), so this aggregates iterations / tool
   * calls / duration which we *do* have — enough to spot a thrashing
   * worker without paying for a heavier orchestrator on every /spawn.
   *
   * Returns rows sorted by total duration descending (slowest first) so
   * the table renders the most interesting subagent at the top.
   */
  usage(): {
    rows: Array<{
      subagentId: string;
      tasks: number;
      iterations: number;
      toolCalls: number;
      durationMs: number;
      status: string;
    }>;
    totals: { tasks: number; iterations: number; toolCalls: number; durationMs: number };
  } {
    const completed = this.director ? this.director.completedResults() : [];
    const bySubagent = new Map<
      string,
      {
        tasks: number;
        iterations: number;
        toolCalls: number;
        durationMs: number;
        lastStatus: string;
      }
    >();
    for (const r of completed) {
      const cur = bySubagent.get(r.subagentId) ?? {
        tasks: 0,
        iterations: 0,
        toolCalls: 0,
        durationMs: 0,
        lastStatus: 'unknown',
      };
      cur.tasks += 1;
      cur.iterations += r.iterations;
      cur.toolCalls += r.toolCalls;
      cur.durationMs += r.durationMs;
      cur.lastStatus = r.status;
      bySubagent.set(r.subagentId, cur);
    }
    const rows = Array.from(bySubagent.entries())
      .map(([subagentId, v]) => ({
        subagentId,
        tasks: v.tasks,
        iterations: v.iterations,
        toolCalls: v.toolCalls,
        durationMs: v.durationMs,
        status: v.lastStatus,
      }))
      .sort((a, b) => b.durationMs - a.durationMs);
    const totals = rows.reduce(
      (acc, r) => ({
        tasks: acc.tasks + r.tasks,
        iterations: acc.iterations + r.iterations,
        toolCalls: acc.toolCalls + r.toolCalls,
        durationMs: acc.durationMs + r.durationMs,
      }),
      { tasks: 0, iterations: 0, toolCalls: 0, durationMs: 0 },
    );
    return { rows, totals };
  }

  /**
   * Force the director to write its manifest to disk and return the path,
   * or `null` when director mode is off (the simple coordinator path has
   * no manifest). Callers should fall back to a friendly user message
   * when `null` is returned — e.g. `/fleet manifest` does this already.
   *
   * The returned string is the absolute path of the manifest file. The
   * file contents are JSON; readers can `JSON.parse(fs.readFileSync(...))`
   * to consume.
   */
  async manifest(): Promise<string | null> {
    if (!this.director) return null;
    // Force a synchronous write — bypass the debounce timer so callers
    // (including tests) get an immediate snapshot without polling.
    // `writeManifest()` returns the absolute path on success, or null
    // when no manifest path is configured on the FleetManager.
    return (await this.director.fleetManager?.writeManifest()) ?? null;
  }

  /**
   * Promote a non-director session to director mode at runtime. Only
   * succeeds when no subagents have been spawned yet — once a coordinator
   * is running, the state cannot be migrated. Returns the live Director
   * so the caller can register orchestration tools into the ToolRegistry.
   *
   * Idempotent: calling promoteToDirector on an already-promoted host
   * returns the existing director without side effects.
   */
  async promoteToDirector(): Promise<Director | null> {
    if (this.director) return this.director;
    // With the single-path refactoring, spawn() always builds a Director.
    // So a "coordinator without director" state can no longer occur.
    this.opts.directorMode = true;
    // Derive fleet paths from fleetRoot when available.
    if (this.opts.fleetRoot && !this.opts.manifestPath) {
      this.opts.manifestPath = path.join(this.opts.fleetRoot, 'fleet.json');
    }
    if (this.opts.fleetRoot && !this.opts.sharedScratchpadPath) {
      this.opts.sharedScratchpadPath = path.join(this.opts.fleetRoot, 'shared');
    }
    if (this.opts.fleetRoot && !this.opts.sessionsRoot) {
      this.opts.sessionsRoot = path.join(this.opts.fleetRoot, 'subagents');
    }
    if (this.opts.fleetRoot && !this.opts.stateCheckpointPath) {
      this.opts.stateCheckpointPath = path.join(this.opts.fleetRoot, 'director-state.json');
    }
    await this.ensureDirector();
    return this.director ?? null;
  }

  /**
   * True when this host is running in director mode. Surfaces the mode
   * to slash commands and tests without exposing the underlying Director
   * (which would let callers bypass the host's coordination layer).
   */
  isDirectorMode(): boolean {
    return !!this.director;
  }

  /**
   * Why the most recent `promoteToDirector` call returned null. Cleared
   * implicitly on the next successful promotion. The delegate tool reads
   * this so the LLM sees the actual blocker (e.g. "3 running subagents,
   * wait or /fleet kill") instead of a generic "Director could not be
   * activated" message that gives no path forward.
   */
  getPromotionBlockReason(): string | null {
    return this.promotionBlockReason;
  }

  /**
   * Terminate a single subagent. Returns true when the subagent existed
   * (regardless of whether stop() succeeded or it was already idle),
   * false when no coordinator has been created yet — meaning the user
   * called /fleet kill before any /spawn, and there's nothing to do.
   */
  async kill(subagentId: string): Promise<boolean> {
    if (!this.director) return false;
    await this.getCoordinator().stop(subagentId);
    return true;
  }

  async stopAll(): Promise<void> {
    if (this.director) {
      await this.getCoordinator().stopAll();
    }
  }

  /**
   * Current effective concurrent-subagent ceiling. Reads the live
   * coordinator config when the director is built; otherwise falls back
   * to the constructor option (or the default of 4 that buildDirector
   * will apply on first /spawn).
   */
  getMaxConcurrent(): number {
    if (this.director) {
      return this.getCoordinator().config.maxConcurrent ?? 4;
    }
    return this.opts.maxConcurrent ?? 4;
  }

  /**
   * Change the concurrent-subagent ceiling at runtime. Updates the
   * constructor option (so lazy-built director picks it up) and, if the
   * coordinator already exists, mutates its live config + triggers a
   * dispatch pass so newly-allowed slots fill immediately.
   *
   * Throws on non-positive values; the caller is expected to validate
   * user input first.
   */
  setMaxConcurrent(n: number): void {
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`maxConcurrent must be a finite integer >= 1, got ${n}`);
    }
    const v = Math.floor(n);
    this.opts.maxConcurrent = v;
    if (this.director) {
      this.getCoordinator().setMaxConcurrent(v);
    }
  }
}
