import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import {
  Agent,
  Context,
  createDefaultPipelines,
  createFallbackModelExtension,
  renderInstructionLayer,
} from '@wrongstack/core/agent';
import {
  applyProjectAgentConfig,
  buildProjectContextualizedPrompt,
  loadProjectAgentConfig,
} from '@wrongstack/core/agent-catalog';
import {
  type AgentFactory,
  DEFAULT_SUBAGENT_BASELINE,
  type DirectorSessionFactory,
  FLEET_ROSTER,
  getSharedProjectMailbox,
  type MailboxAgentStatus,
  resolveSubagentModelTarget,
} from '@wrongstack/core/coordination';
import { installDesignStudioMiddleware } from '@wrongstack/core/design';
import {
  applyModelRuntime,
  installSubagentAutoCompaction,
  mergeModelRuntime,
  ToolExecutor,
} from '@wrongstack/core/execution';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { EventBus } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { AutoApprovePermissionPolicy } from '@wrongstack/core/security';
import type {
  Config,
  Provider,
  Request,
  SessionWriter,
  SubagentConfig,
  TaskSpec,
  TextBlock,
  Tool,
} from '@wrongstack/core/types';
import { resolveHostSubagentSkillResolution, retrieveHostSubagentMemory } from './host-context.js';
import { installSubagentEventBridge } from './host-event-bridge.js';
import {
  isAgentAvailable,
  isInsideDirectory,
  resolveSubagentCapabilities,
} from './host-helpers.js';
import {
  buildHostSubagentProvider,
  resolveHostSubagentModelSelection,
  resolveHostSubagentReasoningConfig,
} from './host-provider.js';
import {
  createParentSubagentSessionWriter,
  withParentFileSnapshots,
} from './host-session-writer.js';
import type { MultiAgentDeps, MultiAgentHostOptions } from './host-types.js';

export interface HostSubagentFactoryContext {
  deps: MultiAgentDeps;
  opts: MultiAgentHostOptions;
  roster: Record<string, SubagentConfig>;
  sessionFactory?: DirectorSessionFactory | undefined;
  filterTools: (allow?: string[]) => Tool[];
  mailboxProjectDir: () => string;
  recordLearningRole: (subagentId: string, role: string, skills?: readonly string[]) => void;
  subagentToolRegistry: (allow?: string[]) => ToolRegistry;
}

export function createHostSubagentFactory(
  config: Config,
  host: HostSubagentFactoryContext,
): AgentFactory {
  return async (subCfg: SubagentConfig, task?: TaskSpec) => {
    const events = new EventBus();
    const liveConfig = host.deps.configStore.get();
    const mergedConfig = { ...liveConfig, ...config };
    const projectRoot = host.deps.projectRoot;
    const projectCfg = subCfg.role ? loadProjectAgentConfig(subCfg.role, projectRoot) : undefined;
    const isSystemRole = Boolean(subCfg.role && Object.hasOwn(FLEET_ROSTER, subCfg.role));
    const effectiveCfg: SubagentConfig = projectCfg
      ? applyProjectAgentConfig(subCfg, projectCfg, {
          protectSystemRole: isSystemRole,
        })
      : subCfg;
    const matrixTarget = effectiveCfg.model
      ? undefined
      : resolveSubagentModelTarget(liveConfig, effectiveCfg.role, {
          // Thread the shared tracker so the resolved matrix target skips
          // (provider, model) pairs currently in the waiting room. Without
          // this, the subagent factory would seed its own primary from a
          // doomed model the leader just 429-stricken, and the fallback
          // extension would have to spend a turn rotating away.
          ...(host.opts.statusTracker ? { statusTracker: host.opts.statusTracker } : {}),
        });
    const modelSelection = resolveHostSubagentModelSelection(
      liveConfig,
      effectiveCfg,
      matrixTarget,
    );
    let effProvider = modelSelection.effProvider;
    let effModel = modelSelection.effModel;
    let provider: Provider | undefined;
    let providerError: unknown;
    const seenStartupTargets = new Set<string>();
    for (const target of modelSelection.startupTargets) {
      const key = `${target.provider}/${target.model}`;
      if (seenStartupTargets.has(key)) continue;
      seenStartupTargets.add(key);
      try {
        provider = await buildHostSubagentProvider(
          host.deps,
          mergedConfig,
          target.provider,
          target.model,
        );
        effProvider = target.provider;
        effModel = target.model;
        break;
      } catch (err) {
        providerError = err;
      }
    }
    if (!provider) throw providerError ?? new Error('No permitted provider/model could be built.');
    let subReasoningConfig = await resolveHostSubagentReasoningConfig(
      host.deps,
      effProvider,
      effModel,
    );

    let availabilityNotice: string | undefined;
    if (effectiveCfg.availability) {
      const status = isAgentAvailable(effectiveCfg.availability);
      if (!status.allowed) {
        const message = `Agent "${effectiveCfg.role ?? effectiveCfg.name}" is outside its working hours (${status.localTime}; ${effectiveCfg.availability.start}-${effectiveCfg.availability.end}).`;
        if (effectiveCfg.availability.mode === 'enforce') throw new Error(message);
        availabilityNotice = `${message} This protected system role may continue, but should minimize non-urgent work.`;
      }
    }

    const assignedCheckout =
      subCfg.cwd && path.isAbsolute(subCfg.cwd) ? subCfg.cwd : host.deps.projectRoot;
    let subCwd = projectCfg?.cwd
      ? path.resolve(assignedCheckout, projectCfg.cwd)
      : (effectiveCfg.cwd ?? host.deps.cwd);
    if (projectCfg?.cwd && !isInsideDirectory(assignedCheckout, subCwd)) {
      throw new Error(
        `Agent "${effectiveCfg.role ?? effectiveCfg.name}" cwd escapes its assigned checkout.`,
      );
    }
    if (
      projectCfg?.cwd &&
      (!existsSync(subCwd) || !statSync(subCwd, { throwIfNoEntry: false })?.isDirectory())
    ) {
      const message = `Agent "${effectiveCfg.role ?? effectiveCfg.name}" working directory does not exist: ${subCwd}.`;
      if (!isSystemRole) throw new Error(message);
      subCwd = assignedCheckout;
      availabilityNotice = availabilityNotice
        ? `${availabilityNotice}\n${message} Falling back to the assigned checkout.`
        : `${message} Falling back to the assigned checkout.`;
    }

    let onlineAgents: MailboxAgentStatus[] = [];
    try {
      const subagentMailbox = getSharedProjectMailbox(host.mailboxProjectDir());
      onlineAgents = await subagentMailbox.getAgentStatuses();
    } catch {
      // Non-fatal: mailbox errors should not block subagent creation.
    }

    const subagentTools = host.filterTools(effectiveCfg.tools);
    const baseSystem: TextBlock[] = await host.deps.systemPromptBuilder.build({
      cwd: subCwd,
      projectRoot: host.deps.projectRoot,
      tools: subagentTools,
      catalogTools: subagentTools,
      model: effModel,
      provider: effProvider,
      subagent: true,
      onlineAgents,
    });

    baseSystem.unshift({
      type: 'text',
      text: renderInstructionLayer(DEFAULT_SUBAGENT_BASELINE, {
        toolNames: new Set(subagentTools.map((tool) => tool.name)),
        tier: 'off',
        subagent: true,
        strictToolReferences: true,
      }),
    });
    if (availabilityNotice) baseSystem.push({ type: 'text', text: availabilityNotice });

    const audienceMemory = await retrieveHostSubagentMemory(
      host.deps,
      host.opts.getLeaderMode,
      effectiveCfg,
      task?.context,
    );
    if (audienceMemory.length > 0) {
      baseSystem.push({
        type: 'text',
        text: `Project memory for this agent role:\n${audienceMemory.map((text) => `- ${text}`).join('\n')}`,
      });
    }

    const skillResolution = await resolveHostSubagentSkillResolution(
      host.deps,
      host.roster,
      effectiveCfg,
      subagentTools.map((tool) => tool.name),
    );
    if (skillResolution.content) {
      for (let index = baseSystem.length - 1; index >= 0; index--) {
        if (baseSystem[index]?.text.includes('# Active Skills')) baseSystem.splice(index, 1);
      }
      baseSystem.push({ type: 'text', text: skillResolution.content });
    }
    const droppedSkills = Object.entries(skillResolution.dropped);
    if (droppedSkills.length > 0 || skillResolution.trimmed.length > 0) {
      // A skill that silently fails to load leaves the agent believing it has
      // guidance it never received. Surface it on the event bus so the drop is
      // observable instead of a bare console.warn nobody reads.
      host.deps.events.emit('subagent.skills.dropped', {
        sessionId: host.deps.session.id,
        role: effectiveCfg.role,
        selected: skillResolution.selected,
        dropped: Object.fromEntries(droppedSkills),
        ...(skillResolution.trimmed.length > 0 ? { trimmed: skillResolution.trimmed } : {}),
      });
    }

    const rawRolePrompt =
      effectiveCfg.systemPromptOverride ??
      effectiveCfg.prompt ??
      (effectiveCfg.role ? host.roster[effectiveCfg.role]?.prompt : undefined);
    const rolePrompt =
      rawRolePrompt && effectiveCfg.role
        ? buildProjectContextualizedPrompt(rawRolePrompt, effectiveCfg.role, projectRoot, {
            identityOverride: effectiveCfg.projectIdentity?.identityOverride,
          })
        : rawRolePrompt;
    if (rolePrompt) {
      baseSystem.push({ type: 'text', text: rolePrompt });
    }

    const subagentName = effectiveCfg.id ?? effectiveCfg.name ?? `sub_${randomUUID().slice(0, 8)}`;
    if (effectiveCfg.role) {
      host.recordLearningRole(subagentName, effectiveCfg.role, skillResolution.selected);
    }
    let subSession: SessionWriter;
    if (host.sessionFactory) {
      // File mutations are mirrored onto the parent because the rewinder only
      // ever reads the session being rewound — a subagent's own JSONL is not
      // in that path, so without this its edits survive a `/rewind` silently.
      subSession = withParentFileSnapshots(
        await host.sessionFactory.createSubagentSession({
          subagentId: subagentName,
          provider: effProvider,
          model: effModel,
          title: `subagent: ${subagentName}`,
        }),
        host.deps.session,
      );
    } else {
      subSession = createParentSubagentSessionWriter(host.deps.session);
    }

    const tools = effectiveCfg.tools ? [...effectiveCfg.tools] : undefined;
    const subTokenCounter = new DefaultTokenCounter({
      registry: host.deps.modelsRegistry,
      providerId: effProvider,
      events,
      sessionId: () => host.deps.session.id,
    });

    const ctx = new Context({
      systemPrompt: baseSystem,
      provider,
      session: subSession,
      signal: new AbortController().signal,
      tokenCounter: subTokenCounter,
      cwd: subCwd,
      projectRoot: host.deps.projectRoot,
      allowOutsideProjectRoot:
        config.features?.allowOutsideProjectRoot ?? !(config.tools?.restrictToProjectRoot ?? false),
      model: effModel,
      tools: subagentTools,
      catalogTools: subagentTools,
      agentId: subagentName,
      agentName: effectiveCfg.name ?? subagentName,
    });
    if (effectiveCfg.role) ctx.meta['agentRole'] = effectiveCfg.role;
    const normalizedAgentName = (effectiveCfg.name ?? subagentName).trim().toLowerCase();
    if (normalizedAgentName === 'chimera' || normalizedAgentName.startsWith('chimera-')) {
      ctx.meta['mailboxSendPolicy'] = 'leaders-only';
    }
    const leaderMode = host.opts.getLeaderMode?.();
    if (leaderMode) ctx.meta['mode'] = leaderMode;
    if (effectiveCfg.spawnLineage) ctx.meta['spawnLineage'] = effectiveCfg.spawnLineage;

    const baseRegistry = host.subagentToolRegistry(tools);
    const subAllowedCaps = resolveSubagentCapabilities(effectiveCfg, (allow) =>
      host.filterTools([...allow]),
    );
    const toolExecutor = new ToolExecutor(baseRegistry, {
      permissionPolicy: new AutoApprovePermissionPolicy(subAllowedCaps),
      secretScrubber: host.deps.secretScrubber,
      renderer: host.deps.renderer,
      events,
      confirmAwaiter: undefined,
      iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? 120_000,
      maxToolTimeoutMs: config.tools?.maxToolTimeoutMs ?? 300_000,
      perIterationOutputCapBytes: config.tools?.perIterationOutputCapBytes ?? 100_000,
      tracer: undefined,
      // Kanban tracks work; it does not gate it. Off unless the operator opts
      // in — and then subagents inherit it, because a worker dispatched by
      // `kanban_queue` already carries board/task/lease identity in ctx.meta
      // and can satisfy the same gate its leader was held to.
      requireKanbanGovernance: config.tools?.kanbanGovernance ?? false,
      // WrongTrace lock gate — worker edits honor peer locks exactly like
      // the leader's. Undefined until deps wire it (see host-types.ts);
      // absent runner = pre-gate behavior, never an error.
      ...(host.deps.hookRunner ? { hookRunner: host.deps.hookRunner } : {}),
    });

    const subagentConfigStore = host.deps.configStore;
    const pipelines = createDefaultPipelines();
    pipelines.request.use({
      name: 'ModelRuntimeSettings',
      async handler(req: Request) {
        return applyModelRuntime(req, {
          getSettings: () =>
            mergeModelRuntime(
              subagentConfigStore.get().modelRuntime,
              modelSelection.runtimeOverride,
            ),
          getReasoningConfig: () => subReasoningConfig,
          getCapabilities: () => ctx.provider.capabilities,
        });
      },
    });

    installDesignStudioMiddleware({ pipelines, ctx });
    installSubagentAutoCompaction(pipelines, ctx, config.context, events);
    host.deps.installToolBoundary?.(pipelines);

    const agent = new Agent({
      container: host.deps.container,
      tools: baseRegistry,
      providers: host.deps.providerRegistry,
      events,
      pipelines,
      context: ctx,
      permissionPolicy: new AutoApprovePermissionPolicy(subAllowedCaps),
      toolExecutor,
      loopDetection: config.tools?.loopDetection,
    });

    agent.extensions.register(
      createFallbackModelExtension({
        getConfig: () => host.deps.configStore.get() as Config,
        fallbackProfileManager: host.deps.fallbackProfileManager,
        getFallbackModels: () => effectiveCfg.fallbackModels,
        getFallbackProfile: () => modelSelection.fallbackProfile,
        getPrimaryTarget: () => ({ providerId: effProvider, model: effModel }),
        isClosedWorld: () => modelSelection.closedModelPolicy,
        buildProvider: (id, model) =>
          buildHostSubagentProvider(host.deps, mergedConfig, id, model ?? effModel),
        onModelSwitch: async (id, model) => {
          subReasoningConfig = await resolveHostSubagentReasoningConfig(host.deps, id, model);
        },
        events,
        // Thread the leader's shared ProviderModelStatusTracker so the
        // subagent's fallback extension quarantines a (provider, model) pair
        // on the first 429 (rate-limit) failure instead of silently
        // reassigning the same doomed model on every concurrent spawn.
        // Without this dep, deps.statusTracker in fallback-model.ts is
        // undefined and every recordFailure / isAvailable call is a no-op,
        // so the waiting-room transition never fires along the subagent
        // dispatch path. The tracker is the same singleton the leader uses,
        // populated by brain-and-orchestration.ts into host.opts.statusTracker.
        ...(host.opts.statusTracker ? { statusTracker: host.opts.statusTracker } : {}),
        // `fallbackStickiness` is read live from `getConfig()` inside the
        // extension — forwarding it here would pin the spawn-time value.
      }),
    );

    const disposeBridge = installSubagentEventBridge({
      events,
      hostEvents: host.deps.events,
      hostSessionId: host.deps.session.id,
      projectRoot: ctx.projectRoot,
      effectiveCfg,
      subCfg,
    });

    const dispose = async () => {
      disposeBridge();
      // Drain agent-lifetime hooks registered during construction (mailbox
      // heartbeat interval, awareness polling, HQ publisher connection,
      // auto-compaction timer). Without this, every retired subagent leaks
      // its setInterval handles + event subscriptions + HQ socket + auto-
      // compact timer for the rest of the leader process's lifetime — a
      // long-running kanban-dispatch loop with N subagents accumulates 4N
      // live timers and N open HQ sockets. See
      // packages/core/src/core/agent.ts#teardown (drainAgentHooks).
      try {
        await agent.teardown();
      } catch {
        // Cleanup must not mask the task result.
      }
      try {
        await subSession.close?.();
      } catch {
        // Cleanup must not mask the task result.
      }
    };

    return { agent, events, dispose };
  };
}
