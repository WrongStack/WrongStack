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

/**
 * Never end a stored slice on half of a surrogate pair: a lone unit goes out in
 * the ACP JSON-RPC frame as a `\udXXX` escape and strict client parsers reject
 * the whole frame (`server-agent-commands.ts` walks back for the same reason).
 */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** Same rule for a tail slice: never START on the low half of a pair. */
function clipTail(value: string, max: number): string {
  if (value.length <= max) return value;
  let start = value.length - max;
  const first = value.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return value.slice(start);
}

export function readChildHistory(value: unknown, rootId: string): ChildHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, ChildHistoryEntry>();
  for (const item of value.slice(0, CHILD_LIMIT)) {
    if (!isRecord(item) || !validId(item.id) || item.id === rootId) continue;
    entries.set(item.id, {
      id: item.id,
      title: typeof item.title === 'string' ? clip(item.title, 300) : undefined,
      description: typeof item.description === 'string' ? clip(item.description, 1_000) : undefined,
      text: typeof item.text === 'string' ? clipTail(item.text, TEXT_LIMIT) : undefined,
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
    if (typeof update.title === 'string') child.title = clip(update.title, 300);
    if (typeof update.description === 'string') child.description = clip(update.description, 1_000);
    return isRecord(update.state) && update.state.state === 'idle';
  }
  if (
    childId &&
    update.sessionUpdate === 'agent_message_chunk' &&
    isRecord(update.content) &&
    typeof update.content.text === 'string'
  ) {
    const child = state.childHistory?.find((entry) => entry.id === childId);
    if (child) child.text = clipTail((child.text ?? '') + update.content.text, TEXT_LIMIT);
  }
  return false;
}
