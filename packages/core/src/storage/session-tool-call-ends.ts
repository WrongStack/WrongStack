import type { SessionData, SessionEvent } from '@wrongstack/contracts/types/session';

type ToolCallEnd = SessionData['toolCallEnds'][number];

export function extractToolCallEnds(events: readonly SessionEvent[]): ToolCallEnd[] {
  const out: ToolCallEnd[] = [];
  for (const event of events) {
    if (event.type !== 'tool_call_end') continue;
    out.push({
      name: event.name,
      id: event.id,
      durationMs: event.durationMs,
      ok: event.ok ?? true,
      outputBytes: event.outputBytes ?? event.outputSize,
      outputTokens: event.outputTokens,
      outputLines: event.outputLines,
    });
  }
  return out;
}
