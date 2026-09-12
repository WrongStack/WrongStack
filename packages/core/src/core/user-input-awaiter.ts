import type { EventBus } from '../kernel/events.js';
import type { UserInputAwaiter, UserInputResponse } from '../types/user-input.js';
import { userInputObserverCount } from './user-input-observers.js';

/** EventBus-backed, first-response-wins structured interaction channel. */
export function createEventUserInputAwaiter(events: EventBus): UserInputAwaiter {
  return async (request, { signal, sessionId }) => {
    if (events.listenerCount('user.input_requested') <= userInputObserverCount()) return undefined;
    if (signal.aborted) return cancelled(request.id);

    return new Promise<UserInputResponse>((resolve) => {
      let settled = false;
      const offSubmitted = events.on('user.input_submitted', (event) => {
        if (event.response.requestId !== request.id) return;
        if (sessionId !== undefined && event.sessionId !== sessionId) return;
        finish(event.response, 'user');
      });
      const finish = (response: UserInputResponse, source: 'user' | 'abort') => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        offSubmitted();
        events.emit('user.input_resolved', { sessionId, requestId: request.id, response, source });
        resolve(response);
      };
      const onAbort = () => finish(cancelled(request.id), 'abort');
      signal.addEventListener('abort', onAbort, { once: true });
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
