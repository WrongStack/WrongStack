/**
 * Engine reports about a conversation that change what the user should know or do next, but
 * that do not belong to a message: why a run stopped early, a damaged journal, a failed
 * compaction, a model the provider substituted or a blocked provider.
 */
export interface ConversationNotice {
  id: string;
  severity: 'error' | 'warning' | 'info';
  text: string;
  hint: string;
  at: number;
}

/** Notices kept per conversation, newest last. */
export const NOTICE_LIMIT = 10;

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The notice an engine frame warrants, or null for frames that need none. */
export function conversationNotice(
  type: string,
  payload: Record<string, unknown>,
  id: string,
  at = Date.now(),
): ConversationNotice | null {
  const notice = (severity: ConversationNotice['severity'], text: string, hint = '') => ({
    id,
    severity,
    text,
    hint,
    at,
  });
  if (type === 'run.result' && payload['status'] === 'max_iterations') {
    const turns = num(payload['iterations']);
    return notice(
      'warning',
      `The run stopped at its iteration limit${turns === null ? '' : ` after ${turns} turns`}.`,
      'Send a message to continue from here. The limit is the tools.maxIterations setting.',
    );
  }
  if (type === 'tool.loop_detected' && payload['action'] !== 'steer') {
    const tools = str(payload['tools']);
    const repeats = num(payload['repeatCount']);
    return notice(
      'warning',
      `The engine ended the turn: ${tools ? `repeated ${tools} calls` : 'a repeating reply'}${repeats === null ? '' : ` (${repeats} repeats)`}.`,
      'Rephrase the request or give the missing information before continuing.',
    );
  }
  if (type === 'session.damaged')
    return notice(
      'error',
      `This conversation's journal is damaged${str(payload['detail']) ? `: ${str(payload['detail'])}` : '.'}`,
      'History & recovery shows what the journal still holds.',
    );
  if (type === 'compaction.failed')
    return notice(
      'warning',
      `Context compaction failed${str(payload['message']) ? `: ${str(payload['message'])}` : '.'}`,
      'The context was not reduced; Context & instructions shows its current size.',
    );
  if (type === 'provider.model_rerouted') {
    const served = str(payload['served']),
      requested = str(payload['requested']);
    if (!served || served === requested) return null;
    return notice(
      'info',
      `${str(payload['providerId']) || 'The provider'} answered with ${served} instead of ${requested || 'the requested model'}${str(payload['reason']) ? ` (${str(payload['reason'])})` : ''}.`,
    );
  }
  if (type === 'provider.active_blocked') {
    const fallback = [str(payload['fallbackProviderId']), str(payload['fallbackModel'])]
      .filter(Boolean)
      .join('/');
    return notice(
      'warning',
      `${[str(payload['providerId']), str(payload['model'])].filter(Boolean).join('/') || 'The provider'} is blocked${str(payload['lastError']) ? `: ${str(payload['lastError'])}` : ''}.`,
      fallback ? `The engine tries ${fallback} instead.` : '',
    );
  }
  return null;
}

/** Appends a notice, dropping an identical text that is already the newest, within the bound. */
export function appendNotice(notices: ConversationNotice[], notice: ConversationNotice) {
  if (notices.at(-1)?.text === notice.text) return notices;
  return [...notices, notice].slice(-NOTICE_LIMIT);
}
