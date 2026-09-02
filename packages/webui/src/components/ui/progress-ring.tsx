import { useId } from 'react';
import { useAppTranslation } from '@/i18n';

/**
 * Circular progress ring with a primary→info gradient stroke.
 * Extracted from SddBoardView so kanban surfaces (verification dashboard,
 * decomposition flow) can reuse it. Gradient ids are instance-unique so
 * several rings can coexist on one page.
 */
export function ProgressRing({ pct }: { pct: number }): React.ReactElement {
  const { t } = useAppTranslation();
  const gradientId = useId();
  const r = 26;
  const c = 2 * Math.PI * r;
  const off = c - (Math.max(0, Math.min(100, pct)) / 100) * c;
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg
        viewBox="0 0 64 64"
        className="h-16 w-16 -rotate-90"
        role="img"
        aria-label={t('activity:progressring.progress')}
      >
        <circle cx="32" cy="32" r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={off}
          style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.16,1,0.3,1)' }}
        />
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" />
            <stop offset="100%" stopColor="hsl(var(--info))" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-sm font-bold text-foreground">
        {Math.round(pct)}%
      </div>
    </div>
  );
}
