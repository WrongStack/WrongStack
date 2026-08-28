/**
 * Shared SDD design system — the single source of truth for status/priority
 * visuals and small formatters across every SDD surface (flow graph, kanban,
 * task drawer, activity feed, board header). Keeping these here instead of
 * re-declaring per component prevents the colours/labels/icons from drifting
 * apart as the views evolve.
 */
import {
  AlertTriangle,
  Ban,
  Brain,
  Check,
  CircleDot,
  GitMerge,
  Layers,
  Loader2,
  type LucideIcon,
  Play,
  RotateCcw,
  ShieldAlert,
  Split,
  X,
} from 'lucide-react';

type SddStatus =
  | 'pending'
  | 'queued'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'failed'
  | 'completed'
  | 'cancelled';

interface SddStatusStyle {
  /** Short label, e.g. "Running". */
  label: string;
  /** Lucide icon for the status. */
  icon: LucideIcon;
  /** True for the running state (drives spin + glow). */
  spin?: boolean;
  /** Tailwind text-colour class. */
  text: string;
  /** Tailwind border+bg ring for chips/badges. */
  ring: string;
  /** Tailwind background class for a small status dot. */
  dot: string;
  /** CSS color string for React Flow edges/minimap, which cannot take Tailwind classes. */
  hex: string;
}

export const SDD_STATUS: Record<SddStatus, SddStatusStyle> = {
  pending: {
    label: 'Pending',
    icon: CircleDot,
    text: 'text-muted-foreground',
    ring: 'border-border/70 bg-muted/45',
    dot: 'bg-muted-foreground',
    hex: 'hsl(var(--muted-foreground))',
  },
  queued: {
    label: 'Ready',
    icon: CircleDot,
    text: 'text-primary',
    ring: 'border-primary/35 bg-primary/10',
    dot: 'bg-primary',
    hex: 'hsl(var(--primary))',
  },
  in_progress: {
    label: 'Running',
    icon: Loader2,
    spin: true,
    text: 'text-warning',
    ring: 'border-warning/45 bg-warning/10',
    dot: 'bg-warning',
    hex: 'hsl(var(--warning))',
  },
  blocked: {
    label: 'Blocked',
    icon: CircleDot,
    text: 'text-destructive',
    ring: 'border-destructive/30 bg-destructive/10',
    dot: 'bg-destructive',
    hex: 'hsl(var(--destructive))',
  },
  review: {
    label: 'Review',
    icon: CircleDot,
    text: 'text-primary',
    ring: 'border-primary/35 bg-primary/10',
    dot: 'bg-primary',
    hex: 'hsl(var(--info))',
  },
  failed: {
    label: 'Failed',
    icon: X,
    text: 'text-destructive',
    ring: 'border-destructive/45 bg-destructive/10',
    dot: 'bg-destructive',
    hex: 'hsl(var(--destructive))',
  },
  completed: {
    label: 'Done',
    icon: Check,
    text: 'text-success',
    ring: 'border-success/35 bg-success/10',
    dot: 'bg-success',
    hex: 'hsl(var(--success))',
  },
  cancelled: {
    label: 'Cancelled',
    icon: Ban,
    text: 'text-muted-foreground',
    ring: 'border-border/70 bg-muted/45',
    dot: 'bg-muted-foreground',
    hex: 'hsl(var(--muted-foreground))',
  },
};

export function statusStyle(s: string): SddStatusStyle {
  return SDD_STATUS[s as SddStatus] ?? SDD_STATUS.pending;
}

type SddPriority = 'critical' | 'high' | 'medium' | 'low';

export const SDD_PRIORITY: Record<SddPriority, { text: string; chip: string }> = {
  critical: {
    text: 'text-destructive',
    chip: 'bg-destructive/10 text-destructive',
  },
  high: {
    text: 'text-warning',
    chip: 'bg-warning/12 text-warning',
  },
  medium: {
    text: 'text-primary',
    chip: 'bg-primary/10 text-primary',
  },
  low: {
    text: 'text-muted-foreground',
    chip: 'bg-muted text-muted-foreground',
  },
};

export function priorityStyle(p: string) {
  return SDD_PRIORITY[p as SddPriority] ?? SDD_PRIORITY.medium;
}

/** Run-level status badge styles (board header). */
export const SDD_RUN_STATUS: Record<string, string> = {
  running: 'border-primary/35 bg-primary/10 text-primary',
  paused: 'border-warning/35 bg-warning/10 text-warning',
  stopped: 'border-border/70 bg-muted text-muted-foreground',
  completed: 'border-success/35 bg-success/10 text-success',
  failed: 'border-destructive/35 bg-destructive/10 text-destructive',
  deadlocked: 'border-destructive/35 bg-destructive/10 text-destructive',
  idle: 'border-border bg-muted text-muted-foreground',
};

/** Deterministic palette for agent avatars (indexed by roster position). */
export const SDD_AGENT_COLORS = [
  'bg-warning',
  'bg-primary',
  'bg-success',
  'bg-destructive',
  'bg-secondary',
  'bg-muted-foreground',
  'bg-accent',
];

/** Activity-feed entry kinds → icon + colour. */
export const SDD_FEED_KIND: Record<string, { icon: LucideIcon; color: string }> = {
  started: { icon: Play, color: 'text-warning' },
  completed: { icon: Check, color: 'text-success' },
  failed: { icon: X, color: 'text-destructive' },
  retrying: { icon: RotateCcw, color: 'text-warning' },
  wave: { icon: Layers, color: 'text-primary' },
  deadlock: { icon: AlertTriangle, color: 'text-destructive' },
  verification_failed: { icon: ShieldAlert, color: 'text-destructive' },
  conflict: { icon: GitMerge, color: 'text-warning' },
  split: { icon: Split, color: 'text-primary' },
  supervisor: { icon: Brain, color: 'text-primary' },
};

// ── formatters ────────────────────────────────────────────────────────────

/** Two-letter avatar initials from a worker name. */
export function agentInitials(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || '·';
}

/** Compact duration, e.g. "2m 5s" / "12s". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Compact relative age, e.g. "5s" / "3m" / "2h". */
export function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
