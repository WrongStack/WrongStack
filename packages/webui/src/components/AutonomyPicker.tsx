import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { Activity, ArrowRightLeft, ChevronDown, Pause, Play } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────

export type AutonomyMode = 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';

export interface AutonomyOption {
  mode: AutonomyMode;
  /** Display label — left verbatim (autonomy mode names are domain terms). */
  /** i18n key under activity:autonomy.* for the description. */
  labelKey: string;
  descKey: string;
  icon: React.ReactNode;
}

const AUTONOMY_OPTIONS: AutonomyOption[] = [
  {
    mode: 'off',
    labelKey: 'labelOff',
    descKey: 'descOff',
    icon: <Pause className="h-3.5 w-3.5" />,
  },
  {
    mode: 'suggest',
    labelKey: 'labelSuggest',
    descKey: 'descSuggest',
    icon: <ArrowRightLeft className="h-3.5 w-3.5" />,
  },
  {
    mode: 'auto',
    labelKey: 'labelAuto',
    descKey: 'descAuto',
    icon: <Play className="h-3.5 w-3.5" />,
  },
  {
    mode: 'eternal',
    labelKey: 'labelEternal',
    descKey: 'descEternal',
    icon: <Activity className="h-3.5 w-3.5" />,
  },
  {
    mode: 'eternal-parallel',
    labelKey: 'labelEternalParallel',
    descKey: 'descEternalParallel',
    icon: <Activity className="h-3.5 w-3.5" />,
  },
];

// ── Component ──────────────────────────────────────────────────────────────

export interface AutonomyPickerProps {
  /** Current autonomy mode. */
  value: AutonomyMode;
  /** Called when the user picks a new mode. */
  onChange: (mode: AutonomyMode) => void;
  /** Extra class for the trigger button. */
  className?: string | undefined;
  /** If true, render as a compact chip instead of full button. */
  compact?: boolean | undefined;
}

export function AutonomyPicker({
  value,
  onChange,
  className,
  compact = false,
}: AutonomyPickerProps): React.ReactElement {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Esc
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const current = AUTONOMY_OPTIONS.find((o) => o.mode === value);

  const tone =
    value === 'eternal' || value === 'eternal-parallel'
      ? 'bg-destructive/15 text-destructive border-destructive/30'
      : value === 'auto'
        ? 'bg-warning/15 text-warning border-warning/30'
        : value === 'suggest'
          ? 'bg-info/15 text-info border-info/30'
          : 'bg-muted text-muted-foreground border-transparent';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium transition-colors hover:opacity-80',
          tone,
          className,
        )}
        title={t('activity:autonomy.titlePrefix', {
          label: current ? t(`activity:autonomy.${current.labelKey}`) : value,
        })}
      >
        {current?.icon}
        {!compact && (
          <span className="truncate max-w-[7rem]">
            {current ? t(`activity:autonomy.${current.labelKey}`) : value}
          </span>
        )}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 z-50 w-56 rounded-lg border bg-popover shadow-lg p-1">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b mb-1">
            {t('activity:autonomy.heading')}
          </div>
          {AUTONOMY_OPTIONS.map((opt) => (
            <button
              key={opt.mode}
              type="button"
              onClick={() => {
                onChange(opt.mode);
                setOpen(false);
              }}
              className={cn(
                'w-full flex items-start gap-2 px-3 py-2 rounded text-left transition-colors',
                value === opt.mode ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
              )}
            >
              <span className="mt-0.5 text-muted-foreground">{opt.icon}</span>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium">
                  {t(`activity:autonomy.${opt.labelKey}`)}
                </span>
                <p className="text-[10px] text-muted-foreground leading-snug">
                  {t(`activity:autonomy.${opt.descKey}`)}
                </p>
              </div>
              {value === opt.mode && (
                <span className="h-1.5 w-1.5 rounded-full bg-primary mt-2 shrink-0" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
