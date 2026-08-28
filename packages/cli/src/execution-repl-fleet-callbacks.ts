import type { Director } from '@wrongstack/core/coordination';

interface ReplFleetCallbacksOptions {
  director: Director | null | undefined;
  getDirector: (() => Director | null | undefined) | undefined;
}

interface ReplFleetCallbacks {
  onInterruptFleet: () => number;
  onAgentIterationComplete: (tokens: number) => void;
}

export function createReplFleetCallbacks({
  director,
  getDirector,
}: ReplFleetCallbacksOptions): ReplFleetCallbacks {
  const resolveDirector = () => getDirector?.() ?? director;

  return {
    onInterruptFleet: () => {
      // Mirror the slash /fleet kill path: remove every running/idle subagent
      // so Ctrl+C stops the whole fleet, including lazily-created Directors.
      const dir = resolveDirector();
      if (!dir) return 0;
      let killed = 0;
      for (const sa of dir.status().subagents) {
        if (sa.status === 'running' || sa.status === 'idle') {
          try {
            void dir.remove(sa.id);
            killed++;
          } catch {
            /* best-effort */
          }
        }
      }
      return killed;
    },
    onAgentIterationComplete: (tokens) => {
      const dir = resolveDirector();
      dir?.setLeaderContextPressure(tokens);
    },
  };
}
