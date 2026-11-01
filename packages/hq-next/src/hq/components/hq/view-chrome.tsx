/**
 * The shared skeleton every view is built from: a padded column, a hero strip
 * with headline metrics, and titled sections.
 *
 * Views used to hand-roll this with a dozen `hq-screen-*` classes each, which
 * is exactly how the twelve surfaces drifted apart. One set of components
 * means one set of paddings, one type scale and one metric row.
 */
import type * as React from 'react';
import { cn } from '../../lib/utils.js';

export function Section({
  eyebrow,
  title,
  action,
  children,
  className,
}: {
  eyebrow?: string;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <section data-testid="view-section" className={cn('space-y-2', className)} aria-label={title}>
      <div className="flex items-end gap-2">
        <div className="space-y-0.5">
          {eyebrow !== undefined && (
            <span className="font-display text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
              {eyebrow}
            </span>
          )}
          <h3 className="font-display text-sm font-semibold leading-none">{title}</h3>
        </div>
        {action !== undefined && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}
