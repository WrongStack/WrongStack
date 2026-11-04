import { useMemo, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { type MergeChoice, mergedText, mergeSegments } from './draft-merge';

/**
 * Pick, for each change between your editor and the stored draft, which lines to keep; the
 * merged text is previewed before it replaces the editor and becomes the stored draft.
 */
export function DraftMergeChoices({
  mine,
  stored,
  busy,
  onKeep,
}: {
  mine: string;
  stored: string;
  busy: boolean;
  onKeep: (merged: string) => void;
}) {
  const { t } = useDesktopText();
  const segments = useMemo(() => mergeSegments(mine, stored), [mine, stored]);
  const [choices, setChoices] = useState<Record<number, MergeChoice>>({});
  const changes = segments.filter((segment) => segment.kind === 'change');
  const merged = mergedText(segments, choices);
  if (!changes.length) return null;
  return (
    <details className="draft-merge">
      <summary>{t('merge.summary', { count: changes.length })}</summary>
      <ol aria-label={t('merge.changes')}>
        {changes.map((change) => (
          <li key={change.id}>
            <div className="draft-merge-sides">
              <section aria-label={t('merge.yours', { n: change.id + 1 })}>
                <pre>{change.mine.join('\n') || t('merge.noLines')}</pre>
              </section>
              <section aria-label={t('merge.stored', { n: change.id + 1 })}>
                <pre>{change.stored.join('\n') || t('merge.noLines')}</pre>
              </section>
            </div>
            <fieldset>
              <legend>{t('merge.keepFor', { n: change.id + 1 })}</legend>
              {(['mine', 'stored', 'both'] as const).map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={`draft-merge-${change.id}`}
                    checked={(choices[change.id] ?? 'mine') === value}
                    onChange={() => setChoices((current) => ({ ...current, [change.id]: value }))}
                  />{' '}
                  {t(`merge.choice.${value}`)}
                </label>
              ))}
            </fieldset>
          </li>
        ))}
      </ol>
      <label>
        {t('merge.merged')}
        <textarea aria-label={t('merge.merged')} readOnly value={merged} />
      </label>
      <button
        type="button"
        className="button primary small"
        disabled={busy}
        onClick={() => onKeep(merged)}
      >
        {t('merge.keep')}
      </button>
    </details>
  );
}
