import { useMemo, useState } from 'react';
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
  const segments = useMemo(() => mergeSegments(mine, stored), [mine, stored]);
  const [choices, setChoices] = useState<Record<number, MergeChoice>>({});
  const changes = segments.filter((segment) => segment.kind === 'change');
  const merged = mergedText(segments, choices);
  if (!changes.length) return null;
  return (
    <details className="draft-merge">
      <summary>Merge change by change ({changes.length})</summary>
      <ol aria-label="Draft changes">
        {changes.map((change) => (
          <li key={change.id}>
            <div className="draft-merge-sides">
              <section aria-label={`Your lines for change ${change.id + 1}`}>
                <pre>{change.mine.join('\n') || '(no lines)'}</pre>
              </section>
              <section aria-label={`Stored lines for change ${change.id + 1}`}>
                <pre>{change.stored.join('\n') || '(no lines)'}</pre>
              </section>
            </div>
            <fieldset>
              <legend>Keep for change {change.id + 1}</legend>
              {(
                [
                  ['mine', 'Mine'],
                  ['stored', 'Stored'],
                  ['both', 'Both, mine first'],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={`draft-merge-${change.id}`}
                    checked={(choices[change.id] ?? 'mine') === value}
                    onChange={() => setChoices((current) => ({ ...current, [change.id]: value }))}
                  />{' '}
                  {label}
                </label>
              ))}
            </fieldset>
          </li>
        ))}
      </ol>
      <label>
        Merged draft
        <textarea aria-label="Merged draft" readOnly value={merged} />
      </label>
      <button
        type="button"
        className="button primary small"
        disabled={busy}
        onClick={() => onKeep(merged)}
      >
        Keep merged draft
      </button>
    </details>
  );
}
