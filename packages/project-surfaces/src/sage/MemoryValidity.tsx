import { useSurfaceHost, type ValidityReview } from '../host';
import { useAppTranslation } from '../lib/i18n';
import type { SageEntry } from './model-types';

export function MemoryValidity({
  validity,
  revision,
  review,
  memoryId,
}: {
  validity: SageEntry['validity'];
  revision?: number | undefined;
  review?: ValidityReview | undefined;
  memoryId?: string | undefined;
}) {
  const { t } = useAppTranslation();
  const companion = useSurfaceHost().useCompanionReview(memoryId);
  if (!validity && (!companion || companion.observedRevision !== revision)) return null;
  const matching =
    revision !== undefined && review?.observedRevision === revision ? review : undefined;
  return (
    <section
      className="mt-3 space-y-2 rounded border border-border bg-muted/20 p-3 text-xs break-words"
      aria-label={t('activity:memoryValidity.title')}
    >
      <h3 className="font-semibold">{t('activity:memoryValidity.title')}</h3>
      <p className="whitespace-pre-wrap">{validity?.statement}</p>
      <p className="text-muted-foreground">{t('activity:memoryValidity.unknown')}</p>
      {companion && companion.observedRevision === revision && (
        <div className="space-y-1 border-t border-border pt-2">
          <h4 className="font-semibold">
            Memory Companion · {t(`activity:memoryValidity.${companion.verdict}`)}
          </h4>
          <p className="text-muted-foreground">{t('activity:memoryValidity.advisory')}</p>
          <p>
            {t('activity:memoryValidity.observed', {
              revision,
              at: new Date(companion.at).toLocaleString(),
            })}
          </p>
          <p>{companion.summary}</p>
          {(companion.evidence ?? []).map((e, i) => (
            <blockquote key={i} className="border-l-2 border-border pl-2">
              <span className="font-mono break-all">{e.path}</span>
              <p className="whitespace-pre-wrap">{e.quote}</p>
            </blockquote>
          ))}
        </div>
      )}
      {matching ? (
        <p className="text-muted-foreground">
          {t('activity:memoryValidity.observed', {
            revision: matching.observedRevision,
            at: new Date(matching.checkedAt).toLocaleString(),
          })}
        </p>
      ) : (
        <p className="text-muted-foreground">{t('activity:memoryValidity.unchecked')}</p>
      )}
      {(validity?.checks ?? []).map((check, i) => {
        const result = matching?.checks.find((c) => c.path === check.path && c.text === check.text);
        return (
          <div key={`${check.path}-${i}`} className="min-w-0 border-t border-border pt-2">
            <p className="font-mono break-all">{check.path}</p>
            <pre className="whitespace-pre-wrap break-all text-xs">{check.text}</pre>
            <span>
              {t(
                `activity:memoryValidity.${result?.status && result.status !== 'unknown' ? result.status : 'unknownCheck'}`,
              )}
            </span>
          </div>
        );
      })}
    </section>
  );
}
