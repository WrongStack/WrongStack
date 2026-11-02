/**
 * `start-session` — HQ asks a connected client to open a NEW headless session
 * in that client's project, with an operator-written prompt.
 *
 * The client never runs a shell for it: it launches its own `wstack` binary
 * with the prompt as one argument (see the CLI's `hq-session-launcher`). The
 * new process connects to HQ like any other client, and its permission
 * prompts wait for an answer from the HQ Inbox instead of being auto-denied.
 *
 * Gated exactly like `run-command` — the browser session and the target
 * client's token both need `control.execute`, the trust boundary treats it as
 * critical, and the client must have opted in to remote execution — plus the
 * target has to advertise the `session.start` capability.
 *
 * @module hq/command-start-session
 */

/** Longest prompt HQ forwards; a task description, not a document. */
const HQ_START_SESSION_PROMPT_MAX = 16_000;

export interface HqStartSessionCommand {
  type: 'start-session';
  /** What the new session is asked to do. Passed as one argv entry, never through a shell. */
  prompt: string;
}

/** Shape check for an inbound `start-session` payload; `null` rejects it. */
export function parseHqStartSession(p: Record<string, unknown>): HqStartSessionCommand | null {
  const prompt = p['prompt'];
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || trimmed.length > HQ_START_SESSION_PROMPT_MAX) return null;
  // A NUL cannot travel in an argv entry on any platform.
  if (trimmed.includes('\u0000')) return null;
  return { type: 'start-session', prompt: trimmed };
}
