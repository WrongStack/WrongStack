/**
 * Goal-state WebSocket handler for the WebUI server, extracted from the
 * `handleMessage` switch in `index.ts` as part of splitting that file (#31).
 *
 *   case 'goal.get': return handleGoalGet(projectRoot, (m) => broadcast(clients, m));
 *
 * Reads the canonical goal.json and broadcasts it to every connected client so
 * all browser tabs share one goal snapshot. Never throws — a missing or
 * unparseable file broadcasts `null` so clients clear stale goal state.
 */

import { resolveWstackPaths } from '@wrongstack/core/utils';
import {
  loadGoal,
  type RefinedMission,
  refineGoalHeuristic,
  replaceGoalMission,
  updateGoal,
} from '@wrongstack/goal';

/**
 * Read `goal.json` for `projectRoot` and broadcast a `goal-state.updated` message.
 * The path must match /goal, the autonomy engines, and TUI F9, which all
 * resolve via `resolveWstackPaths().projectGoal`
 * (`~/.wrongstack/projects/<slug>/goal.json`) — NOT the repo-local
 * `.wrongstack/goal.json`.
 */
export async function handleGoalGet(
  projectRoot: string,
  broadcast: (msg: { type: string; payload: unknown }) => void,
): Promise<void> {
  try {
    const goalPath = resolveWstackPaths({ projectRoot }).projectGoal;
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(goalPath, 'utf8');
    const goal = JSON.parse(raw);
    broadcast({ type: 'goal-state.updated', payload: goal });
  } catch {
    broadcast({ type: 'goal-state.updated', payload: null });
  }
}

/** The mission a window reviewed: its id, or `setAt` for older missions; '' when there was none. */
function missionKey(
  mission: { missionId?: string | undefined; setAt?: string | undefined } | null | undefined,
): string {
  return mission?.missionId || mission?.setAt || '';
}

const MISSION_CHANGED =
  'The mission changed since it was read. Review the current mission before changing it.';

export async function handleGoalStateMutation(
  projectRoot: string,
  type:
    | 'goal-state.set'
    | 'goal-state.refine'
    | 'goal-state.pause'
    | 'goal-state.resume'
    | 'goal-state.clear',
  payload: Record<string, unknown> | undefined,
  broadcast: (msg: { type: string; payload: unknown }) => void,
  refine?: (goal: string) => Promise<RefinedMission | null>,
): Promise<void> {
  const goalPath = resolveWstackPaths({ projectRoot }).projectGoal;
  // Optional: the mission the request was reviewed against, compared inside the locked update.
  const expected =
    typeof payload?.expectedMission === 'string' ? payload.expectedMission : undefined;
  let stale = false;
  const reviewed = (current: Parameters<typeof missionKey>[0]) => {
    if (expected === undefined || missionKey(current) === expected) return true;
    stale = true;
    return false;
  };
  const refuseStale = () =>
    broadcast({ type: 'goal-state.error', payload: { message: MISSION_CHANGED } });
  if (type === 'goal-state.set') {
    const goal = typeof payload?.goal === 'string' ? payload.goal.trim() : '';
    if (!goal) {
      broadcast({
        type: 'goal-state.error',
        payload: { message: 'Goal mission must not be empty.' },
      });
      return;
    }
    const refined = refineGoalHeuristic(goal);
    let missionId = '';
    await updateGoal(goalPath, (current) => {
      if (!reviewed(current)) return current;
      const next = replaceGoalMission(current, goal, refined);
      missionId = next.missionId ?? '';
      return next;
    });
    if (stale) refuseStale();
    await handleGoalGet(projectRoot, broadcast);
    if (stale || !refine) return;
    await refineCurrentMission(projectRoot, goalPath, goal, missionId, broadcast, refine);
    return;
  } else if (type === 'goal-state.refine') {
    const current = await loadGoal(goalPath);
    if (!current) {
      broadcast({
        type: 'goal-state.error',
        payload: { message: 'No persistent mission to refine.' },
      });
      return;
    }
    if (!refine) {
      broadcast({ type: 'goal-state.error', payload: { message: 'Goal refiner is unavailable.' } });
      return;
    }
    await refineCurrentMission(
      projectRoot,
      goalPath,
      current.goal,
      current.missionId ?? '',
      broadcast,
      refine,
      current.setAt,
    );
    return;
  } else if (type === 'goal-state.clear') {
    await updateGoal(goalPath, (current) => (reviewed(current) ? null : current));
    if (stale) refuseStale();
  } else {
    let changed = false;
    await updateGoal(goalPath, (current) => {
      if (!reviewed(current)) return current;
      if (!current) return null;
      const nextState = type === 'goal-state.pause' ? 'paused' : 'active';
      if (current.goalState === nextState) return current;
      changed = true;
      return { ...current, goalState: nextState, lastActivityAt: new Date().toISOString() };
    });
    if (stale) refuseStale();
    else if (!changed) {
      broadcast({
        type: 'goal-state.error',
        payload: { message: 'No matching persistent mission state change was available.' },
      });
    }
  }
  await handleGoalGet(projectRoot, broadcast);
}

async function refineCurrentMission(
  projectRoot: string,
  goalPath: string,
  goal: string,
  missionId: string,
  broadcast: (msg: { type: string; payload: unknown }) => void,
  refine: (goal: string) => Promise<RefinedMission | null>,
  legacySetAt?: string,
): Promise<void> {
  const refinementKey = missionId || legacySetAt || '';
  broadcast({ type: 'goal-state.refining', payload: { missionId: refinementKey, active: true } });
  let refined: RefinedMission | null;
  try {
    refined = await refine(goal);
  } catch {
    refined = null;
  }
  let applied = false;
  if (refined) {
    await updateGoal(goalPath, (current) => {
      if (
        !current ||
        current.goal !== goal ||
        (missionId
          ? current.missionId !== missionId
          : Boolean(current.missionId) || current.setAt !== legacySetAt)
      ) {
        return current;
      }
      applied = true;
      return { ...current, refinedGoal: refined.refinedGoal, deliverables: refined.deliverables };
    });
  }
  broadcast({ type: 'goal-state.refining', payload: { missionId: refinementKey, active: false } });
  if (applied) {
    await handleGoalGet(projectRoot, broadcast);
  } else if (!refined) {
    const current = await loadGoal(goalPath);
    if (
      !current ||
      current.goal !== goal ||
      (missionId
        ? current.missionId !== missionId
        : Boolean(current.missionId) || current.setAt !== legacySetAt)
    ) {
      return;
    }
    broadcast({
      type: 'goal-state.error',
      payload: { message: 'Goal refinement unavailable; the current mission was preserved.' },
    });
  }
}
