import { useCallback, useEffect, useRef } from 'react';
import type { Action } from '../app-reducer.js';

type ActiveBugHunt = {
  command: string;
  scope?: string | undefined;
  totalRounds?: number | undefined;
  completedRounds: number;
};

function parseBugHuntScope(command: string): string | undefined {
  const args = command.replace(/^\/bughunt(?:\s+|$)/, '').trim();
  const match = args.match(/^--rounds(?:\s+|=)\d+(?:\s+([\s\S]*))?$/);
  const scope = (match?.[1] ?? (match ? '' : args)).trim();
  return scope || undefined;
}

function buildContinuationMessage(active: ActiveBugHunt): string {
  const round = active.completedRounds + 1;
  const roundLabel = active.totalRounds ? `round ${round}/${active.totalRounds}` : `round ${round}`;
  const scope = active.scope ? ` Stay within the original scope: ${active.scope}.` : '';
  return `This is ${roundLabel}; we're continuing the bug hunt.${scope}`;
}

/**
 * Let the just-finished run complete its `finally` cleanup before its successor
 * enters the normal submit path. In particular, `runBlocks` clears its active
 * controller only after it notifies this hook; submitting synchronously here
 * makes the next round look like mid-run input and can leave it queued.
 */
function submitAfterCurrentRun(submit: (command: string) => void, command: string): void {
  setTimeout(() => submit(command), 0);
}

/** Coordinates bounded or user-stopped `/bughunt` rounds in the TUI. */
export function useBugHuntLoop(
  dispatch: (action: Action) => void,
  submit: (command: string) => void,
  historyGen?: number,
) {
  const activeRef = useRef<ActiveBugHunt | null>(null);
  const replayCommandRef = useRef<string | null>(null);

  // /clear (and any wholesale history replacement, e.g. /resume) ends any
  // hunt. The reducer half (bugHuntRunning / bugHuntContinue) is reset by the
  // 'clearHistory' case, but this hook's refs live OUTSIDE the reducer: a
  // mid-round /clear bumps sessionGeneration, so run-blocks-controller drops
  // the in-flight run BEFORE onRunFinished fires — without this effect
  // nothing would ever clear them. shouldSuppressNextSteps() would stay true
  // for the rest of the process (silently disabling next-steps suggestions
  // and predictions), and a stale replay marker could swallow the echo of the
  // user's next identical command. Reacting to the history generation App
  // already tracks needs no new wiring beyond passing it in.
  const lastHistoryGenRef = useRef(historyGen);
  useEffect(() => {
    if (historyGen === undefined) return;
    if (historyGen === lastHistoryGenRef.current) return;
    lastHistoryGenRef.current = historyGen;
    activeRef.current = null;
    replayCommandRef.current = null;
  }, [historyGen]);

  const onBugHuntStarted = useCallback(
    (command: string, totalRounds?: number) => {
      const active = activeRef.current;
      if (active?.command === command) {
        dispatch({
          type: 'bugHuntRunningOpen',
          info: {
            currentRound: active.completedRounds + 1,
            totalRounds: active.totalRounds,
          },
        });
        return;
      }
      activeRef.current = {
        command,
        scope: parseBugHuntScope(command),
        totalRounds,
        completedRounds: 0,
      };
      dispatch({ type: 'bugHuntRunningOpen', info: { currentRound: 1, totalRounds } });
    },
    [dispatch],
  );

  const onRunFinished = useCallback(
    (status: 'done' | 'aborted' | 'failed' | 'max_iterations') => {
      const active = activeRef.current;
      if (!active) return;
      dispatch({ type: 'bugHuntRunningClose' });
      if (status !== 'done') {
        activeRef.current = null;
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: 'Proof-Driven Bug Hunter loop stopped because this round did not complete.',
          },
        });
        return;
      }
      active.completedRounds++;
      if (active.totalRounds !== undefined && active.completedRounds >= active.totalRounds) {
        activeRef.current = null;
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `Proof-Driven Bug Hunter completed ${active.completedRounds}/${active.totalRounds} requested rounds.`,
          },
        });
        return;
      }
      const snapshot = { ...active };
      const continueWithNextRound = () => {
        // Round 1 is the slash command that expands the full prompt. Later
        // rounds submit only a compact reminder, directly through the normal
        // submit path. It must not be placed in the composer for the user to
        // press Enter again.
        const continuation = buildContinuationMessage(snapshot);
        replayCommandRef.current = continuation;
        dispatch({
          type: 'bugHuntRunningOpen',
          info: {
            currentRound: snapshot.completedRounds + 1,
            totalRounds: snapshot.totalRounds,
          },
        });
        submitAfterCurrentRun(submit, continuation);
      };

      // A bounded hunt is explicitly autonomous: proceed as soon as the
      // previous round succeeds instead of opening a confirmation panel.
      if (snapshot.totalRounds !== undefined) {
        continueWithNextRound();
        return;
      }
      dispatch({
        type: 'bugHuntContinueOpen',
        info: {
          completedRounds: snapshot.completedRounds,
          totalRounds: snapshot.totalRounds,
          resolve: (decision) => {
            dispatch({ type: 'bugHuntContinueClose' });
            if (decision === 'stop') {
              activeRef.current = null;
              dispatch({
                type: 'addEntry',
                entry: { kind: 'info', text: 'Proof-Driven Bug Hunter loop stopped.' },
              });
              return;
            }
            continueWithNextRound();
          },
        },
      });
    },
    [dispatch, submit],
  );

  const consumeReplay = useCallback((command: string): boolean => {
    if (replayCommandRef.current !== command) return false;
    replayCommandRef.current = null;
    return true;
  }, []);

  const shouldSuppressNextSteps = useCallback(() => activeRef.current !== null, []);

  return { onBugHuntStarted, onRunFinished, consumeReplay, shouldSuppressNextSteps };
}
