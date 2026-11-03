import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';

export function columnTitle(board: KanbanBoard | null, columnId: string): string {
  return board?.columns.find((c) => c.id === columnId)?.title ?? columnId;
}

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-2 py-1.5">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xs font-medium">{value}</div>
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
      />
    </label>
  );
}

export function SelectField({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

export function priorityClass(priority: KanbanTask['priority']): string {
  const base = 'rounded px-1.5 py-0.5';
  if (priority === 'critical') return `${base} bg-destructive/10 text-destructive`;
  if (priority === 'high') return `${base} bg-warning/10 text-warning`;
  if (priority === 'low') return `${base} bg-muted text-muted-foreground`;
  return `${base} bg-info/10 text-info`;
}
