import type { SessionWriter } from '@wrongstack/contracts/types';
import type { TodoItem } from '@wrongstack/core/agent';
import type { SessionResumeClaim } from '@wrongstack/core/storage';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { SessionResumeContext } from './tui-session-resume-contracts.js';

type ResumeAgent = SessionResumeContext['agent'];

/** What a failed resume had claimed or swapped, and what it captured before. */
export interface FailedResumeState {
  agent: ResumeAgent;
  state: SessionResumeContext['state'];
  previousSessionId: string | undefined;
  identityClaimed: boolean;
  resumeClaim: SessionResumeClaim | undefined;
  writerSwapped: boolean;
  openedWriter: SessionWriter | undefined;
  oldWriter: ResumeAgent['ctx']['session'] | undefined;
  oldMessages: ResumeAgent['ctx']['messages'] | undefined;
  oldContextEvidence: ResumeAgent['ctx']['contextEvidence'] | undefined;
  oldSessionRefCurrent: SessionWriter | undefined;
  previousDetachFn: SessionResumeContext['state']['detachActiveTodosCheckpoint'];
  oldTodos: TodoItem[];
  oldPlanPath: unknown;
  oldTaskPath: unknown;
}

/**
 * Undo a failed resume: release or roll back the session identity, then close
 * the writer it opened — or, after the writer swap, put the agent's writer,
 * messages and sidecars back. Best-effort throughout: a throw here would mask
 * the original failure, so every step swallows and logs.
 */
export async function rollbackFailedResume(r: FailedResumeState): Promise<void> {
  const {
    agent,
    state,
    previousSessionId,
    identityClaimed,
    resumeClaim,
    writerSwapped,
    openedWriter,
    oldWriter,
    oldMessages,
    oldContextEvidence,
    oldSessionRefCurrent,
    previousDetachFn,
    oldTodos,
    oldPlanPath,
    oldTaskPath,
  } = r;
  if (!identityClaimed) await resumeClaim?.cancel().catch(() => undefined);
  if (identityClaimed && previousSessionId) {
    // Roll identity back regardless of writerSwapped. If we crashed
    // pre-swap, the resume never took effect so the identity must
    // point at the original session. If we crashed post-swap, the
    // failed-resume UI must not leave the user signed into the
    // resumed session's identity.
    await state.activateSessionIdentity?.(previousSessionId).catch((rollbackErr) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'execution.resume_identity_rollback_failed',
          sessionId: previousSessionId,
          message: toErrorMessage(rollbackErr),
          timestamp: new Date().toISOString(),
        }),
      );
    });
  }
  if (!writerSwapped) {
    await openedWriter?.close().catch(() => undefined);
  } else {
    // Post-swap failure: restore the agent's writer + messages + sidecars
    // so the failed-resume UI doesn't silently leave the next user
    // prompt writing to the resumed JSONL, and so the original
    // session's todos persistence remains wired up. Best-effort: a
    // throw here would mask the original error, so swallow + log.
    //
    // Restores:
    //   - `agent.ctx.session` from `oldWriter`
    //   - `state.sessionRef.current` from `oldSessionRefCurrent`
    //   - `agent.ctx.messages` from the defensive `oldMessages` copy
    //   - `state.detachActiveTodosCheckpoint` from `previousDetachFn`
    //     (the prior session's todos write handle)
    //   - `agent.ctx.state.todos` from `oldTodos`
    //   - `agent.ctx.state.meta['plan.path']` / `['task.path']` from
    //     `oldPlanPath` / `oldTaskPath` (skip when `undefined` —
    //     missing meta on a legacy session is not a restore target).
    try {
      if (oldWriter !== undefined) agent.ctx.session = oldWriter;
      if (state.sessionRef) state.sessionRef.current = oldSessionRefCurrent;
      if (oldContextEvidence !== undefined) agent.ctx.contextEvidence = oldContextEvidence;
      if (oldMessages !== undefined) agent.ctx.state.replaceMessages(oldMessages);
      if (previousDetachFn !== undefined) state.detachActiveTodosCheckpoint = previousDetachFn;
      // Always restore the original todos — even when empty. A later
      // throw (e.g. token accounting) lands AFTER `replaceTodos(restoredTodos)`
      // already ran, so the resumed session's board is visible; restoring
      // `[]` is the correct pre-resume truth, not a no-op to skip.
      agent.ctx.state.replaceTodos([...oldTodos]);
      if (oldPlanPath !== undefined) agent.ctx.state.setMeta('plan.path', oldPlanPath);
      if (oldTaskPath !== undefined) agent.ctx.state.setMeta('task.path', oldTaskPath);
    } catch (rollbackErr) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'execution.resume_post_swap_rollback_failed',
          message: toErrorMessage(rollbackErr),
          timestamp: new Date().toISOString(),
        }),
      );
    }
    if (openedWriter && openedWriter !== oldWriter) {
      await openedWriter.close().catch((closeErr) => {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'execution.resume_opened_writer_close_failed',
            message: toErrorMessage(closeErr),
            timestamp: new Date().toISOString(),
          }),
        );
      });
    }
  }
}
