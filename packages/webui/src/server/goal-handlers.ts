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

/**
 * Read `goal.json` for `projectRoot` and broadcast a `goal.updated` message.
 * The path must match /goal, the autonomy engines, and TUI F9, which all
 * resolve via `resolveWstackPaths().projectGoal`
 * (`~/.wrongstack/projects/<slug>/goal.json`) — NOT the repo-local
 * `.wrongstack/goal.json`.
 */
export async function handleGoalGet(
  projectRoot: string,
  broadcast: (msg: object) => void,
): Promise<void> {
  try {
    const goalPath = resolveWstackPaths({ projectRoot }).projectGoal;
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(goalPath, 'utf8');
    const goal = JSON.parse(raw);
    broadcast({ type: 'goal.updated', payload: goal });
  } catch {
    broadcast({ type: 'goal.updated', payload: null });
  }
}
