import { useMemo } from 'react';
import { wordDiff } from './word-diff';

/** Inline word-level changes from the original draft to the version under review. */
export function RefinementComparison({ original, text }: { original: string; text: string }) {
  const parts = useMemo(() => wordDiff(original, text), [original, text]);
  if (!parts)
    return (
      <p className="field-help" role="status">
        These texts are too long to compare word by word. Review the full version instead.
      </p>
    );
  const count = (kind: 'add' | 'remove') =>
    parts
      .filter((part) => part.kind === kind)
      .reduce((total, part) => total + (part.text.match(/\S+/g)?.length ?? 0), 0);
  const added = count('add'),
    removed = count('remove');
  return (
    <section className="refine-comparison" aria-label="Changes from your original draft">
      <p className="field-help">
        {added || removed
          ? `${added} ${added === 1 ? 'word' : 'words'} added · ${removed} removed`
          : 'No changes from your original draft.'}
      </p>
      <p className="refine-comparison-text">
        {parts.map((part, index) =>
          part.kind === 'add' ? (
            <ins key={index}>{part.text}</ins>
          ) : part.kind === 'remove' ? (
            <del key={index}>{part.text}</del>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </p>
    </section>
  );
}
