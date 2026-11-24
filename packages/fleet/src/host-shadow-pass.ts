import type { Config, SubagentConfig } from '@wrongstack/contracts/types';
import { buildShadowAgentTaskDescription } from './host-helpers.js';

interface HostShadowPassContext {
  getDirector: () => { isWorkComplete(): boolean } | undefined;
  getLiveConfig: () => Config;
  getObservedWorkDepth: () => number;
  getQueuedProblem: () => string | null;
  setQueuedProblem: (value: string | null) => void;
  setPassInFlight: (value: boolean) => void;
  getHeartbeatIntervalMs: () => number;
  /**
   * Conversation this review belongs to. Stamped onto the spawn so the
   * coordinator files the reviewer under the tab whose work went wrong —
   * without it every tab's shadow agent landed in the boot tab's roster and
   * reported to the boot tab's leader.
   */
  sessionId?: string | undefined;
  spawnAndAssign: (
    subagentConfig: SubagentConfig,
    task: string,
    opts: {
      internalTask: true;
      stopShadowAfterTask: true;
      shadowIntervalMs: number;
    },
  ) => Promise<unknown>;
  requestShadowPass: (reason: string) => void;
}

function parseSideModelRef(
  ref: string | undefined,
): { provider: string; model: string } | undefined {
  if (!ref) return undefined;
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  const provider = ref.slice(0, slash).trim();
  const model = ref.slice(slash + 1).trim();
  if (!provider || !model || provider === 'acp') return undefined;
  return { provider, model };
}

export async function runHostShadowPass(ctx: HostShadowPassContext, reason: string): Promise<void> {
  try {
    const director = ctx.getDirector();
    if (!director) return;
    if (director.isWorkComplete()) return;
    if (ctx.getObservedWorkDepth() > 0) {
      const queued = ctx.getQueuedProblem();
      ctx.setQueuedProblem(queued ? `${queued}; ${reason}` : reason);
      return;
    }
    const liveConfig = ctx.getLiveConfig();
    // In ACP Leader mode, liveConfig.provider is 'acp' — routing the shadow
    // agent through ACP drops its shadow-agent.md prompt and native fleet tools.
    // Prefer acp.leader.sideModel (or fallbackBridge / fallbackModels[0]) so it runs natively.
    const sideModel =
      liveConfig.provider === 'acp'
        ? (parseSideModelRef(liveConfig.acp?.leader?.sideModel) ??
          parseSideModelRef(liveConfig.fallbackBridge) ??
          parseSideModelRef(liveConfig.fallbackModels?.[0]))
        : undefined;
    const shadowProvider = sideModel?.provider ?? liveConfig.provider;
    const shadowModel = sideModel?.model ?? liveConfig.model;
    try {
      await ctx.spawnAndAssign(
        {
          name: 'shadow',
          role: 'shadow-agent',
          ...(ctx.sessionId ? { originSessionId: ctx.sessionId } : {}),
          provider: shadowProvider,
          model: shadowModel,
          tools: ['fleet', 'mailbox', 'mail_inbox', 'mail_send', 'terminate_subagent'],
        },
        buildShadowAgentTaskDescription(reason),
        {
          internalTask: true,
          stopShadowAfterTask: true,
          shadowIntervalMs: ctx.getHeartbeatIntervalMs(),
        },
      );
    } catch (err) {
      if ((err as { name?: string } | null)?.name !== 'FleetSpawnBudgetError') {
        throw err;
      }
    }
  } finally {
    ctx.setPassInFlight(false);
    if (ctx.getObservedWorkDepth() === 0 && ctx.getQueuedProblem()) {
      const queued = ctx.getQueuedProblem()!;
      ctx.setQueuedProblem(null);
      ctx.requestShadowPass(queued);
    }
  }
}

export async function stopHostShadowAfterTask(
  stopSubagent: (subagentId: string) => Promise<void>,
  clearShadowAgent: (subagentId: string) => void,
  getObservedWorkDepth: () => number,
  getQueuedProblem: () => string | null,
  setQueuedProblem: (value: string | null) => void,
  requestShadowPass: (reason: string) => void,
  subagentId: string,
): Promise<void> {
  try {
    await stopSubagent(subagentId);
  } finally {
    clearShadowAgent(subagentId);
    if (getObservedWorkDepth() === 0 && getQueuedProblem()) {
      const queued = getQueuedProblem()!;
      setQueuedProblem(null);
      requestShadowPass(queued);
    }
  }
}
