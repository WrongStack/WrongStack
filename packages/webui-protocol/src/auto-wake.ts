/**
 * Background-delegation auto-wake, as the chat surfaces show it.
 *
 * When a background `delegate` result arrives while a leader is idle, the host
 * starts a leader turn whose input is a runtime prompt beginning with
 * {@link AUTO_WAKE_PROMPT_MARKER}. That input is persisted like any other
 * turn input, so a replayed transcript would render it as a user bubble — a
 * message the user never typed. Both WebUI clients route replayed user text
 * through {@link autoWakeNoticeText} and show a runtime marker instead.
 *
 * The marker mirrors core's `AUTO_WAKE_MARKER` (coordination/delegation); it
 * is duplicated here only because this package must stay browser-safe and
 * core's coordination barrel is not. A parity test pins the two together.
 */

export const AUTO_WAKE_PROMPT_MARKER = '[AUTO-WAKE]';

/** True when `text` is a runtime auto-wake prompt, not something a user typed. */
export function isAutoWakePrompt(text: string): boolean {
  return text.trimStart().startsWith(AUTO_WAKE_PROMPT_MARKER);
}

/**
 * The runtime line shown before a woken turn. `notices` are runtime notices
 * the model asked for (`timer:w1#2`, `watch:pw1#3`, `process:4242#exit`).
 */
export function formatAutoWakeNotice(
  delegationIds: readonly string[],
  chain?: number,
  notices: readonly string[] = [],
): string {
  const chainNote =
    typeof chain === 'number' && chain > 0 ? ` — woken turn ${chain} without your input` : '';
  const n = delegationIds.length;
  const ids = n > 0 ? ` (${delegationIds.join(', ')})` : '';
  const results = n === 1 ? 'a background delegation result' : 'background delegation results';
  const tail = `; the leader started a new turn${chainNote}.`;
  if (notices.length === 0) return `Auto-wake: ${results} arrived${ids}${tail}`;
  const noticePhrase = `${notices.length === 1 ? 'a timer/watch notice you asked for' : 'timer/watch notices you asked for'} (${notices.join(', ')})`;
  if (n === 0) return `Auto-wake: ${noticePhrase} arrived${tail}`;
  return `Auto-wake: ${results}${ids} and ${noticePhrase} arrived${tail}`;
}

/** The notice shown when a delegation result is waiting for the leader. */
export function formatDeliveryPendingNotice(
  delegationIds: readonly string[],
  count: number,
): string {
  const ids = delegationIds.length > 0 ? ` (${delegationIds.join(', ')})` : '';
  return count === 1
    ? `Background delegation result ready${ids}.`
    : `${count} background delegation results ready${ids}.`;
}

/** The notice shown when the chain cap holds results until the user speaks. */
export function formatAutoWakeSuppressedNotice(pending: number): string {
  return `Auto-wake paused: ${pending} background result${pending === 1 ? '' : 's'} held after too many consecutive woken turns — send a message to continue.`;
}

/**
 * For a replayed user message: the runtime marker text to show instead, or
 * `undefined` when the message is ordinary user input.
 */
export function autoWakeNoticeText(text: string): string | undefined {
  if (!isAutoWakePrompt(text)) return undefined;
  const split = (list: string | undefined): string[] =>
    list
      ? list
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      : [];
  const delegations =
    /delegation result\(s\) arrived:\s*([^\n;]*?)(?:;|\.\s*Review and continue)/i.exec(text);
  const notices = /notice\(s\) arrived:\s*([^\n]*?)\.\s*Review and continue/i.exec(text);
  return formatAutoWakeNotice(split(delegations?.[1]), undefined, split(notices?.[1]));
}
