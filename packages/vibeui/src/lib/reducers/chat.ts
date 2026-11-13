import { type ChatProjection, isFinalTurnStopReason } from '@wrongstack/webui-protocol';
import { endsRun } from '../agent-state';
import { bounded, contentText } from '../session-coercion';
import { type ChatEntry, MAX_MESSAGES, type SessionState } from '../session-state';

/**
 * Live entry ids use a monotonic counter so 500-message / 200-tool caps never
 * repeat React keys or match stale assistant ids.
 */
let liveEntrySequence = 0;
export const liveEntryId = (type: string): string => `${type}-${++liveEntrySequence}`;

/** Index of the newest entry that is not a BTW note sent during the run. */
export function conversationTail(messages: ChatEntry[]): number {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.delivery === 'btw') index--;
  return index;
}

function appendDelta(
  messages: ChatEntry[],
  role: ChatEntry['role'],
  delta: string,
  id: string,
): ChatEntry[] {
  const index = conversationTail(messages);
  const last = messages[index];
  if (last?.role === role && last.streaming)
    return [
      ...messages.slice(0, index),
      { ...last, text: bounded(last.text + delta) },
      ...messages.slice(index + 1),
    ];
  return [
    ...messages.map((entry) => ({ ...entry, streaming: false })),
    { id, role, text: bounded(delta), streaming: true },
  ].slice(-MAX_MESSAGES);
}

/** Settles the streaming answer with the canonical text, or appends a non-streamed one. */
function reduceResponse(
  state: SessionState,
  chat: Extract<ChatProjection, { kind: 'response' }>,
  id: string,
): SessionState {
  const response = bounded(contentText(chat.content));
  const final = isFinalTurnStopReason(chat.stopReason);
  const lastIndex = conversationTail(state.messages);
  const last = state.messages[lastIndex];
  const finalized = state.messages.map((entry) =>
    entry.streaming ? { ...entry, streaming: false } : entry,
  );
  if (last?.role === 'assistant' && last.streaming)
    return {
      ...state,
      messages: [
        ...finalized.slice(0, lastIndex),
        { ...last, text: response || last.text, streaming: false, final },
        ...finalized.slice(lastIndex + 1),
      ],
    };
  return {
    ...state,
    messages: response
      ? ([...finalized, { id, role: 'assistant', text: response, streaming: false, final }].slice(
          -MAX_MESSAGES,
        ) as ChatEntry[])
      : finalized,
  };
}

function runFailure(chat: Extract<ChatProjection, { kind: 'run-result' | 'error' }>): string {
  if (chat.kind === 'error') return chat.message;
  if (chat.status === 'done') return '';
  return chat.status === 'aborted'
    ? 'Run stopped. Queued messages are paused.'
    : 'Run did not complete. Review the result before continuing.';
}

function runOutcome(
  state: SessionState,
  chat: Extract<ChatProjection, { kind: 'run-result' | 'error' }>,
): SessionState['runOutcome'] {
  if (chat.kind === 'run-result')
    return chat.status === 'done' ? 'done' : chat.status === 'aborted' ? 'aborted' : 'error';
  return state.running ? 'error' : state.runOutcome;
}

/**
 * The run boundary: a run.result, or an error whose phase ends the run. Stops
 * streaming, settles the final answer (marking a completed one auto-eligible),
 * and interrupts tools that were still running.
 */
function reduceRunEnd(
  state: SessionState,
  chat: Extract<ChatProjection, { kind: 'run-result' | 'error' }>,
  id: string,
): SessionState {
  const failure = runFailure(chat);
  const tailIndex = conversationTail(state.messages);
  const prevTail = state.messages[tailIndex];
  const messages = state.messages.map((m, idx) =>
    chat.kind === 'run-result' && idx === tailIndex && m.role === 'assistant' && m.streaming
      ? {
          ...m,
          ...(chat.finalText ? { text: bounded(chat.finalText) } : {}),
          streaming: false,
          final: chat.status === 'done',
        }
      : { ...m, streaming: false },
  );
  if (chat.kind === 'error')
    messages.push({ id, role: 'system', text: chat.message, streaming: false });
  if (
    chat.kind === 'run-result' &&
    chat.finalText &&
    (prevTail?.role !== 'assistant' ||
      (!prevTail.streaming &&
        prevTail.final === false &&
        prevTail.text !== bounded(chat.finalText)))
  )
    messages.push({
      id,
      role: 'assistant',
      text: bounded(chat.finalText),
      streaming: false,
      final: chat.status === 'done',
    });
  if (chat.kind === 'run-result' && chat.status === 'done') {
    const tail = messages[conversationTail(messages)];
    if (tail?.role === 'assistant' && tail.final === true) tail.autoEligible = true;
  }
  return {
    ...state,
    running: false,
    runOutcome: runOutcome(state, chat),
    messages: messages.slice(-MAX_MESSAGES),
    tools: state.tools.map((t) => (t.status === 'running' ? { ...t, status: 'interrupted' } : t)),
    notice: failure || state.notice,
    runFailure: failure,
  };
}

/**
 * Streaming deltas, responses and run boundaries. Returns undefined for chat
 * frames it does not own (an `error` outside a run phase falls through).
 */
export function reduceChat(
  state: SessionState,
  chat: ChatProjection | null,
  phase: unknown,
  id: string,
): SessionState | undefined {
  if (chat?.kind === 'text-delta' || chat?.kind === 'thinking-delta')
    return {
      ...state,
      running: true,
      runOutcome: null,
      messages: appendDelta(
        state.messages,
        chat.kind === 'text-delta' ? 'assistant' : 'thinking',
        chat.text,
        id,
      ),
    };
  if (chat?.kind === 'response') return reduceResponse(state, chat, id);
  if (chat?.kind === 'run-result' || (chat?.kind === 'error' && endsRun(phase)))
    return reduceRunEnd(state, chat, id);
  return undefined;
}
