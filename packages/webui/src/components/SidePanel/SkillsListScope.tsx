import { useAppTranslation } from '@/i18n';
import { looseTranslate } from '@/i18n/loose-translate';
import { cn } from '@/lib/utils';

/** Skill record + scope bucketing shared by the Skills side panel and its dialogs. */

export interface SkillInfo {
  name: string;
  description: string;
  version: string;
  source: string;
  sourceUrl: string;
  ref: string;
  path: string;
  trigger: string;
  scope: string[];
}

export type ScopeFilter = 'all' | 'project' | 'user' | 'bundled' | 'foreign';
export type ScopeBucket = 'project' | 'user' | 'bundled' | 'foreign';

/** Localized label for a scope bucket. Reuses skillDetail scope labels + skillsList.scopeForeign. */
export function scopeLabelFor(
  t: (k: string, opts?: Record<string, unknown>) => string,
  scope: ScopeBucket,
): string {
  switch (scope) {
    case 'project':
      return t('activity:skillDetail.scopeProject');
    case 'user':
      return t('activity:skillDetail.scopeGlobal');
    case 'bundled':
      return t('activity:skillDetail.scopeBundled');
    case 'foreign':
      return t('activity:skillsList.scopeForeign');
  }
}

/** Bucket a skill source for grouping. project/user/bundled map to themselves; everything else (.claude/*, extra) → foreign. */
export function bucketForSource(source: string | undefined): ScopeBucket {
  if (source === 'project' || source === 'user' || source === 'bundled') return source;
  return 'foreign';
}

export function ScopeBadge({ source }: { source: string }) {
  const { t } = useAppTranslation();
  const scope = bucketForSource(source);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
        scope === 'project' && 'border-success/25 bg-success/8 text-success',
        scope === 'user' && 'border-primary/25 bg-primary/10 text-primary',
        scope === 'bundled' && 'border-border/70 bg-muted/60 text-muted-foreground',
        scope === 'foreign' && 'border-warning/28 bg-warning/10 text-warning',
      )}
    >
      {scopeLabelFor(looseTranslate(t), scope)}
    </span>
  );
}
