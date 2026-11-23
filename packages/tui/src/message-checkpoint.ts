import type { HistoryEntry } from './history-entry.js';

interface CheckpointLike {
  promptIndex: number;
  promptPreview: string;
}

/** Compare the start of two texts, whitespace-insensitively. */
function key(text: string): string {
  return text.replace(/…$/u, '').replace(/\s+/gu, ' ').trim().slice(0, 60);
}

function sameStart(a: string, b: string): boolean {
  const x = key(a);
  const y = key(b);
  if (!x || !y) return false;
  const n = Math.min(x.length, y.length);
  return x.slice(0, n) === y.slice(0, n);
}

/**
 * The position in `checkpoints` of the checkpoint the user message
 * `entryId` was sent under, or `undefined` when none can be told.
 *
 * Checkpoints carry only an 80-character preview of the prompt the agent
 * received, so messages and checkpoints are paired in order by the start of
 * their text. A message whose screen text differs from what was sent (a
 * pasted block shows as a placeholder) matches nothing; then, when every
 * message has a checkpoint, the n-th message is paired with the n-th.
 * Steering notes (`↯ …`) are folded into a running turn and have none.
 *
 * Pairing runs from the newest end. Both lists keep only their newest tail
 * (display-history and checkpoint retention have separate budgets), so their
 * oldest items need not correspond: walking from the start paired the first
 * message still on screen with the oldest retained checkpoint of the same text.
 */
export function checkpointForMessage(
  entries: readonly HistoryEntry[],
  checkpoints: readonly CheckpointLike[],
  entryId: number,
): number | undefined {
  const messages = entries.filter(
    (e): e is Extract<HistoryEntry, { kind: 'user' }> =>
      e.kind === 'user' && !e.queued && !e.text.startsWith('↯'),
  );
  const target = messages.findIndex((e) => e.id === entryId);
  if (target < 0) return undefined;

  let next = checkpoints.length - 1;
  for (let i = messages.length - 1; i >= target; i--) {
    const message = messages[i];
    if (!message) continue;
    let found = -1;
    for (let c = next; c >= 0; c--) {
      const checkpoint = checkpoints[c];
      if (checkpoint && sameStart(message.text, checkpoint.promptPreview)) {
        found = c;
        break;
      }
    }
    if (found >= 0) next = found - 1;
    if (i === target) {
      if (found >= 0) return found;
      break;
    }
  }
  // A transcript shown whole (no rewind or compaction since) has one
  // checkpoint per message.
  return messages.length === checkpoints.length ? target : undefined;
}
