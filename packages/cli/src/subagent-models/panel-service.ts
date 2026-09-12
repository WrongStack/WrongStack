/**
 * Host bridge for the TUI `/subagent-models` panel.
 *
 * The panel is presentational; the session-scoped plan lives in core and is
 * journaled through the session writer, which only the CLI has. Mutations
 * return an error STRING rather than throwing so a rejected write lands as a
 * panel hint instead of unmounting the TUI.
 */
import {
  emptySubagentModelPlan,
  formatSubagentSlot,
  getSessionSubagentModelPlan,
  type SessionSubagentModelPlan,
  type SubagentSlot,
  setSessionSubagentModelPlan,
  subagentSlotOccupancy,
} from '@wrongstack/core/coordination';
import type {
  SubagentLaneTarget,
  SubagentModelsPanelHost,
  SubagentModelsSnapshot,
} from '@wrongstack/tui';

/** The slice of the agent context the plan writer needs. */
type PlanWriteContext = Parameters<typeof setSessionSubagentModelPlan>[0];

export interface SubagentModelsPanelServiceDeps {
  /** The session's own provider/model — the target of "use session model". */
  getSessionTarget?: (() => { provider?: string; model?: string }) | undefined;
  /**
   * Live agent context — re-read on every call so a session swap (F1/F10,
   * /resume) is picked up. Typed off the core writer contract rather than the
   * full AgentContext so this bridge only depends on what it actually uses.
   */
  getContext: () => PlanWriteContext | undefined;
}

function currentPlan(sessionId: string | undefined): SessionSubagentModelPlan {
  return getSessionSubagentModelPlan(sessionId) ?? emptySubagentModelPlan();
}

export function createSubagentModelsPanelHost(
  deps: SubagentModelsPanelServiceDeps,
): SubagentModelsPanelHost {
  const write = async (
    mutate: (plan: SessionSubagentModelPlan) => void,
  ): Promise<string | null> => {
    const ctx = deps.getContext();
    if (!ctx?.session) return 'No active session — the plan cannot be saved.';
    const plan = structuredClone(currentPlan(ctx.session.id));
    mutate(plan);
    try {
      await setSessionSubagentModelPlan(ctx, plan);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  return {
    snapshot(): SubagentModelsSnapshot {
      const sessionId = deps.getContext()?.session?.id;
      const plan = currentPlan(sessionId);
      const occupancy = subagentSlotOccupancy(sessionId);
      const session = deps.getSessionTarget?.();
      return {
        enabled: plan.enabled,
        lock: plan.lock,
        followSessionModel: plan.followSessionModel === true,
        sessionTarget: session?.provider
          ? `${session.provider}/${session.model ?? '?'}`
          : (session?.model ?? ''),
        lanes: plan.slots.map((slot, i) => ({
          target: formatSubagentSlot(slot),
          busy: occupancy[i]?.subagentIds.length ?? 0,
          ...(slot.label ? { label: slot.label } : {}),
        })),
        roles: Object.entries(plan.roles ?? {})
          .map(([role, slot]) => ({ role, target: formatSubagentSlot(slot) }))
          .sort((a, b) => a.role.localeCompare(b.role)),
      };
    },

    setLane(index: number, target: SubagentLaneTarget): Promise<string | null> {
      return write((plan) => {
        if (index < 0 || index >= plan.slots.length) return;
        const slot: SubagentSlot = {};
        if (target.provider) slot.provider = target.provider;
        if (target.model) slot.model = target.model;
        if (target.tier) slot.tier = target.tier;
        if (target.fallbackProfile) slot.fallbackProfile = target.fallbackProfile;
        if (target.label) slot.label = target.label;
        plan.slots[index] = slot;
      });
    },

    clearLane(index: number): Promise<string | null> {
      return write((plan) => {
        if (index < 0 || index >= plan.slots.length) return;
        plan.slots[index] = {};
      });
    },

    toggle(field: 'lock' | 'enabled' | 'followSessionModel'): Promise<string | null> {
      return write((plan) => {
        plan[field] = plan[field] !== true;
      });
    },
  };
}
