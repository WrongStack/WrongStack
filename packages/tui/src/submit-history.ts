type SubmitHistoryRoute = 'slash' | 'normal';

/**
 * Decide whether a submitted input should be pushed into input history.
 *
 * Rules:
 * - blank input is ignored entirely
 * - bare slash commands (just "/" or "/command" without arguments) are not
 *   saved — they come from the slash-command menu before the user types
 *   any actual arguments and would clutter history
 * - slash commands with arguments (e.g. "/setmodel anthropic/claude") are
 *   remembered as 'slash' entries
 * - normal free-text submissions are remembered as 'normal' entries
 * - legacy Telegram setup commands that contain bot tokens are suppressed
 */
export function shouldPushSubmittedHistory(raw: string): {
  push: boolean;
  route: SubmitHistoryRoute | 'empty';
  trimmed: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { push: false, route: 'empty', trimmed };

  if (trimmed.startsWith('/')) {
    // Bare slash commands (just "/" or "/command" without arguments) come
    // from the slash-command menu when pressing Enter on a selection before
    // typing arguments.  Don't clutter history with these — only persist
    // commands that carry a second word (the arguments).
    const hasArgs = trimmed.includes(' ');

    // Legacy Telegram setup accepted the bot token in the slash arguments.
    // Never retain such a line even though the command now refuses that shape.
    if (/^\/(?:telegram-setup|tg-setup)\s+\d+:[A-Za-z0-9_-]+(?:\s|$)/i.test(trimmed)) {
      return { push: false, route: 'slash', trimmed };
    }

    return { push: hasArgs, route: 'slash', trimmed };
  }

  return { push: true, route: 'normal', trimmed };
}
