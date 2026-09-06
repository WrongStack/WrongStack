import { useCallback, useEffect, useRef } from 'react';
import type { Action } from '../app-reducer.js';

type ActiveBugHunt = { command: string; totalRounds?: number | undefined; completedRounds: number };

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

  const onBugHuntStarted = useCallback((command: string, totalRounds?: number) => {
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
    activeRef.current = { command, totalRounds, completedRounds: 0 };
    dispatch({ type: 'bugHuntRunningOpen', info: { currentRound: 1, totalRounds } });
  }, [dispatch]);

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
            // Preserve normal slash setup, but hide this internal replay from
            // the chat transcript so the command is not printed each round.
            replayCommandRef.current = snapshot.command;
            submit(snapshot.command);
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
