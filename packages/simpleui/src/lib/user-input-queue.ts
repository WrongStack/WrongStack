import type { UserInputRequest } from '../types.js';

export interface PendingUserInputRequest {
  request: UserInputRequest;
  sessionId?: string | undefined;
}

export function enqueuePendingUserInput(
  current: readonly PendingUserInputRequest[],
  entry: PendingUserInputRequest,
  limit = 8,
): PendingUserInputRequest[] {
  return [...current.filter((item) => item.request.id !== entry.request.id), entry].slice(
    -Math.max(1, limit),
  );
}

export function resolvePendingUserInput(
  current: readonly PendingUserInputRequest[],
  requestId: string,
): PendingUserInputRequest[] {
  return current.filter((item) => item.request.id !== requestId);
}
