/**
 * Shared formatting and rendering primitives for agent/fleet/session
 * dashboard components. Extracted from the duplicated helpers that
 * existed in AgentsPage.tsx, FleetMonitor.tsx, and FleetPanel.tsx.
 */

/** Format a USD cost with up to 4 decimal places. */
export function fmtCost(n?: number): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '$0.0000';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** Format a token count compactly: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function fmtTok(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Format elapsed milliseconds as a compact "Xs/Xm/Xh" string. */
export function fmtElapsed(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** Format elapsed from an ISO start timestamp to now as "Xs/Xm/Xh". */
export function fmtDuration(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return fmtElapsed(Date.now() - t);
}

/** Format a timestamp as relative "Xs/Xm/Xh ago". */
export function fmtAgo(iso?: string): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Short model label: "anthropic/claude-opus-4" → "claude-opus-4". */
export function shortModel(model?: string): string | undefined {
  if (!model) return undefined;
  return model.split('/').pop()?.slice(0, 22);
}

/** Color for a status LED. */
export function statusColor(status: string): string {
  switch (status) {
    case 'running':
    case 'active':
      return 'hsl(var(--success))';
    case 'streaming':
      return 'hsl(var(--primary))';
    case 'idle':
      return 'hsl(var(--muted-foreground))';
    case 'completed':
      return 'hsl(var(--muted-foreground))';
    case 'failed':
    case 'error':
      return 'hsl(var(--destructive))';
    case 'stopped':
    case 'offline':
      return 'hsl(var(--muted-foreground))';
    default:
      return 'hsl(var(--muted-foreground))';
  }
}

/** Compact sparkline from an array of numeric activity values (0–1). */
export function sparkline(values: number[], width = 40): string {
  if (values.length === 0) return '';
  const max = Math.max(1, ...values);
  const step = Math.max(1, Math.floor(values.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    sampled.push(values[i]!);
  }
  return sampled
    .map((v) => {
      const h = Math.round((v / max) * 4);
      return ' ▁▂▃▄▅▆▇█'[h] ?? '·';
    })
    .join('');
}
