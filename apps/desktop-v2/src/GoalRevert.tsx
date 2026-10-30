import { Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { record } from './engine-values';

/** The baseline a Goal run can be reverted to, when the engine captured one. */
export function goalRevertBaseline(goal: unknown): { branch: string; sha: string } | null {
  const revert = record(record(goal)['revert']);
  return typeof revert['branch'] === 'string' &&
    typeof revert['sha'] === 'string' &&
    /^[0-9a-f]{7,64}$/i.test(revert['sha'])
    ? { branch: revert['branch'], sha: revert['sha'] }
    : null;
}

/** One line for `goal.reverted`. */
export function goalRevertOutcome(value: unknown): string {
  const result = record(value);
  const count = typeof result['reverted'] === 'number' ? result['reverted'] : 0;
  if (result['ok'] !== true)
    return `Nothing was reverted: ${typeof result['reason'] === 'string' ? result['reason'] : 'the engine refused the request'}.`;
  return count
    ? `Reverted ${count} ${count === 1 ? 'commit' : 'commits'} with new revert commits; the run was cleared.`
    : 'The run made no commits to revert; the run was cleared.';
}

/**
 * Undo a Goal run's commits (`goal.revert`): the engine stops the run, removes its managed
 * worktrees and reverts every commit made on the base branch since the captured baseline,
 * with new revert commits. Offered only when the engine reports that baseline.
 */
export function GoalRevert({
  goalId,
  goal,
  state,
  send,
  readOnly,
}: {
  goalId: string;
  goal: unknown;
  state: EngineState;
  send: EngineSend;
  readOnly: boolean;
}) {
  const baseline = goalRevertBaseline(goal);
  const [confirm, setConfirm] = useState(false),
    [waiting, setWaiting] = useState(false),
    [error, setError] = useState(''),
    [outcome, setOutcome] = useState('');
  const seen = useRef<unknown>(undefined);
  const incoming = state.results['goal.reverted'];
  useEffect(() => {
    if (!waiting || !incoming || incoming === seen.current) return;
    setWaiting(false);
    setOutcome(goalRevertOutcome(incoming));
  }, [incoming, waiting]);
  if (!baseline && !outcome) return null;
  return (
    <div className="goal-revert">
      {baseline && !confirm && (
        <button
          type="button"
          className="button secondary"
          disabled={readOnly || waiting}
          onClick={() => {
            setConfirm(true);
            setOutcome('');
          }}
        >
          <Undo2 size={14} /> Revert run
        </button>
      )}
      {baseline && confirm && (
        <div className="goal-revert-confirm" role="alert">
          <p>
            Stop this run, remove its managed worktrees and revert every commit made on{' '}
            <code>{baseline.branch}</code> since <code>{baseline.sha.slice(0, 7)}</code>? Revert
            commits are added; history is not rewritten. Commits made by anyone else on that branch
            in the meantime are reverted too.
          </p>
          <button
            type="button"
            className="button danger small"
            onClick={() => {
              setConfirm(false);
              setError('');
              seen.current = incoming;
              setWaiting(true);
              void send('goal.revert', { goalId }).catch((failure) => {
                setWaiting(false);
                setError(failure instanceof Error ? failure.message : String(failure));
              });
            }}
          >
            Revert run
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setConfirm(false)}
          >
            Keep
          </button>
        </div>
      )}
      {waiting && <p role="status">Reverting…</p>}
      {outcome && <p role="status">{outcome}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </div>
  );
}
