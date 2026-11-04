import type { SubmitMode } from './composer-model';
import type { DesktopNavigation } from './desktop-commands';
import type { HuntRequest } from './desktop-hunt';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';

/** What a command needs from the composer and the conversation it is typed in. */
export interface DesktopCommandContext {
  command: EngineCommand;
  /** Sends without waiting for a reply, for requests whose outcome a page reports. */
  send: EngineSend;
  /** The conversation as the engine last reported it: preferences, run state, steps, todos. */
  state: EngineState;
  /** Stops the running hunt after its current round; the notice to show, or null without one. */
  stopHunt(): string | null;
  openHelp(): void;
  openPrompts(view: 'library' | 'journal'): void;
  openContext(action: 'inspect' | 'compact' | 'compact-aggressive' | 'repair' | 'clear'): void;
  stop(): void;
  toggleEnhance(): void;
  openSettings(): void;
  /** Opens the queued-prompt panel; false when nothing is queued. */
  openQueue(): boolean;
  setMode(mode: SubmitMode): void;
  navigate(target: DesktopNavigation): void;
  notify(message: string): void;
  fail(message: string): void;
}

/**
 * What the composer does next: the command ran (the draft is cleared), it was refused (the
 * draft stays, with the reason), or the text is sent as a prompt.
 */
export type DesktopCommandOutcome =
  | { kind: 'handled' }
  | { kind: 'refused'; message: string }
  | { kind: 'submit'; text: string; mode?: SubmitMode | undefined }
  | { kind: 'hunt'; request: HuntRequest };

export const HANDLED: DesktopCommandOutcome = { kind: 'handled' };
export const refused = (message: string): DesktopCommandOutcome => ({ kind: 'refused', message });
export const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Sends an engine request and reports its outcome: `done` turns the reply into the notice to
 * show, and a failure is shown as an error.
 */
export function request(
  context: DesktopCommandContext,
  type: string,
  payload: Record<string, unknown>,
  replies: readonly string[],
  done: (reply: Record<string, unknown>) => string,
): DesktopCommandOutcome {
  void context.command(type, payload, replies).then(
    (reply) => context.notify(done(reply)),
    (error) => context.fail(reason(error)),
  );
  return HANDLED;
}
