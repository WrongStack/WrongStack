/** Mutable command-host state created after the runtime fleet is available. */

import type { BrainArbiter, Director } from '@wrongstack/core/coordination';
import { FLEET_ROSTER } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
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
import type { ReadlineInputReader } from '../input-reader.js';
import type { MultiAgentHost } from '../multi-agent.js';
import type { TerminalRenderer } from '../renderer.js';
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

export interface CommandHostStateInput {
  getConfig: () => Config;
  setConfig: (config: Config) => void;
  getDirector: () => Director | null;
  hqCommandController: HqCommandController;
  multiAgentHost: MultiAgentHost;
  events: EventBus;
  sessionRef: { current: SessionWriter | undefined };
  session: SessionWriter;
  paths: WstackPaths;
  projectRoot: string;
  brain: BrainArbiter | undefined;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  permissionPolicy: { setYolo?(enabled: boolean): void; getYolo?(): boolean };
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
  input.hqCommandController.killFleet = () => killFleet(input.getDirector());
  input.hqCommandController.terminateAgent = (subagentId) =>
    terminateAgent(input.getDirector(), subagentId);
  input.hqCommandController.spawnAgent = (role, task, maxIterations) =>
    spawnAgent(input.getDirector(), role, task, maxIterations);

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
    agentsMonitorController,
    onPanelOpen,
    goalHost,
    coordinatorController,
    setYoloMode,
    secretInputController,
    sddRunRegistry,
  };
}

async function killFleet(director: Director | null): Promise<number> {
  if (!director) return 0;
  let killed = 0;
  for (const subagent of director.status().subagents) {
    if (subagent.status === 'running' || subagent.status === 'idle') {
      try {
        await director.remove(subagent.id);
        killed++;
      } catch {
        // Best effort.
      }
    }
  }
  return killed;
}

async function terminateAgent(director: Director | null, subagentId: string): Promise<boolean> {
  if (!director) return false;
  try {
    await director.terminate(subagentId);
    return true;
  } catch {
    return false;
  }
}

async function spawnAgent(
  director: Director | null,
  role: string,
  task?: string,
  maxIterations?: number,
): Promise<string> {
  if (!director) {
    throw new AgentError({
      message: 'Director is not available.',
      code: 'AGENT_RUN_FAILED',
      context: { phase: 'hq-spawn', role },
    });
  }
  const base = FLEET_ROSTER[role] ?? {
    id: `manual-${Date.now()}`,
    name: role,
    maxIterations: maxIterations ?? 50,
    maxToolCalls: 200,
  };
  const config = task !== undefined ? { ...base, task } : base;
  return director.spawn(config);
}
