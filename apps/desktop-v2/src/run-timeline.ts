import { contentText, record } from './engine-values.js';

/** An engine frame as the reducer sees it (structurally `EngineEvent`). */
type EngineEvent = { type: string; payload: Record<string, unknown> };

/** Frames that make up a run's visible work: tool calls, thinking, retries and iterations. */
export function isRunTimelineEvent(type: string): boolean {
  return (
    type === 'tool.started' ||
    type === 'tool.executed' ||
    type === 'tool.progress' ||
    type === 'provider.thinking_delta' ||
    type === 'provider.retry' ||
    type === 'iteration.started' ||
    type === 'iteration.completed'
  );
}
/** Frames kept for one run; streaming frames are merged, so this is a bound, not a cap in use. */
export const RUN_TIMELINE_LIMIT = 3000;
const MERGED_TEXT_LIMIT = 16000;

const tail = (text: string) =>
  text.length > MERGED_TEXT_LIMIT ? text.slice(text.length - MERGED_TEXT_LIMIT) : text;
const agentOf = (event: EngineEvent) => String(event.payload['agentId'] ?? '');

function textProgress(event: EngineEvent): string | null {
  if (event.type !== 'tool.progress') return null;
  const progress = record(event.payload['event']);
  if (progress['path'] !== undefined || progress['data'] !== undefined) return null;
  const text = contentText(progress['text']);
  return text ? text : null;
}

/**
 * Appends one engine frame to a run's timeline. A frame that only extends the previous one
 * (more thinking text, more text output of the same tool) is merged into it, so a long run
 * keeps every tool call instead of losing the early ones to streamed deltas.
 */
export function appendRunEvent(
  timeline: readonly EngineEvent[],
  event: EngineEvent,
): EngineEvent[] {
  const last = timeline.at(-1);
  if (
    last &&
    event.type === 'provider.thinking_delta' &&
    last.type === 'provider.thinking_delta' &&
    agentOf(last) === agentOf(event)
  ) {
    const text = tail(contentText(last.payload['text']) + contentText(event.payload['text']));
    return [...timeline.slice(0, -1), { type: last.type, payload: { ...last.payload, text } }];
  }
  const added = textProgress(event);
  const previous = last ? textProgress(last) : null;
  if (
    last &&
    added !== null &&
    previous !== null &&
    last.payload['id'] === event.payload['id'] &&
    agentOf(last) === agentOf(event)
  ) {
    const merged = {
      ...record(last.payload['event']),
      text: tail(previous.endsWith('\n') ? previous + added : `${previous}\n${added}`),
    };
    return [
      ...timeline.slice(0, -1),
      { type: last.type, payload: { ...last.payload, event: merged } },
    ];
  }
  const next = [...timeline, event];
  return next.length > RUN_TIMELINE_LIMIT ? next.slice(next.length - RUN_TIMELINE_LIMIT) : next;
}
