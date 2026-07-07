import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import type { ModelCandidate } from '@/hooks/useProviderModels';
import { useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { ModelPicker } from './ModelPicker';

/**
 * FallbackEditor — ordered model fallback chain editor (add / remove / reorder).
 * Entries are stored as `provider/model` strings (parseable by the core fallback
 * extension). Reused by the run-config wizard, the board header, and global
 * settings. Inline only; no native dialogs.
 */
export function FallbackEditor({
  value,
  candidates,
  onChange,
  placeholder,
  emptyHint,
}: {
  value: string[];
  candidates: ModelCandidate[];
  onChange: (next: string[]) => void;
  placeholder?: string | undefined;
  emptyHint?: string | undefined;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const [manualRef, setManualRef] = useState('');
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
  const addManual = () => {
    const ref = manualRef.trim().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');
    if (!ref) return;
    if (!value.includes(ref)) onChange([...value, ref]);
    setManualRef('');
  };

  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <ol className="space-y-1">
          {value.map((ref, i) => (
            <li
              key={`${ref}-${i}`}
              className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs"
            >
              <span className="font-mono text-[10px] text-muted-foreground">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-foreground">{ref}</span>
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
          ))}
        </ol>
      )}
      <ModelPicker candidates={candidates} placeholder={placeholder ?? t('activity:fallback.placeholder')} onPick={add} />
      <div className="flex gap-1.5">
        <input
          value={manualRef}
          onChange={(e) => setManualRef(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addManual();
          }}
          placeholder={t('activity:fallback.manualPlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={addManual}
          className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted"
          title={t('activity:fallback.addTitle')}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {value.length === 0 && (
        <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Plus className="h-2.5 w-2.5" /> {emptyHint ?? t('activity:fallback.emptyHint')}
        </p>
      )}
    </div>
  );
}
