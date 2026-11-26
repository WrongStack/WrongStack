import { AlertTriangle, ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import type { ModelCandidate } from '@/hooks/useProviderModels';
import { useAppTranslation } from '@/i18n';
import { classifyRef } from '@/lib/fallback-ref';
import { cn } from '@/lib/utils';
import { ModelPicker } from './ModelPicker';

/**
 * FallbackEditor — ordered model fallback chain editor (add / remove / reorder).
 * Entries are stored as `provider/model` strings (parseable by the core fallback
 * extension). Reused by the run-config wizard, the board header, and global
 * settings. Inline only; no native dialogs.
 *
 * `knownModels` powers the per-row advisory that mirrors the `/fallback`
 * command's "not in saved model list — will still be tried" note; only a ref
 * with no model gets the inactive badge. When the caller is still loading
 * provider catalogues, pass `undefined` and every row stays unmarked.
 */
export function FallbackEditor({
  value,
  candidates,
  onChange,
  placeholder,
  emptyHint,
  knownModels,
}: {
  value: string[];
  candidates: ModelCandidate[];
  onChange: (next: string[]) => void;
  placeholder?: string | undefined;
  emptyHint?: string | undefined;
  /**
   * Set of `provider/model` strings currently allowed by the configured
   * providers (built via `buildKnownModelSet(useProviderModels())`).
   * Undefined or empty disables the inactive badge — useful while the
   * provider catalogue is still loading.
   */
  knownModels?: ReadonlySet<string> | undefined;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const remove = (i: number) => onChange(value.filter((_, k) => k !== i));
  const add = (model: string, provider: string) => {
    const ref = `${provider}/${model}`;
    if (!value.includes(ref)) onChange([...value, ref]);
  };

  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <ol className="space-y-1">
          {value.map((ref, i) => {
            const state = classifyRef(ref, knownModels);
            const rowTitle = state.active ? state.advisory : state.reason;
            return (
              <li
                key={`${ref}-${i}`}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                  !state.active
                    ? 'border-warning/60 bg-warning/10'
                    : state.advisory
                      ? 'border-warning/30 bg-muted'
                      : 'border-border bg-muted',
                )}
                title={rowTitle ?? undefined}
                data-testid={`fallback-row-${i}`}
                data-active={state.active ? 'true' : 'false'}
                data-inactive-reason={state.active ? undefined : state.reason}
                data-advisory={state.active ? state.advisory : undefined}
              >
                <span className="font-mono text-[10px] text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1 break-words font-mono text-foreground">{ref}</span>
                {!state.active && (
                  <span
                    className="flex items-center gap-1 rounded-sm bg-warning/15 px-1 py-0.5 text-[10px] font-medium text-foreground"
                    data-testid={`fallback-row-${i}-inactive-badge`}
                  >
                    <AlertTriangle className="h-2.5 w-2.5" />
                    {t('settings:fallbacks.inactive')}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  title={t('activity:fallback.moveUp')}
                >
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === value.length - 1}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  title={t('activity:fallback.moveDown')}
                >
                  <ArrowDown className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="text-muted-foreground hover:text-destructive"
                  title={t('common:action.remove')}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <ModelPicker
        candidates={candidates}
        placeholder={placeholder ?? t('activity:fallback.placeholder')}
        onPick={add}
      />
      {value.length === 0 && (
        <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Plus className="h-2.5 w-2.5" /> {emptyHint ?? t('activity:fallback.emptyHint')}
        </p>
      )}
    </div>
  );
}
