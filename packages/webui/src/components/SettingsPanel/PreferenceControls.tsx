import { useId } from 'react';

/** A labeled slider with current value display. */
export function PreferenceSlider({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  onChange,
  unit,
}: {
  label: string;
  hint?: string | undefined;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  unit?: string | undefined;
}) {
  const inputId = useId();
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <input
          id={inputId}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-24 h-1.5 accent-primary"
        />
        <span className="text-xs tabular-nums w-10 text-right text-muted-foreground" aria-hidden>
          {value}
          {unit ?? ''}
        </span>
      </div>
    </div>
  );
}

/** A labeled select dropdown. */
export function PreferenceSelect<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string | undefined;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  /** Blocks the select while an in-flight write is reconciling. */
  disabled?: boolean | undefined;
}) {
  const inputId = useId();
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <select
        id={inputId}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className="shrink-0 h-8 rounded-md border bg-background px-2 text-xs disabled:opacity-50"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
