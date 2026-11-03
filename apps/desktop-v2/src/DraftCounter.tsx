import type { ContextUsage } from './context-usage';
import './draft-counter.css';

/**
 * The WebUI's draft counter: characters, and for a long draft its rough token count (4
 * characters a token) and how full the context would be with it. Past 85% it warns, past 100% the
 * request would likely fail or compact.
 */
function draftEstimate(draft: string, context: Pick<ContextUsage, 'tokens' | 'max'>) {
  const tokens = Math.ceil(draft.length / 4);
  const long = draft.length >= 400;
  const percent =
    long && context.max > 0
      ? Math.round(((context.tokens + tokens + 64) / context.max) * 100)
      : undefined;
  const tone = percent === undefined ? '' : percent >= 100 ? 'over' : percent >= 85 ? 'tight' : '';
  const title =
    percent === undefined
      ? long
        ? `≈ ${tokens.toLocaleString()} tokens (4 characters a token)`
        : undefined
      : percent >= 100
        ? `Projected ${percent}% of the ${context.max.toLocaleString()}-token context: the request will likely fail or compact.`
        : percent >= 85
          ? `Projected ${percent}% of the ${context.max.toLocaleString()}-token context: getting tight.`
          : `≈ ${tokens.toLocaleString()} tokens · projected ${percent}% of the ${context.max.toLocaleString()}-token context.`;
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
  const estimate = draftEstimate(draft, context);
  return (
    <span className={`draft-counter ${estimate.tone}`.trim()} title={estimate.title}>
      {estimate.chars.toLocaleString()}
      {estimate.tokens && <span> · ≈{estimate.tokens} tokens</span>}
    </span>
  );
}
