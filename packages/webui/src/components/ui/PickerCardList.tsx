import { CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A single selectable option in a PickerCardList.
 */
interface PickerOption {
  id: string;
  label: string;
  /** Smaller text shown beside the label. */
  sublabel?: string | undefined;
  /** Badges/tags rendered under the label. */
  badges?: string[] | undefined;
  /** Right-aligned detail text (e.g. cost, context window). */
  detail?: string | undefined;
  /** If true, the detail is rendered as a highlighted value instead of muted. */
  detailHighlight?: boolean | undefined;
  /** Extra content shown on the far right (replaces the checkmark when selected). */
  rightContent?: ReactNode | undefined;
}

interface PickerCardListProps {
  options: PickerOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  className?: string;
  /** When true, show an explicit "None" row at the top (selectedId='' clears the picker). */
  showNone?: boolean | undefined;
  /** Label for the "None" row when showNone is true. */
  noneLabel?: string | undefined;
  /** When set, shows a dashed border message when options is empty. */
  emptyMessage?: string | undefined;
  /** Prevent selection while an async owner operation is in flight. */
  disabled?: boolean | undefined;
}

/**
 * Reusable card-based single-select list. Every SettingsPanel model/provider
 * picker duplicates this same `border rounded-lg p-3` + `hover:bg-muted` +
 * `border-primary ring-2 ring-primary/20` + `CheckCircle2` pattern. Use this
 * component instead of inlining it.
 *
 * Provider usage:
 * ```tsx
 * <PickerCardList
 *   options={[
 *     { id: 'openai', label: 'OpenAI', sublabel: 'openai', badges: ['chat'] },
 *     { id: 'anthropic', label: 'Anthropic', sublabel: 'anthropic' },
 *   ]}
 *   selectedId={localPrefs.refinerProvider}
 *   onSelect={(id) => syncPref('refinerProvider', id)}
 *   showNone
 *   noneLabel="Session provider"
 * />
 * ```
 */
export function PickerCardList({
  options,
  selectedId,
  onSelect,
  className,
  showNone,
  noneLabel,
  emptyMessage,
  disabled = false,
}: PickerCardListProps) {
  return (
    <div className={cn('space-y-1', className)}>
      {showNone && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect('')}
          className={cn(
            'w-full flex items-center justify-between p-3 rounded-lg border text-left transition-all',
            !selectedId
              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
              : 'border-border hover:bg-muted',
          )}
        >
          <span className="font-medium text-sm">{noneLabel ?? 'None'}</span>
          {!selectedId && <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />}
        </button>
      )}

      {options.length === 0 && emptyMessage && !showNone && (
        <p className="text-sm text-muted-foreground text-center py-4">{emptyMessage}</p>
      )}

      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(opt.id)}
          className={cn(
            'w-full flex items-center justify-between p-3 rounded-lg border text-left transition-all disabled:cursor-wait disabled:opacity-60',
            selectedId === opt.id
              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
              : 'border-border hover:bg-muted',
          )}
        >
          <div className="min-w-0 flex-1">
            <span className="font-medium text-sm">{opt.label}</span>
            {opt.sublabel && (
              <span className="text-xs text-muted-foreground ml-2">{opt.sublabel}</span>
            )}
            {opt.badges && opt.badges.length > 0 && (
              <div className="flex gap-2 mt-1 flex-wrap">
                {opt.badges.map((badge) => (
                  <span key={badge} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                    {badge}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="text-right shrink-0 ml-2">
            {opt.detail && (
              <div
                className={cn(
                  'text-xs',
                  opt.detailHighlight ? 'text-foreground font-medium' : 'text-muted-foreground',
                )}
              >
                {opt.detail}
              </div>
            )}
            {opt.rightContent ??
              (selectedId === opt.id && (
                <CheckCircle2 className="h-4 w-4 text-primary mt-1 ml-auto" />
              ))}
          </div>
        </button>
      ))}
    </div>
  );
}
