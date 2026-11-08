/**
 * HQ's fleet commands (`abort fleet`, `abort <agent>`) against a Director.
 *
 * Shared by the CLI host's own HQ connection and the embedded WebUI's per-tab
 * presence, so both apply the same scoping rule.
 *
 * @module hq-fleet-control
 */

import { AgentError } from '@wrongstack/contracts/types';
import {
  areSubagentsAllowedForSession,
  type Director,
  FLEET_ROSTER,
} from '@wrongstack/coordination';

export interface HqFleetScope {
  /**
   * `true` when several conversations share this Director (the WebUI host,
   * one per tab). Then `abort fleet` may only ever reach the named session's
   * workers — stopping another tab's fleet is worse than stopping nothing.
   *
   * A single-conversation host (TUI, REPL, one-shot) keeps the process-wide
   * sweep as its fallback: after an in-place `/resume` the leader's older
   * workers still carry the boot session as their origin, so a strictly
   * scoped sweep would find none and silently leave them running.
   */
  multiConversation: boolean;
}

/** Stop the named session's workers; returns how many were stopped. */
export async function killHqSessionFleet(
  director: Director | null,
  sessionId: string | undefined,
  scope: HqFleetScope,
): Promise<number> {
  if (!director) return 0;
  const owned = sessionId ? director.subagentIdsForSession(sessionId) : [];
  if (owned.length > 0 && sessionId) {
    await director.terminateSession(sessionId);
    return owned.length;
  }
  if (scope.multiConversation) return 0;
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

/** Terminate one subagent by id. Ids are process-unique, so no session check. */
export async function terminateHqAgent(
  director: Director | null,
  subagentId: string,
): Promise<boolean> {
  if (!director) return false;
  try {
    await director.terminate(subagentId);
    return true;
  } catch {
    return false;
  }
}

/** Spawn a roster (or ad-hoc) subagent owned by `sessionId`. */
export async function spawnHqAgent(
  director: Director | null,
  sessionId: string,
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
  if (!areSubagentsAllowedForSession(sessionId)) {
    throw new Error('Subagents are disabled for this session.');
  }
  // Forward the caller's maxIterations override onto the base config when
  // present, so a known roster role can still be capped tighter than its
  // FLEET_ROSTER_BUDGETS default. applyRosterBudget
  // (packages/core/src/coordination/fleet.ts:325) honors a non-undefined
  // cfg.maxIterations via `cfg.maxIterations ?? defaultBudget.maxIterations`,
  // but it can only see the override if spawnHqAgent forwards it here.
  // No `maxIterations` on the ad-hoc base: the budget takes the raw value
  // first, so the old `maxIterations ?? 0` gave every non-roster role (project
  // agents included) a limit of 0 — stopped after its first iteration. Absent,
  // it falls through to the generic subagent budget like a CLI delegate.
  const base = FLEET_ROSTER[role] ?? {
    id: `manual-${Date.now()}`,
    name: role,
    maxToolCalls: 200,
  };
  const overrides = maxIterations !== undefined ? { maxIterations } : {};
  const config = task !== undefined ? { ...base, ...overrides, task } : { ...base, ...overrides };
  return director.spawn({ ...config, originSessionId: sessionId });
}

/** The three HQ fleet hooks, bound to a Director that may appear later. */
export interface HqFleetControl {
  killFleet(sessionId?: string): Promise<number>;
  terminateAgent(subagentId: string): Promise<boolean>;
  spawnAgent(
    role: string,
    task?: string,
    maxIterations?: number,
    sessionId?: string,
  ): Promise<string>;
}

export function createHqFleetControl(
  getDirector: () => Director | null,
  defaultSessionId: () => string,
  scope: HqFleetScope,
): HqFleetControl {
  return {
    killFleet: (sessionId) =>
      killHqSessionFleet(getDirector(), sessionId ?? defaultSessionId(), scope),
    terminateAgent: (subagentId) => terminateHqAgent(getDirector(), subagentId),
    spawnAgent: (role, task, maxIterations, sessionId) =>
      spawnHqAgent(getDirector(), sessionId ?? defaultSessionId(), role, task, maxIterations),
  };
}
