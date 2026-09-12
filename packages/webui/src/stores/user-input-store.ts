import type { UserInputRequest } from '@wrongstack/core/types';
import { create } from 'zustand';

export interface PendingUserInputEntry {
  sessionId: string;
  request: UserInputRequest;
}

interface UserInputState {
  queues: Record<string, PendingUserInputEntry[]>;
  enqueue: (entry: PendingUserInputEntry) => void;
  resolve: (requestId: string) => void;
  forgetSession: (sessionId: string) => void;
  reset: () => void;
}

const MAX_PENDING_FOR_SESSION = 8;

export const useUserInputStore = create<UserInputState>((set) => ({
  queues: {},
  enqueue: (entry) =>
    set((state) => {
      const current = state.queues[entry.sessionId] ?? [];
      const withoutDuplicate = current.filter((item) => item.request.id !== entry.request.id);
      return {
        queues: {
          ...state.queues,
          [entry.sessionId]: [...withoutDuplicate, entry].slice(-MAX_PENDING_FOR_SESSION),
        },
      };
    }),
  resolve: (requestId) =>
    set((state) => {
      const queues: Record<string, PendingUserInputEntry[]> = {};
      for (const [sessionId, entries] of Object.entries(state.queues)) {
        const remaining = entries.filter((entry) => entry.request.id !== requestId);
        if (remaining.length > 0) queues[sessionId] = remaining;
      }
      return { queues };
    }),
  forgetSession: (sessionId) =>
    set((state) => {
      const { [sessionId]: _forgotten, ...queues } = state.queues;
      return { queues };
    }),
  reset: () => set({ queues: {} }),
}));

export function pendingUserInputForSession(
  queues: UserInputState['queues'],
  sessionId: string | null,
): PendingUserInputEntry | null {
  if (sessionId) return queues[sessionId]?.[0] ?? null;
  return Object.values(queues).flat()[0] ?? null;
}
