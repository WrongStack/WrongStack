import { AlertCircle, CheckCircle2, RotateCw, XCircle } from 'lucide-react';

export function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export function fmtRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const ms = d.getTime();
    if (Number.isNaN(ms)) return iso;
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'Just now';
    if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
    if (diff < 604800_000) return `${Math.round(diff / 86400_000)}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

export const LIFECYCLE_BADGE: Record<
  string,
  { label: string; cls: string; icon: typeof CheckCircle2 }
> = {
  open: {
    label: 'Open',
    cls: 'border-primary/30 bg-primary/10 text-foreground',
    icon: AlertCircle,
  },
  actioned: {
    label: 'Actioned',
    cls: 'border-warning/30 bg-warning/10 text-warning',
    icon: RotateCw,
  },
  completed: {
    label: 'Completed',
    cls: 'border-success/30 bg-success/10 text-success',
    icon: CheckCircle2,
  },
  skipped: { label: 'Skipped', cls: 'border-border bg-muted text-muted-foreground', icon: XCircle },
};

export const SEVERITY_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  critical: {
    bg: 'bg-destructive/10 border-destructive/30',
    text: 'text-destructive',
    dot: 'bg-destructive',
  },
  high: { bg: 'bg-warning/15 border-warning/40', text: 'text-warning', dot: 'bg-warning' },
  medium: { bg: 'bg-warning/10 border-warning/30', text: 'text-warning', dot: 'bg-warning' },
  low: { bg: 'bg-muted border-border', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
};
