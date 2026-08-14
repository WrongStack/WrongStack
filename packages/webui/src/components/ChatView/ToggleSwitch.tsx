import { cn } from '@/lib/utils';

export function ToggleSwitch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={onChange}
      className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/75 hover:text-foreground/80 transition-colors select-none"
    >
      <span
        className={cn(
          'relative inline-block h-3.5 w-6 rounded-full border transition-colors shrink-0',
          value ? 'bg-primary border-primary/60' : 'bg-muted/70 border-border/60',
        )}
      >
        <span
          className={cn(
            'absolute top-[1px] left-[1px] h-2.5 w-2.5 rounded-full bg-background shadow transition-transform',
            value && 'translate-x-2.5',
          )}
        />
      </span>
      <span>{label}</span>
    </button>
  );
}
