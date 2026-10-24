import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { UserInputAwaiter, UserInputResponse } from '@wrongstack/contracts/types/user-input';
import { userInputObserverCount } from '../hooks/user-input-observers.js';
import { HUMAN_APPROVAL_TIMEOUT_MS } from './agent-tools.js';

/**
 * Autonomy modes in which nobody is expected at the keyboard. The
 * conversation's own mode wins; the process-wide one is the fallback for a
 * host that keeps only that (the CLI and TUI).
 */
export function isUnattendedAutonomy(conversationMode: unknown, processMode?: unknown): boolean {
  const mode = typeof conversationMode === 'string' ? conversationMode : processMode;
  return mode === 'eternal' || mode === 'eternal-parallel';
}

export interface EventUserInputAwaiterOptions {
  /**
   * True while nobody is expected to answer (eternal / parallel autonomy),
   * given the asking conversation's meta. A form left unanswered that long is
   * then given no answer: `clarify` takes its recommended answers and an MCP
   * elicitation is cancelled — the wait a tool confirmation gets before the
   * Brain decides it. Asked again each time the wait runs out, so switching
   * into or out of those modes applies to a form already open.
   */
  isUnattended?: ((meta: Readonly<Record<string, unknown>> | undefined) => boolean) | undefined;
  /** How long an unattended form waits; the tool-approval wait by default. */
  unattendedWaitMs?: number | undefined;
}

/** EventBus-backed, first-response-wins structured interaction channel. */
export function createEventUserInputAwaiter(
  events: EventBus,
  options: EventUserInputAwaiterOptions = {},
): UserInputAwaiter {
  const waitMs = options.unattendedWaitMs ?? HUMAN_APPROVAL_TIMEOUT_MS;
  return async (request, { signal, sessionId, meta }) => {
    if (events.listenerCount('user.input_requested') <= userInputObserverCount()) return undefined;
    if (signal.aborted) return cancelled(request.id);

    return new Promise<UserInputResponse | undefined>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const offSubmitted = events.on('user.input_submitted', (event) => {
        if (event.response.requestId !== request.id) return;
        if (sessionId !== undefined && event.sessionId !== sessionId) return;
        finish(event.response, 'user');
      });
      const finish = (response: UserInputResponse, source: 'user' | 'abort' | 'unattended') => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        offSubmitted();
        events.emit('user.input_resolved', { sessionId, requestId: request.id, response, source });
        // No answer: the caller falls back as it does with no surface at all.
        resolve(source === 'unattended' ? undefined : response);
      };
      const onAbort = () => finish(cancelled(request.id), 'abort');
      signal.addEventListener('abort', onAbort, { once: true });
      const isUnattended = options.isUnattended;
      if (isUnattended) {
        const wait = (): void => {
          timer = setTimeout(() => {
            if (isUnattended(meta)) finish(cancelled(request.id), 'unattended');
            else wait();
          }, waitMs);
          timer.unref?.();
        };
        wait();
      }
      events.emit('user.input_requested', {
        sessionId,
        request,
        resolve: (response) => finish(response, 'user'),
      });
    });
  };
}

function cancelled(requestId: string): UserInputResponse {
  return { requestId, status: 'cancelled', answers: [] };
}
