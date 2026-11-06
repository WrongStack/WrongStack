import type { ContextUsage } from './context-usage';
import { useDesktopText } from './desktop-i18n';
import './draft-counter.css';
import { displayLocale } from './display-dates';

/**
 * The WebUI's draft counter: characters, and for a long draft its rough token count (4
 * characters a token) and how full the context would be with it. Past 85% it warns, past 100% the
 * request would likely fail or compact.
 */
function draftEstimate(
  draft: string,
  context: Pick<ContextUsage, 'tokens' | 'max'>,
  t: (key: string, values: Record<string, string>) => string,
) {
  const tokens = Math.ceil(draft.length / 4);
  const long = draft.length >= 400;
  const percent =
    long && context.max > 0
      ? Math.round(((context.tokens + tokens + 64) / context.max) * 100)
      : undefined;
  const tone = percent === undefined ? '' : percent >= 100 ? 'over' : percent >= 85 ? 'tight' : '';
  const values = {
    tokens: tokens.toLocaleString(displayLocale()),
    percent: String(percent),
    max: context.max.toLocaleString(displayLocale()),
  };
  const title =
    percent === undefined
      ? long
        ? t('shellText.draft.estimate', values)
        : undefined
      : t(
          percent >= 100
            ? 'shellText.draft.over'
            : percent >= 85
              ? 'shellText.draft.tight'
              : 'shellText.draft.fits',
          values,
        );
  return {
    chars: draft.length,
    tokens: long ? (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)) : '',
    tone,
    title,
  };
}

export function DraftCounter({
  draft,
  context,
}: {
  draft: string;
  context: Pick<ContextUsage, 'tokens' | 'max'>;
}) {
  if (!draft) return null;
  const { t } = useDesktopText();
  const estimate = draftEstimate(draft, context, t);
  return (
    <span className={`draft-counter ${estimate.tone}`.trim()} title={estimate.title}>
      {estimate.chars.toLocaleString(displayLocale())}
      {estimate.tokens && <span> · {t('shellText.draftTokens', { count: estimate.tokens })}</span>}
    </span>
  );
}
