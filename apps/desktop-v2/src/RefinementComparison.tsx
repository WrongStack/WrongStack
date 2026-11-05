import { useMemo } from 'react';
import { useDesktopText } from './desktop-i18n';
import { wordDiff } from './word-diff';

/** Inline word-level changes from the original draft to the version under review. */
export function RefinementComparison({ original, text }: { original: string; text: string }) {
  const { t } = useDesktopText();
  const parts = useMemo(() => wordDiff(original, text), [original, text]);
  if (!parts)
    return (
      <p className="field-help" role="status">
        {t('refineCompare.tooLong')}
      </p>
    );
  const count = (kind: 'add' | 'remove') =>
    parts
      .filter((part) => part.kind === kind)
      .reduce((total, part) => total + (part.text.match(/\S+/g)?.length ?? 0), 0);
  const added = count('add'),
    removed = count('remove');
  return (
    <section className="refine-comparison" aria-label={t('refineCompare.label')}>
      <p className="field-help">
        {added || removed
          ? added === 1
            ? t('refineCompare.oneWord', { removed })
            : t('refineCompare.words', { count: added, removed })
          : t('refineCompare.none')}
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
