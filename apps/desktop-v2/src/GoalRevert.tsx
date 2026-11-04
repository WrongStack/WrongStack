import { Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { record } from './engine-values';
import { surfaceI18n } from './surface-i18n';

/** The baseline a Goal run can be reverted to, when the engine captured one. */
export function goalRevertBaseline(goal: unknown): { branch: string; sha: string } | null {
  const revert = record(record(goal)['revert']);
  return typeof revert['branch'] === 'string' &&
    typeof revert['sha'] === 'string' &&
    /^[0-9a-f]{7,64}$/i.test(revert['sha'])
    ? { branch: revert['branch'], sha: revert['sha'] }
    : null;
}

/** How a revert outcome is worded; English by default. */
export interface GoalRevertWords {
  refused: (reason: string) => string;
  /** The reason when the engine gave none. */
  refusedReason: string;
  reverted: (count: number) => string;
  none: string;
}
const englishRevertWords: GoalRevertWords = {
  refused: (reason) => `Nothing was reverted: ${reason}.`,
  refusedReason: 'the engine refused the request',
  reverted: (count) =>
    `Reverted ${count} ${count === 1 ? 'commit' : 'commits'} with new revert commits; the run was cleared.`,
  none: 'The run made no commits to revert; the run was cleared.',
};

/** One line for `goal.reverted`. */
export function goalRevertOutcome(
  value: unknown,
  words: GoalRevertWords = englishRevertWords,
): string {
  const result = record(value);
  const count = typeof result['reverted'] === 'number' ? result['reverted'] : 0;
  if (result['ok'] !== true)
    return words.refused(
      typeof result['reason'] === 'string' ? result['reason'] : words.refusedReason,
    );
  return count ? words.reverted(count) : words.none;
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
  const { t } = useDesktopText();
  const baseline = goalRevertBaseline(goal);
  // The engine's reply is kept as received and worded at render, in the current language.
  const [confirm, setConfirm] = useState(false),
    [waiting, setWaiting] = useState(false),
    [error, setError] = useState(''),
    [reply, setReply] = useState<unknown>(null);
  const outcome =
    reply === null
      ? ''
      : goalRevertOutcome(reply, {
          refused: (reason) => t('goalRevert.refused', { reason }),
          refusedReason: t('goalRevert.refusedReason'),
          reverted: (n) =>
            n === 1 ? t('goalRevert.revertedOne', { n }) : t('goalRevert.revertedMany', { n }),
          none: t('goalRevert.none'),
        });
  const seen = useRef<unknown>(undefined);
  const incoming = state.results['goal.reverted'];
  useEffect(() => {
    if (!waiting || !incoming || incoming === seen.current) return;
    setWaiting(false);
    setReply(incoming);
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
            setReply(null);
          }}
        >
          <Undo2 size={14} /> {t('goalRevert.revertRun')}
        </button>
      )}
      {baseline && confirm && (
        <div className="goal-revert-confirm" role="alert">
          <p>
            <Trans
              i18n={surfaceI18n}
              ns="desktop"
              i18nKey="goalRevert.confirm"
              values={{ branch: baseline.branch, sha: baseline.sha.slice(0, 7) }}
              components={{ code: <code /> }}
            />
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
            {t('goalRevert.revertRun')}
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setConfirm(false)}
          >
            {t('goalRevert.keep')}
          </button>
        </div>
      )}
      {waiting && <p role="status">{t('goalRevert.reverting')}</p>}
      {outcome && <p role="status">{outcome}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </div>
  );
}
