import { useId } from 'react';
import { playCompletionChime } from '@/lib/chime';
import { cn } from '@/lib/utils';
import { useConfigStore, useUIStore } from '@/stores';

/**
 * One row in the Preferences section. Renders a label / hint pair on the
 * left and a small switch on the right.
 *
 * Three modes, checked in order:
 * 1. **controlled** — `value` is a boolean. Use it directly as the switch
 *    state and call `onChange` on toggle. This is the simplest pattern for
 *    any boolean preference you can read/write imperatively.
 * 2. **selector** — reads from useUIStore via a selector function, calls
 *    `onChange` on toggle. Best for UI-only state (compact mode, etc.).
 * 3. **configKey** — reads from useConfigStore by key, toggles the store
 *    directly. Only `soundOnComplete` is wired this way.
 */
export function PreferenceToggle({
  label,
  hint,
  selector,
  onChange,
  configKey,
  value,
  disabled,
}: {
  label: string;
  hint?: string | undefined;
  /** Blocks the switch while an in-flight write is reconciling. */
  disabled?: boolean | undefined;
  selector?: ((s: ReturnType<typeof useUIStore.getState>) => boolean) | null | undefined;
  onChange?: (() => void) | undefined;
  configKey?: 'soundOnComplete' | undefined;
  /** Controlled mode: pass the current boolean value directly. When
   *  provided the component ignores selector and configKey entirely. */
  value?: boolean | undefined;
}) {
  // Controlled mode wins when value is explicitly a boolean.
  const controlled = typeof value === 'boolean';
  const uiVal = useUIStore((s) => (selector ? selector(s) : false));
  const cfgVal = useConfigStore((s) => (configKey ? (s[configKey] as boolean) : false));
  const on = controlled ? value : selector ? uiVal : cfgVal;
  const handleToggle = () => {
    if (controlled) {
      onChange?.();
    } else if (selector) {
      onChange?.();
    } else if (configKey === 'soundOnComplete') {
      const next = !useConfigStore.getState().soundOnComplete;
      useConfigStore.getState().setSoundOnComplete(next);
      if (next) {
        playCompletionChime();
      }
    }
  };
  const switchId = useId();
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={switchId} className="text-sm font-medium">
          {label}
        </label>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <button
        type="button"
        id={switchId}
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={handleToggle}
        className={cn(
          'shrink-0 relative inline-flex h-5 w-9 rounded-full border transition-colors',
          on ? 'bg-primary border-primary' : 'bg-muted border-input hover:bg-muted/80',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full bg-background shadow transition-transform',
            on && 'translate-x-4',
          )}
        />
      </button>
    </div>
  );
}
