import { toErrorMessage } from '@wrongstack/core/utils';
import type { Dispatch, MutableRefObject } from 'react';
import type { Action } from '../app-action-type.js';
import type { AppProps } from '../app-props.js';
import type { State } from '../app-state.js';
import { clearImagePreviewCache } from '../graphics/image-preview-cache.js';
import {
  RESUME_SPINNER_MS,
  RESUME_STREAM_FRAME_MS,
  resumeChunkSize,
  resumeStageLabel,
} from '../resume-load.js';

/** What one render of `useAppPickerKeys` hands the resume runner. */
export interface ResumeRunnerDeps {
  state: State;
  dispatch: Dispatch<Action>;
  sessionGenerationRef?: MutableRefObject<number> | undefined;
  /** Supersede token: bumped by every run, re-checked by every continuation. */
  resumeRunRef: MutableRefObject<number>;
  mountedRef: MutableRefObject<boolean>;
  onResumeSession: AppProps['onResumeSession'];
  switchQueueSession?: ((sessionId: string) => void) | undefined;
  agent: AppProps['agent'];
  setSuggestions: AppProps['setSuggestions'];
}

/**
 * Run one resume, from the wipe to the last streamed entry.
 *
 * Shared by the `/resume` picker and the F10 sessions panel so the two cannot
 * drift into showing different things for the same operation.
 *
 * The shape of it is the whole feature: clear the screen the way `/clear`
 * does, show a live block while the journal is read (seconds, with nothing
 * else on screen), then stream the transcript in so it scrolls into place the
 * way it did when it was live — and stop there, waiting.
 */
export function createResumeRunner({
  state,
  dispatch,
  sessionGenerationRef,
  resumeRunRef,
  mountedRef,
  onResumeSession,
  switchQueueSession,
  agent,
  setSuggestions,
}: ResumeRunnerDeps): (
  sessionId: string,
  label: string,
  hooks?: { onSettled?: (() => void) | undefined },
) => Promise<void> {
  return async (
    sessionId: string,
    label: string,
    hooks: { onSettled?: (() => void) | undefined } = {},
  ): Promise<void> => {
    if (state.status && state.status !== 'idle') {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: 'Stop the active run before resuming another session.' },
      });
      hooks.onSettled?.();
      return;
    }
    if (sessionGenerationRef) sessionGenerationRef.current += 1;
    resumeRunRef.current += 1;
    const run = resumeRunRef.current;
    const alive = () => mountedRef.current && resumeRunRef.current === run;

    dispatch({ type: 'resumeLoadStart', sessionId, label });
    dispatch({ type: 'hint', text: `Resuming "${label}"…` });
    // The spinner is the only thing that moves while a big journal parses; the
    // loader's own progress ticks are throttled to ~4/sec and a warm cache
    // reports a single completed tick, so neither can carry the animation.
    const spinner = setInterval(() => {
      if (!alive()) return;
      dispatch({ type: 'resumeLoadTick', sessionId });
    }, RESUME_SPINNER_MS);
    const stop = () => clearInterval(spinner);

    // Paint BEFORE the host work starts: the parse blocks this event loop in
    // bursts, so without a scheduler turn Ink never commits the frame above and
    // Enter looks like a silent no-op.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (!alive()) {
      stop();
      hooks.onSettled?.();
      return;
    }

    try {
      const result = await onResumeSession?.(
        sessionId,
        (progress) => {
          if (!alive()) return;
          dispatch({
            type: 'resumeLoadTick',
            sessionId,
            loadedBytes: progress.loadedBytes,
            totalBytes: progress.totalBytes,
          });
        },
        // Real stages from the host, not invented ones: the block says what is
        // actually happening, and an unknown stage still shows rather than
        // being silently dropped.
        (stage) => {
          if (!alive()) return;
          dispatch({ type: 'resumeLoadTick', sessionId, note: resumeStageLabel(stage) });
        },
      );
      stop();
      if (!alive()) return;
      if (!result) {
        // The host resolved without a session instead of rejecting. There is no
        // reason to show, so say exactly that rather than implying one was.
        dispatch({ type: 'resumeLoadAbort', sessionId });
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'error',
            text: `Failed to resume session ${sessionId} — the host returned no session and no reason.`,
          },
        });
        return;
      }

      const entries = result.entries;
      // The queue belongs to the session: the one resumed brings its own.
      if (result.attached !== false) {
        clearImagePreviewCache();
        if (switchQueueSession) switchQueueSession(result.sessionId);
        else dispatch({ type: 'queueClear' });
      }
      const total = entries.length;
      const size = resumeChunkSize(total);
      // An empty transcript still needs the terminating chunk: it is what
      // clears the loading block and applies the context snapshot.
      for (let index = 0; index < total || index === 0; index += size) {
        if (!alive()) return;
        const slice = entries.slice(index, index + size);
        const done = index + size >= total;
        dispatch({
          type: 'resumeStreamChunk',
          sessionId,
          entries: slice,
          total,
          ...(result.attached !== false && index === 0
            ? {
                banner: {
                  sessionId: result.sessionId,
                  cwd: agent.ctx.workingDir ?? agent.ctx.projectRoot,
                  model: agent.ctx.model,
                  provider: agent.ctx.provider?.id,
                },
              }
            : {}),
          holdUntilSettled: true,
          ...(done ? { done: true, contextSnapshot: result.contextSnapshot } : {}),
        });
        if (done) break;
        // The block is gone from the transcript now, so the batch counter goes
        // where it stays visible while the conversation scrolls past it.
        dispatch({
          type: 'hint',
          text: `Replaying "${label}" — ${Math.min(index + size, total)} / ${total} entries…`,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, RESUME_STREAM_FRAME_MS));
      }
      if (!alive()) return;

      // One more frame before touching the suggestion store: each replayed
      // assistant entry runs its own `<nextsteps>` parser on mount, so the
      // store is churning until the last batch has COMMITTED. Writing the
      // authoritative value first would just be overwritten by whichever entry
      // mounted last — which is not necessarily the final turn.
      await new Promise<void>((resolve) => setTimeout(resolve, RESUME_STREAM_FRAME_MS));
      if (!alive()) return;
      // Offered, not executed. `autoProceedHold` is still set, so nothing can
      // fire these; the user picks one with /next or types something else.
      // Setting `[]` matters as much as setting a list: it clears suggestions
      // left over from the session being left behind.
      setSuggestions?.(result.nextSteps ?? []);

      for (const line of result.warnings ?? []) {
        dispatch({ type: 'addEntry', entry: { kind: 'warn', text: `Resume: ${line}` } });
      }
      // `attached === false` means the transcript is on screen but the session
      // was never claimed for writing. Saying "Resumed" there would be a lie
      // the user only discovers when their next prompt lands elsewhere.
      dispatch(
        result.attached === false
          ? {
              type: 'addEntry',
              entry: {
                kind: 'warn',
                text:
                  `Showing ${result.sessionId} read-only — ${total} entries replayed. ` +
                  `The session was NOT attached, so anything you send continues the current session instead.`,
              },
            }
          : {
              type: 'addEntry',
              entry: {
                kind: 'info',
                text:
                  `Resumed session ${result.sessionId} — ${total} entries replayed. ` +
                  `Waiting for you; auto-proceed stays paused until you send something.`,
              },
            },
      );
      // The session ended on a next-steps block: show what it proposed and
      // stop there. Listing them is the whole difference between "it resumed
      // and then carried on by itself" and "it resumed and asked".
      const steps = result.nextSteps ?? [];
      if (steps.length > 0) {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: [
              `Next steps this session proposed — nothing runs until you choose:`,
              ...steps.map((step, index) => `  ${index + 1}. ${step}`),
              `  /next <n> to run one, or just type something else.`,
            ].join('\n'),
          },
        });
      }
    } catch (err) {
      stop();
      if (!alive()) return;
      dispatch({ type: 'resumeLoadAbort', sessionId });
      // The reason, in the chat, on a screen the user can scroll. This is the
      // whole point of closing the picker first.
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'error',
          text: `Failed to resume session ${sessionId}: ${toErrorMessage(err)}`,
        },
      });
    } finally {
      stop();
      hooks.onSettled?.();
      if (alive()) {
        dispatch({ type: 'resumeLoadAbort', sessionId });
        dispatch({ type: 'hint', text: '' });
      }
    }
  };
}
