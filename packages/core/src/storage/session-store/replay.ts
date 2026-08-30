import type { Message } from '../../types/messages.js';
import type { SessionEvent } from '../../types/session.js';

export function isReplayableMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Message>;
  return (
    (candidate.role === 'user' || candidate.role === 'assistant' || candidate.role === 'system') &&
    (typeof candidate.content === 'string' || Array.isArray(candidate.content))
  );
}

export function trackMessageToolState(message: Message, openToolUses: Set<string>): void {
  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (block.type === 'tool_use') openToolUses.add(block.id);
    else if (block.type === 'tool_result') openToolUses.delete(block.tool_use_id);
  }
}

export function replayableMessage(value: unknown, fallbackTs?: string): Message | null {
  if (!isReplayableMessage(value)) return null;
  const { _estTokens: _ignored, ...message } = value;
  return message.ts === undefined && fallbackTs ? { ...message, ts: fallbackTs } : message;
}

export function applyContextSnapshot(
  target: Message[],
  openToolUses: Set<string>,
  snapshot: unknown,
): boolean {
  if (!Array.isArray(snapshot) || !snapshot.every(isReplayableMessage)) return false;
  target.length = 0;
  openToolUses.clear();
  for (const raw of snapshot) {
    const message = replayableMessage(raw);
    if (!message) return false;
    target.push(message);
    trackMessageToolState(message, openToolUses);
  }
  return true;
}

export function inheritsIntoFork(event: SessionEvent): boolean {
  switch (event.type) {
    case 'session_start':
    case 'session_resumed':
    case 'session_forked':
    case 'session_end':
    case 'in_flight_start':
    case 'in_flight_end':
    case 'rewound':
    case 'agent_spawned':
    case 'agent_session_linked':
    case 'agent_stopped':
    case 'agent_error':
    case 'delegate_started':
    case 'delegate_completed':
      return false;
    // Parent snapshots describe mutations owned by the parent journal. A
    // child that shares the current workspace must not inherit authority to
    // rewind those historical side effects.
    case 'file_snapshot':
      return false;
    default:
      return true;
  }
}
