import { useCallback } from 'react';
import type { Agent } from '@wrongstack/core/agent';
import type { Director } from '@wrongstack/core/coordination';
import { applyRewindToConversation, DefaultSessionRewinder } from '@wrongstack/core/storage';
import type { SessionInterruptController } from './use-session-interrupt-controller.js';

interface UseSessionRewindOptions {
  agent: Agent;
  sessionsDir?: string | undefined;
  interruptController?: SessionInterruptController | undefined;
  liveDirector: () => Director | null;
  sessionGenerationRef: React.MutableRefObject<number>;
}

export function useSessionRewind({
  agent,
  sessionsDir,
  interruptController,
  liveDirector,
  sessionGenerationRef,
}: UseSessionRewindOptions) {
  const handleRewindTo = useCallback(
    async (checkpointIndex: number) => {
      const sessionId = agent.ctx.session.id;
      if (!sessionId) return;

      // Invalidate late output before stopping every producer that can mutate
      // the session: the foreground leader, autonomy/SDD drivers, and fleet.
      sessionGenerationRef.current++;
      interruptController?.abortLeader();

      const cleanup: Promise<unknown>[] = [];
      if (interruptController?.waitForIdle) {
        cleanup.push(interruptController.waitForIdle().catch(() => undefined));
      }
      const rewindDir = liveDirector();
      if (rewindDir) cleanup.push(rewindDir.terminateAll().catch(() => undefined));

      if (cleanup.length > 0) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const cap = new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1500);
          timeout.unref?.();
        });
        try {
          await Promise.race([Promise.allSettled(cleanup).then(() => undefined), cap]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }

      const rewinder = new DefaultSessionRewinder(
        sessionsDir ?? '',
        agent.ctx.projectRoot ?? agent.ctx.cwd,
      );
      const reverted = await rewinder.rewindToCheckpoint(sessionId, checkpointIndex);
      await applyRewindToConversation({
        session: agent.ctx.session,
        state: agent.ctx.state,
        sessionsDir: sessionsDir ?? '',
        promptIndex: checkpointIndex,
        revertedFiles: reverted.revertedFiles,
      });
    },
    [
      agent.ctx.session,
      sessionsDir,
      agent.ctx.projectRoot,
      agent.ctx.cwd,
      interruptController,
      liveDirector,
      sessionGenerationRef,
    ],
  );

  return { handleRewindTo };
}
