/** Mutable command-host state created after the runtime fleet is available. */

import {
  areSubagentsAllowedForSession,
  type BrainArbiter,
  type Director,
  mailboxSessionTag,
  makeKanbanQueueTool,
} from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import {
  ALL_DESTRUCTIVE_KINDS,
  type DestructiveKind,
  normalizeYoloConfirmKinds,
  resolveYoloConfirmKinds,
} from '@wrongstack/core/security';
import type {
  StatuslineDensities,
  StatuslineLines,
  StatuslineOrder,
} from '@wrongstack/core/statusline';
import {
  AgentError,
  type Config,
  resolveFleetChatVerbosity,
  type SessionWriter,
} from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { SddRunRegistry } from '@wrongstack/sdd';
import { createGoalHost } from '../goal-host.js';
import type { HqCommandController } from '../hq-command-controller.js';
import { killHqSessionFleet, spawnHqAgent, terminateHqAgent } from '../hq-fleet-control.js';
import type { ReadlineInputReader } from '../input-reader.js';
import type { MultiAgentHost } from '../multi-agent.js';
import type { TerminalRenderer } from '../renderer.js';
import {
  loadStatuslineDensities,
  loadStatuslineLines,
  loadStatuslineOrder,
  saveStatuslineLayout as persistStatuslineLayout,
} from '../services/statusline-config.js';
import { patchConfig } from '../utils.js';
import {
  createAgentsMonitorController,
  createEnhanceController,
  createFleetStreamController,
  createInterruptController,
  createStatuslineConfigDeps,
  loadStatuslineHiddenItems,
} from './controllers.js';
import type { BuiltinSlashCommandDeps } from './slash-commands.js';

type CoordinatorController = NonNullable<BuiltinSlashCommandDeps['coordinatorController']>;

interface CommandHostStateInput {
  getConfig: () => Config;
  setConfig: (config: Config) => void;
  getDirector: () => Director | null;
  hqCommandController: HqCommandController;
  /** Several conversations share the Director (WebUI host): see `HqFleetScope`. */
  hqMultiConversation?: boolean | undefined;
  multiAgentHost: MultiAgentHost;
  events: EventBus;
  sessionRef: { current: SessionWriter | undefined };
  session: SessionWriter;
  paths: WstackPaths;
  projectRoot: string;
  brain: BrainArbiter | undefined;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  permissionPolicy: {
    setYolo?(enabled: boolean): void;
    getYolo?(): boolean;
    setYoloConfirmKinds?(kinds: Iterable<DestructiveKind>): void;
    getYoloConfirmKinds?(): ReadonlySet<DestructiveKind>;
  };
  /**
   * The live conversation's meta bag.
   *
   * YOLO is decided per conversation — the permission policy reads
   * `ctx.meta.yolo` and falls back to its own process-wide flag — so a runtime
   * toggle has to write BOTH. Leaving the meta stale would let a boot-time
   * value keep overriding the switch the user just flipped.
   */
  contextMeta?: Record<string, unknown> | undefined;
}

export async function setupCommandHostState(input: CommandHostStateInput) {
  const fleetStreamController = createFleetStreamController(
    resolveFleetChatVerbosity(input.getConfig().autonomy),
  );
  const interruptController = createInterruptController();
  input.hqCommandController.interruptLeader = () => interruptController.abortLeader();
  // Addressing follows the LIVE session, not the boot one: a resume /
  // session.new swaps `ctx.session` for a new writer (see the session-writer
  // swap invariant), and a stale id would stamp HQ steers with a session no
  // leader is on any more — the receive-side affinity filter would then drop
  // every one of them.
  const liveSessionId = (): string => input.sessionRef.current?.id ?? input.session.id;
  input.hqCommandController.sessionId = liveSessionId;
  input.hqCommandController.sessionTag = () => mailboxSessionTag(liveSessionId());
  // Session-scoped: in the WebUI host a Stop aimed at one tab's fleet used to
  // sweep every tab's workers, because the named session was ignored.
  input.hqCommandController.killFleet = (sessionId) =>
    killHqSessionFleet(input.getDirector(), sessionId ?? liveSessionId(), {
      multiConversation: input.hqMultiConversation === true,
    });
  input.hqCommandController.terminateAgent = (subagentId) =>
    terminateHqAgent(input.getDirector(), subagentId);
  input.hqCommandController.spawnAgent = (role, task, maxIterations, sessionId) =>
    spawnHqAgent(input.getDirector(), sessionId ?? liveSessionId(), role, task, maxIterations);
  input.hqCommandController.kanbanDispatch = async (request) => {
    const director = input.getDirector();
    const sessionId = request.sessionId ?? liveSessionId();
    if (director === null) {
      throw new AgentError({
        message: 'No Director is active for Kanban dispatch.',
        code: 'AGENT_RUN_FAILED',
        context: { phase: 'hq-kanban-dispatch', taskId: request.taskId },
      });
    }
    if (!areSubagentsAllowedForSession(sessionId)) {
      throw new Error('Subagents are disabled for this session.');
    }
    const result = (await makeKanbanQueueTool(director).execute(
      {
        action: 'dispatch_ready',
        boardId: request.boardId,
        taskId: request.taskId,
        maxTasks: 1,
        awaitCompletion: false,
      },
      {
        projectRoot: input.projectRoot,
        eventSessionId: () => sessionId,
      } as never,
      { signal: new AbortController().signal },
    )) as {
      ok?: boolean;
      count?: number;
      message?: string;
      errors?: Array<{ error?: string }>;
      dispatched?: Array<{ subagentId?: string }>;
    };
    if (result.ok !== true || result.count !== 1) {
      throw new AgentError({
        message:
          result.errors?.[0]?.error ?? result.message ?? 'Kanban task could not be dispatched.',
        code: 'AGENT_RUN_FAILED',
        context: { phase: 'hq-kanban-dispatch', taskId: request.taskId },
      });
    }
    const subagentId = result.dispatched?.[0]?.subagentId;
    const summary = subagentId
      ? `task ${request.taskId} dispatched to ${subagentId}`
      : `task ${request.taskId} dispatched`;
    return `${summary} · ${request.comment}`;
  };

  const enhanceController = createEnhanceController(input.getConfig());
  const statuslineConfigDeps = createStatuslineConfigDeps();
  const hidden = await loadStatuslineHiddenItems();
  let currentHiddenItems = [...hidden.hiddenItems];
  const setStatuslineHiddenItems = (items: typeof currentHiddenItems) => {
    currentHiddenItems = items;
  };
  const saveStatuslineHiddenItems = async (items: typeof currentHiddenItems) => {
    currentHiddenItems = items;
    await hidden.saveHiddenItems(items);
  };
  // Per-chip line assignment (schema v2). The import is aliased so the
  // host-facing callback keeps the RunTuiOptions field name.
  const statuslineLines = await loadStatuslineLines();
  let currentLines: StatuslineLines = { ...statuslineLines };
  const setStatuslineLines = (next: StatuslineLines) => {
    currentLines = { ...next };
  };
  const saveStatuslineLines = async (next: StatuslineLines) => {
    currentLines = { ...next };
    await persistStatuslineLayout({ lines: next });
  };
  // Per-chip density pin (schema v3) — same shape as the line assignment.
  const statuslineDensities = await loadStatuslineDensities();
  let currentDensities: StatuslineDensities = { ...statuslineDensities };
  const setStatuslineDensities = (next: StatuslineDensities) => {
    currentDensities = { ...next };
  };
  const saveStatuslineDensities = async (next: StatuslineDensities) => {
    currentDensities = { ...next };
    await persistStatuslineLayout({ densities: next });
  };
  const statuslineOrder = await loadStatuslineOrder();
  let currentOrder: StatuslineOrder = [...statuslineOrder];
  const setStatuslineOrder = (next: StatuslineOrder) => {
    currentOrder = [...next];
  };
  const saveStatuslineOrder = async (next: StatuslineOrder) => {
    currentOrder = [...next];
    await persistStatuslineLayout({ order: next });
  };
  const agentsMonitorController = createAgentsMonitorController();
  const onPanelOpen: { current: ((action: string) => boolean) | null } = { current: null };
  const goalHost = createGoalHost({
    multiAgentHost: input.multiAgentHost,
    getConfig: input.getConfig,
    events: input.events,
    getSessionId: () => input.sessionRef.current?.id ?? input.session.id,
    storeDir: input.paths.projectAutophase,
    projectRoot: input.projectRoot,
    brain: input.brain,
    log: (line) => input.renderer.write(`${line}\n`),
  });
  const coordinatorController: CoordinatorController = {};
  const setYoloMode = (enabled?: boolean): boolean => {
    if (enabled !== undefined) {
      input.permissionPolicy.setYolo?.(enabled);
      if (input.contextMeta) input.contextMeta['yolo'] = enabled;
      input.setConfig(patchConfig(input.getConfig(), { yolo: enabled }));
      return enabled;
    }
    return input.permissionPolicy.getYolo?.() ?? input.getConfig().yolo ?? false;
  };
  /**
   * Read, or set, which kinds of damage still prompt while YOLO is on.
   *
   * Mirrors `setYoloMode`: the live policy and the persisted config move
   * together, so the choice survives a restart and takes effect on the very
   * next tool call rather than at the next boot.
   *
   * Returns the EFFECTIVE map — the locked kinds report `true` no matter what
   * was requested, so a caller that tries to turn one off can see that it did
   * not take rather than believing it did.
   */
  const setYoloConfirm = (update?: {
    kind: DestructiveKind;
    confirm: boolean;
  }): Record<DestructiveKind, boolean> => {
    if (update) {
      const current = resolveYoloConfirmKinds(input.getConfig().autonomy?.yoloConfirm);
      const next = new Set(current);
      if (update.confirm) next.add(update.kind);
      else next.delete(update.kind);
      const normalized = normalizeYoloConfirmKinds(next);
      input.permissionPolicy.setYoloConfirmKinds?.(normalized);
      const config = input.getConfig();
      input.setConfig(
        patchConfig(config, {
          autonomy: {
            ...config.autonomy,
            yoloConfirm: Object.fromEntries(
              ALL_DESTRUCTIVE_KINDS.map((kind) => [kind, normalized.has(kind)]),
            ),
          },
        }),
      );
    }
    const effective =
      input.permissionPolicy.getYoloConfirmKinds?.() ??
      resolveYoloConfirmKinds(input.getConfig().autonomy?.yoloConfirm);
    return Object.fromEntries(
      ALL_DESTRUCTIVE_KINDS.map((kind) => [kind, effective.has(kind)]),
    ) as Record<DestructiveKind, boolean>;
  };
  const secretInputController = {
    readSecret: (prompt: string) => input.reader.readSecret(prompt),
    readText: (prompt: string) => input.reader.readLine(prompt),
  };
  const sddRunRegistry = new SddRunRegistry();
  void import('@wrongstack/sdd')
    .then((sdd) =>
      sdd.cleanupStaleSddWorktrees({
        projectRoot: input.projectRoot,
        boardsDir: input.paths.projectSddBoards,
        stateTransport: 'kanban',
      }),
    )
    .catch(() => undefined);

  return {
    fleetStreamController,
    interruptController,
    enhanceController,
    statuslineConfigDeps,
    statuslineHiddenItems: hidden.hiddenItems,
    getCurrentHiddenItems: () => currentHiddenItems,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    statuslineLines: { ...statuslineLines },
    getCurrentStatuslineLines: () => currentLines,
    setStatuslineLines,
    saveStatuslineLines,
    statuslineDensities: { ...statuslineDensities },
    getCurrentStatuslineDensities: () => currentDensities,
    setStatuslineDensities,
    saveStatuslineDensities,
    statuslineOrder: [...statuslineOrder],
    getCurrentStatuslineOrder: () => currentOrder,
    setStatuslineOrder,
    saveStatuslineOrder,
    agentsMonitorController,
    onPanelOpen,
    goalHost,
    coordinatorController,
    setYoloMode,
    setYoloConfirm,
    secretInputController,
    sddRunRegistry,
  };
}
