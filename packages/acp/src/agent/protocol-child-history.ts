import type { ChildHistoryEntry, SessionState } from './protocol-contract.js';

const CHILD_LIMIT = 256;
const ID_LIMIT = 500;
const TEXT_LIMIT = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= ID_LIMIT;
}

export function readChildHistory(value: unknown, rootId: string): ChildHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, ChildHistoryEntry>();
  for (const item of value.slice(0, CHILD_LIMIT)) {
    if (!isRecord(item) || !validId(item.id) || item.id === rootId) continue;
    entries.set(item.id, {
      id: item.id,
      title: typeof item.title === 'string' ? item.title.slice(0, 300) : undefined,
      description:
        typeof item.description === 'string' ? item.description.slice(0, 1_000) : undefined,
      text: typeof item.text === 'string' ? item.text.slice(-TEXT_LIMIT) : undefined,
    });
  }
  return [...entries.values()];
}

/** Retain recent child text and labels; permissions, tools and state remain live-only. */
export function rememberChildUpdate(
  state: SessionState,
  update: unknown,
  childId?: string,
): boolean {
  if (!isRecord(update)) return false;
  if (childId === undefined && update.sessionUpdate === 'subagent_update') {
    const id = update.sessionId;
    if (!validId(id) || id === state.id) return false;
    state.childHistory ??= [];
    const children = state.childHistory;
    let child = children.find((entry) => entry.id === id);
    if (!child) {
      if (children.length >= CHILD_LIMIT) return false;
      child = { id };
      children.push(child);
    }
    if (typeof update.title === 'string') child.title = update.title.slice(0, 300);
    if (typeof update.description === 'string')
      child.description = update.description.slice(0, 1_000);
    return isRecord(update.state) && update.state.state === 'idle';
  }
  if (
    childId &&
    update.sessionUpdate === 'agent_message_chunk' &&
    isRecord(update.content) &&
    typeof update.content.text === 'string'
  ) {
    const child = state.childHistory?.find((entry) => entry.id === childId);
    if (child) child.text = ((child.text ?? '') + update.content.text).slice(-TEXT_LIMIT);
  }
  return false;
}
