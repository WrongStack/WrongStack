import { randomUUID } from 'node:crypto';
import { TOKENS } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import {
  AutoApprovePermissionPolicy,
  subagentYoloPlus,
  ToolCapabilities,
} from '@wrongstack/core/security';
import { isRestrictedMode } from '../boot/restricted-mode.js';
import { publishAcpLiveProgress } from './acp-live-progress.js';
import { wrongstackAcpPermissionPolicy } from './acp-permission-bridge.js';
import { recordAcpRateLimit } from './acp-quota-reading.js';
import type { BuildAcpSubagentRunnerOptions } from './host-acp.js';

export interface HostAcpRunnerHost {
  deps: import('./host-types.js').MultiAgentDeps;
  getDirector: () => import('@wrongstack/core/coordination').Director | undefined;
  ensureCoordinator: (_config: import('@wrongstack/contracts/types').Config) => Promise<void>;
  getCoordinator: () => import('@wrongstack/core/coordination').DefaultMultiAgentCoordinator;
  buildACPRunner: (
    subagentId: string,
  ) => Promise<import('@wrongstack/contracts/types').SubagentRunner>;
  recordLearningRole: (subagentId: string, role: string, skills?: readonly string[]) => void;
  directorRunnerSet: boolean;
  sessionForSubagent: (subagentId: string) => string;
}

export function acpCommandOpts(this: HostAcpRunnerHost): BuildAcpSubagentRunnerOptions {
  let acp: Config['acp'];
  try {
    acp = this.deps.configStore.get()?.acp;
  } catch {
    acp = undefined;
  }
  const overrides = acp?.agents;
  return {
    ...(overrides ? { overrides } : {}),
    projectRoot: this.deps.projectRoot,
    bridge: { projectRoot: this.deps.projectRoot, config: acp?.bridge },
    // The worker answers to the same rules as WrongStack's own subagents:
    // the user's deny rules, the destructive and credential guards, YOLO+.
    // Every capability is granted; the guards, not an allowlist, gate it.
    permissions: (ctx) => {
      const leaderPolicy = this.deps.container.safeResolve(TOKENS.PermissionPolicy);
      const policy = new AutoApprovePermissionPolicy(Object.values(ToolCapabilities), {
        yoloPlus: () =>
          subagentYoloPlus({
            sessionId: ctx.sessionId,
            leaderPolicy,
            fallback: () => this.deps.configStore.get().autonomy?.yoloPlus === true,
          }),
      });
      return wrongstackAcpPermissionPolicy({
        evaluate: (tool, input, scope) => policy.evaluate(tool, input, scope),
        getTool: (name) => this.deps.toolRegistry.get(name),
        projectRoot: this.deps.projectRoot,
        allowMcp: !isRestrictedMode({}),
        onRefused: (call, reason) =>
          this.deps.container
            .safeResolve(TOKENS.Logger)
            ?.info(`acp worker ${ctx.subagentId}: refused ${call.tool} — ${reason}`),
      });
    },
    wrongforgeGateway: async () => {
      const { sharedWrongForgeGateway } = await import('./wrongforge-gateway.js');
      const logger = this.deps.container.safeResolve(TOKENS.Logger);
      return sharedWrongForgeGateway({
        projectRoot: this.deps.projectRoot,
        registry: this.deps.toolRegistry,
        config: this.deps.configStore.get(),
        yoloPlus: () => this.deps.configStore.get().autonomy?.yoloPlus === true,
        log: (message) => logger?.debug(`wrongforge gateway: ${message}`),
      });
    },
    publishLive: (ctx, task, event) => {
      if (event.type === 'rate_limit') {
        // Keyed by agent (claude-code), like the delegation that names it.
        recordAcpRateLimit(ctx.config.role ?? ctx.config.name ?? ctx.subagentId, event.info);
        return;
      }
      publishAcpLiveProgress({
        event,
        subagentId: ctx.subagentId,
        agentName: ctx.config.name ?? ctx.config.role ?? ctx.subagentId,
        sessionId: ctx.sessionId,
        taskId: task.id,
        fleet: this.getDirector()?.fleet,
        hostEvents: this.deps.events,
      });
    },
  };
}

export async function spawnACP(
  this: HostAcpRunnerHost,
  subagentId: string,
  task: string,
  config: Config,
): Promise<string> {
  const taskId = randomUUID();
  await this.ensureCoordinator(config);
  const coordinator = this.getCoordinator();

  const acpRunner = await this.buildACPRunner(subagentId);
  this.recordLearningRole(subagentId, subagentId);
  coordinator.setRunner(acpRunner);
  this.directorRunnerSet = true;
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

  this.deps.events.emit('subagent.spawned', {
    // Whatever the coordinator recorded at spawn — `spawnACP` has no caller
    // context to name an origin, so this is the host session today, but the
    // announcement must not disagree with the roster the worker lands in.
    sessionId: this.sessionForSubagent(subagentId),
    subagentId,
    taskId,
    name: subagentId,
    provider: 'acp',
    model: undefined,
    description: task,
  });

  return taskId;
}
