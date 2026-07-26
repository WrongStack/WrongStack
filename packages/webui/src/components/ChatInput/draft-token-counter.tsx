import { cn } from '@/lib/utils';

export function DraftTokenCounter({
  input,
  lastInputTokens,
  maxContext,
}: {
  input: string;
  lastInputTokens: number;
  maxContext: number;
}) {
  if (input.length === 0) return null;

  const showTokens = input.length >= 400;
  const estTokens = Math.ceil(input.length / 4);
  let tone = 'text-muted-foreground';
  let title: string | undefined;

  if (maxContext > 0 && showTokens) {
    const projected = lastInputTokens + estTokens + 64;
    const pct = (projected / maxContext) * 100;
    if (pct >= 100) {
      tone = 'text-destructive font-medium';
      title = `Projected ${Math.round(pct)}% of ${maxContext.toLocaleString()} ctx — will likely error or compact.`;
    } else if (pct >= 85) {
      tone = 'text-warning font-medium';
      title = `Projected ${Math.round(pct)}% of ${maxContext.toLocaleString()} ctx — getting tight.`;
    } else {
      title = `≈ ${estTokens.toLocaleString()} tokens · projected ${Math.round(pct)}% of ${maxContext.toLocaleString()} ctx.`;
    }
  } else if (showTokens) {
    title = `≈ ${estTokens.toLocaleString()} tokens (4-char heuristic)`;
  }

  return (
    <span className={cn('absolute bottom-1.5 right-12 text-xs tabular-nums', tone)} title={title}>
      {input.length}
      {showTokens && (
        <span className="ml-1 opacity-70">
          · ≈{estTokens >= 1000 ? `${(estTokens / 1000).toFixed(1)}k` : estTokens}t
        </span>
      )}
    </span>
  );
}
