import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import type { CollaborationBus } from '@wrongstack/coordination';
import type { Agent } from '@wrongstack/core/agent';
import type { AgentServices, AgentServicesInput } from './backend-services-types.js';
import { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import { createGoalUsagePricer } from './goal-usage-pricer.js';
import { GoalWebSocketHandler } from './goal-ws-handler.js';
import { createKanbanRunMirror } from './kanban-run-mirror.js';
import { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import { buildSddWizardDeps } from './sdd-wizard-wiring.js';
import { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import { SpecsWebSocketHandler } from './specs-ws-handler.js';
import { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import { WorktreeWebSocketHandler } from './worktree-ws-handler.js';

export function createBackendRealtimeHandlers(opts: {
  input: AgentServicesInput;
  agent: Agent;
  brain: AgentServices['brain'];
  collabBus: CollaborationBus;
  secretScrubber: SecretScrubber;
  subagentFactory: AgentServices['subagentFactory'];
  onDisposeExtra: () => void;
}) {
  const { input, agent, brain, collabBus, secretScrubber, subagentFactory } = opts;
  const { context, events, logger, projectRoot, workingDir, wpaths } = input;

  const broadcastToClients = input.broadcastToClients;
  const kanbanRunMirror =
    projectRoot && broadcastToClients
      ? createKanbanRunMirror({
          projectRoot,
          events,
          broadcast: broadcastToClients,
          log: (message) => logger.debug(`[KanbanRunMirror] ${message}`),
        })
      : null;

  const goalHandler = new GoalWebSocketHandler(
    agent,
    context,
    logger,
    wpaths.projectAutophase,
    events,
    projectRoot,
    kanbanRunMirror ? (graphId, state) => kanbanRunMirror.onGoalState(graphId, state) : undefined,
    subagentFactory,
    undefined,
    createGoalUsagePricer(input),
  );
  const specsHandler = new SpecsWebSocketHandler(wpaths.projectSpecs, wpaths.projectTaskGraphs);
  const sddBoardHandler = new SddBoardWebSocketHandler(
    wpaths.projectSddBoards,
    undefined,
    {
      projectRoot,
      paths: {
        projectSpecs: wpaths.projectSpecs,
        projectTaskGraphs: wpaths.projectTaskGraphs,
        projectSddSession: wpaths.projectSddSession,
        projectSddBoards: wpaths.projectSddBoards,
      },
    },
    { trustBoundary: input.trustBoundary, logger },
  );
  const sddWizardHandler = new SddWizardWebSocketHandler(
    buildSddWizardDeps({
      agent,
      events,
      projectRoot,
      brain,
      subagentFactory,
      paths: {
        projectSpecs: wpaths.projectSpecs,
        projectTaskGraphs: wpaths.projectTaskGraphs,
        projectSddBoards: wpaths.projectSddBoards,
        projectDir: wpaths.projectDir,
        projectSddSession: wpaths.projectSddSession,
      },
    }),
  );
  const worktreeHandler = new WorktreeWebSocketHandler(events, logger, {
    projectRoot,
    boardsDir: wpaths.projectSddBoards,
  });
  const terminalHandler = new TerminalWebSocketHandler(
    () => workingDir,
    logger,
    undefined,
    undefined,
    input.trustBoundary,
  );
  const collabHandler = new CollaborationWebSocketHandler(
    events,
    logger,
    input.sessionReader,
    input.annotationsStore,
    collabBus,
    {
      getActiveSessionId: () => context.session.id,
      scrubPayload: (value) => secretScrubber.scrubObject(value),
    },
  );

  let disposed = false;
  const disposeRealtimeHandlers = () => {
    if (disposed) return;
    disposed = true;
    goalHandler.dispose();
    kanbanRunMirror?.dispose();
    sddBoardHandler.dispose();
    sddWizardHandler.dispose();
    specsHandler.dispose();
    worktreeHandler.dispose();
    terminalHandler.dispose();
    collabHandler.dispose();
    opts.onDisposeExtra();
  };

  return {
    goalHandler,
    kanbanRunMirror,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    terminalHandler,
    collabHandler,
    disposeRealtimeHandlers,
  };
}
