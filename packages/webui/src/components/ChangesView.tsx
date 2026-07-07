/**
 * ChangesView — the main-pane diff surface for the Changes (source-control)
 * activity. The file list lives in the SidePanel (ChangesPanel); selecting a
 * row populates the git-changes store, and this view renders the resolved
 * before/after content through the shared DiffView.
 */

import { Columns2, FileDiff, Loader2, Rows3 } from 'lucide-react';
import { useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { useGitChangesStore } from '@/stores';
import { cn } from '@/lib/utils';
import { DiffView } from './DiffView';
import { MonacoDiffView } from './MonacoDiffView';

export function ChangesView({ className }: { className?: string }) {
  const { t } = useAppTranslation();
  const selectedPath = useGitChangesStore((s) => s.selectedPath);
  const diff = useGitChangesStore((s) => s.diff);
  const loadingDiff = useGitChangesStore((s) => s.loadingDiff);
  // Unified = lightweight read-only LCS diff; Edit = Monaco side-by-side with
  // an editable working-tree pane that can be applied back to disk.
  const [mode, setMode] = useState<'unified' | 'edit'>('unified');

  if (!selectedPath) {
    return (
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 items-center justify-center bg-[hsl(var(--surface-2)/0.45)] p-4',
          className,
        )}
      >
        <div className="ws-surface flex max-w-md flex-col items-center gap-3 rounded-xl p-6 text-center text-muted-foreground">
          <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileDiff className="h-6 w-6" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-foreground">Source changes</h2>
            <p className="mt-1 text-sm">{t('activity:changes.selectPrompt')}</p>
          </div>
        </div>
      </div>
    );
  }

  const canEdit = diff && !diff.error && !diff.binary && !diff.tooLarge;

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[hsl(var(--surface-2)/0.45)] p-3',
        className,
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/75 shadow-sm">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase text-muted-foreground">
              Source control
            </div>
            <div className="truncate font-mono text-xs text-foreground" title={selectedPath}>
              {selectedPath}
            </div>
          </div>
          {canEdit && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setMode('unified')}
                title={t('activity:changes.unifiedTitle')}
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs transition-colors',
                  mode === 'unified'
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                <Rows3 className="h-3.5 w-3.5" /> {t('activity:changes.unified')}
              </button>
              <button
                type="button"
                onClick={() => setMode('edit')}
                title={t('activity:changes.editTitle')}
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs transition-colors',
                  mode === 'edit'
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                <Columns2 className="h-3.5 w-3.5" /> {t('activity:changes.edit')}
              </button>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {loadingDiff || !diff ? (
            <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('activity:changes.loadingDiff')}
            </div>
          ) : diff.error ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-destructive">
              {diff.error}
            </div>
          ) : diff.binary ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
              {t('activity:changes.binary')}
            </div>
          ) : diff.tooLarge ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
              {t('activity:changes.tooLarge')}
            </div>
          ) : mode === 'edit' ? (
            <MonacoDiffView
              key={diff.path}
              path={diff.path}
              oldText={diff.oldText ?? ''}
              newText={diff.newText ?? ''}
            />
          ) : (
            <DiffView oldText={diff.oldText} newText={diff.newText} caption={diff.path} fill />
          )}
        </div>
      </div>
    </div>
  );
}
