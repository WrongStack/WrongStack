import { Box, Text } from '../ink.js';
import type React from 'react';
import type { FleetEntry } from '../app-state.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  SectionLabel,
  truncatePanelText,
  useMonitorSize,
} from './monitor-shell.js';
import { fmtElapsed, renderProgress } from './status-bar.js';

function shortSessionId(sessionId: string): string {
  const leaf = sessionId.split('/').pop() ?? sessionId;
  return leaf.length > 12 ? `${leaf.slice(0, 12)}…` : leaf;
}

interface FleetMonitorProps {
  entries: Record<string, FleetEntry>;
  /** Fleet-wide accumulated cost. */
  totalCost: number;
  /** Fleet-wide token totals, when available. */
  totalTokens?: { input: number; output: number };
  /** Concurrency ceiling for the gauge. */
  maxConcurrent?: number | undefined;
  /** 1s clock tick so elapsed times + sparklines stay live. */
  nowTick: number;
  /** Active or completed collaborative debugging session. */
  collabSession?: {
    sessionId: string | null;
    bugCount: number;
    planCount: number;
    evalCount: number;
    overallVerdict: 'approve' | 'needs_revision' | 'reject' | null;
    timeline: Array<{ at: number; icon: string; color: string; text: string }>;
    startedAt: number | null;
  } | null;
}

const STATUS: Record<FleetEntry['status'], { icon: string; color: string }> = {
  idle: { icon: '○', color: theme.textMuted },
  running: { icon: '▶', color: theme.warn },
  success: { icon: '✓', color: theme.success },
  failed: { icon: '✗', color: theme.error },
  timeout: { icon: '⏱', color: theme.warn },
  stopped: { icon: '⊘', color: theme.textMuted },
};

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Bucket recent tool executions into a fixed number of time bins ending at
 * `now`, returning a per-bin count. Drives the per-agent activity sparkline
 * in the Agents (live) monitor; exported here because it was historically
 * defined alongside the fleet monitor.
 */
export function bucketActivity(
  recentTools: ReadonlyArray<{ at: number }>,
  now: number,
  bins = 12,
  binMs = 2000,
): number[] {
  const out = new Array<number>(bins).fill(0);
  const windowStart = now - bins * binMs;
  for (const t of recentTools) {
    if (t.at < windowStart || t.at > now) continue;
    let idx = Math.floor((t.at - windowStart) / binMs);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    out[idx] = (out[idx] ?? 0) + 1;
  }
  return out;
}

/** Render a numeric series as a unicode sparkline. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(1, ...values);
  return values
    .map((v) => {
      if (v <= 0) return SPARK[0];
      const idx = Math.min(SPARK.length - 1, Math.ceil((v / max) * (SPARK.length - 1)));
      return SPARK[idx];
    })
    .join('');
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtCost(n: number): string {
  if (n === 0) return '—';
  return `$${n.toFixed(4)}`;
}

/**
 * Compact `provider:model` label for the monitors. Strips any `provider/`
 * prefix from the model id and keeps it terminal-friendly. Returns '' when
 * neither is known (e.g. a leader entry before the first request resolves).
 * Shared by the Agents (Ctrl+G) and Fleet (Ctrl+F) monitors.
 */
export function fmtModelLabel(provider?: string, model?: string): string {
  if (!model && !provider) return '';
  const short = model
    ? model.includes('/')
      ? model.slice(model.lastIndexOf('/') + 1)
      : model
    : '?';
  return provider ? `${provider}:${short}` : short;
}

/**
 * Fleet orchestration dashboard (Ctrl+F). Concurrency gauge, fleet totals,
 * a compact one-line-per-agent table, and a recent-events timeline. Live
 * per-agent context (current tool / streaming tail) lives in the Agents
 * monitor (Ctrl+G) — this view is for "how the fleet is doing overall".
 *
 * Prunes terminal agents older than TERMINAL_TTL_MS from the table and
 * timeline to prevent unbounded growth in long-running sessions.
 */
export function FleetMonitor({
  entries,
  totalCost,
  totalTokens,
  maxConcurrent = 4,
  nowTick,
  collabSession,
}: FleetMonitorProps): React.ReactElement {
  const size = useMonitorSize();
  const wide = size.columns >= 100;
  /** Terminal agents older than this are excluded from table + timeline. */
  const TERMINAL_TTL_MS = 5 * 60_000; // 5 minutes

  const all = Object.values(entries);

  // Counts from ALL entries (accurate totals).
  const running = all.filter((e) => e.status === 'running');
  const idle = all.filter((e) => e.status === 'idle').length;
  const done = all.filter((e) => e.status === 'success').length;
  const failed = all.filter((e) => e.status === 'failed' || e.status === 'timeout').length;

  // Table: live agents + recently-finished terminal agents only. This
  // prevents old terminal entries from bloating the render loop.
  const recent = all.filter((e) => {
    if (e.status === 'running' || e.status === 'idle') return true;
    return nowTick - e.lastEventAt < TERMINAL_TTL_MS;
  });

  const concurrencyRatio = maxConcurrent > 0 ? running.length / maxConcurrent : 0;

  // Sort: running → idle → recently-finished (newest first).
  const ordered = [...recent].sort((a, b) => {
    const ra = a.status === 'running' ? 0 : a.status === 'idle' ? 1 : 2;
    const rb = b.status === 'running' ? 0 : b.status === 'idle' ? 1 : 2;
    if (ra !== rb) return ra - rb;
    if (ra === 2) return b.lastEventAt - a.lastEventAt;
    return a.startedAt - b.startedAt;
  });
  const collabRows = collabSession ? 3 + Math.min(3, collabSession.timeline.length) : 0;
  const agentLimit = Math.max(
    1,
    Math.min(8, Math.floor((size.contentRows - collabRows - 6) / (wide ? 1 : 2))),
  );
  const shown = ordered.slice(0, agentLimit);
  const overflow = ordered.length - shown.length;

  // Stale terminal count for the user so they know we pruned.
  const staleTerminal = all.length - recent.length;

  // Timeline: only from recent agents, newest first.
  const events: Array<{ at: number; icon: string; color: string; text: string }> = [];
  for (const e of recent) {
    events.push({ at: e.startedAt, icon: '●', color: theme.accent, text: `${e.name} spawned` });
    if (e.status !== 'running' && e.status !== 'idle') {
      const s = STATUS[e.status];
      const reason = e.failureReason ? ` [${e.failureReason}]` : '';
      events.push({
        at: e.lastEventAt,
        icon: s.icon,
        color: s.color,
        text: `${e.name} ${e.status} (${e.toolCalls}t)${reason}`,
      });
    }
    if (e.budgetWarning) {
      events.push({
        at: e.budgetWarning.at,
        icon: '⚡',
        color: theme.warn,
        text: `${e.name} ${e.budgetWarning.kind} ${e.budgetWarning.used}/${e.budgetWarning.limit} — extending`,
      });
    }
  }
  events.sort((a, b) => b.at - a.at);
  const timelineLimit = Math.max(
    0,
    Math.min(5, size.contentRows - collabRows - shown.length * (wide ? 1 : 2) - 7),
  );
  const timeline = events.slice(0, timelineLimit);

  // Collab verdict chip color
  const VERDICT_COLOR: Record<string, string> = {
    approve: theme.success,
    needs_revision: theme.warn,
    reject: theme.error,
  };

  return (
    <MonitorShell
      accent={theme.monitor.fleet}
      icon={glyphs.fleet}
      title="FLEET CONTROL"
      kicker={wide ? 'orchestration overview' : undefined}
      right={
        <Text>
          <Text color={theme.warn}>▶ {running.length}</Text>
          <Text color={theme.textMuted}> ○ {idle}</Text>
          <Text color={theme.success}> ✓ {done}</Text>
          {failed > 0 ? <Text color={theme.error}> ✗ {failed}</Text> : null}
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="F2" label="close" color={theme.monitor.fleet} />
          <Text color={theme.textMuted}>/fleet dispatch · /fleet status</Text>
          {staleTerminal > 0 ? <Text color={theme.textMuted}>{staleTerminal} archived</Text> : null}
        </Box>
      }
    >
      <Box marginTop={1} gap={1}>
        <Text color={theme.textMuted}>CAPACITY</Text>
        <Text color={theme.monitor.fleet}>
          [{renderProgress(concurrencyRatio, wide ? 16 : 10)}]
        </Text>
        <Text color={theme.textSecondary}>
          {running.length}/{maxConcurrent}
        </Text>
        {totalTokens ? (
          <Text color={theme.textMuted}>
            {'  '}
            {fmtTokens(totalTokens.input)}↑ {fmtTokens(totalTokens.output)}↓
          </Text>
        ) : null}
        <Box flexGrow={1} />
        <Text color={theme.success} bold>
          {fmtCost(totalCost)}
        </Text>
      </Box>

      {collabSession ? (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Box gap={1}>
            <Text bold color={theme.monitor.agents}>
              ⚡ COLLAB
            </Text>
            {collabSession.sessionId ? (
              <Text color={theme.textMuted}>{shortSessionId(collabSession.sessionId)}</Text>
            ) : null}
            <Box flexGrow={1} />
            <Text color={theme.error}>bugs {collabSession.bugCount}</Text>
            <Text color={theme.warn}> plans {collabSession.planCount}</Text>
            <Text color={theme.accent}> reviews {collabSession.evalCount}</Text>
            {collabSession.overallVerdict ? (
              <Text bold color={VERDICT_COLOR[collabSession.overallVerdict] ?? theme.textPrimary}>
                {'  '}
                {collabSession.overallVerdict.replace('_', ' ').toUpperCase()}
              </Text>
            ) : null}
          </Box>
          {collabSession.timeline.length > 0 ? (
            <Box flexDirection="column">
              {collabSession.timeline.slice(0, 3).map((ev, i) => (
                <Box key={`${ev.at}-${i}`} gap={1}>
                  <Text color={theme.textMuted}>
                    {`${fmtElapsed(Math.max(0, nowTick - ev.at))} ago`.padEnd(9)}
                  </Text>
                  <Text {...(ev.color ? { color: ev.color } : {})}>{ev.icon}</Text>
                  <Text color={theme.textMuted}>
                    {truncatePanelText(ev.text, size.contentWidth - 16)}
                  </Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      ) : null}

      {shown.length === 0 ? (
        <EmptyPanelState
          icon="◇"
          title="Fleet is ready"
          detail="Dispatch a task with /fleet dispatch or create a worker with /fleet spawn."
          accent={theme.monitor.fleet}
        />
      ) : null}

      {shown.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <SectionLabel>
            WORKERS {shown.length}/{ordered.length}
          </SectionLabel>
          {shown.map((e) => {
            const s = STATUS[e.status];
            const elapsed =
              e.status === 'running'
                ? fmtElapsed(Math.max(0, nowTick - e.startedAt))
                : fmtElapsed(Math.max(0, nowTick - e.lastEventAt)) + ' ago';
            const model = fmtModelLabel(e.provider, e.model) || '—';
            const ltCtx =
              e.ctxPct !== undefined
                ? `L${e.iterations} ${e.toolCalls}t ${Math.min(100, Math.max(0, Math.round(e.ctxPct * 100)))}%`
                : `L${e.iterations} ${e.toolCalls}t`;
            return (
              <Box key={e.id} flexDirection="column">
                <Box>
                  <Text color={s.color} bold>
                    {s.icon} {truncatePanelText(e.name, wide ? 16 : 20).padEnd(wide ? 16 : 20)}
                  </Text>
                  {wide ? (
                    <Text color={theme.textMuted}>{truncatePanelText(model, 18).padEnd(18)}</Text>
                  ) : null}
                  <Text color={s.color}>{e.status.padEnd(9)}</Text>
                  <Text color={theme.textMuted}>
                    {ltCtx.padEnd(12).slice(0, 12)} {elapsed}
                  </Text>
                  <Box flexGrow={1} />
                  <Text color={theme.warn}>{fmtCost(e.cost)}</Text>
                  {e.extensions && e.extensions > 0 ? (
                    <Text color={theme.warn}> ⚡×{e.extensions}</Text>
                  ) : null}
                </Box>
                {!wide ? (
                  <Text color={theme.textMuted}>
                    {' '}
                    {model} · {elapsed}
                  </Text>
                ) : null}
              </Box>
            );
          })}
          {overflow > 0 ? <Text color={theme.textMuted}> ↓ {overflow} more workers</Text> : null}
        </Box>
      ) : null}

      {timeline.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <SectionLabel>RECENT SIGNALS</SectionLabel>
          {timeline.map((ev, i) => (
            <Box key={`${ev.at}-${i}`} gap={1}>
              <Text color={theme.textMuted}>
                {`${fmtElapsed(Math.max(0, nowTick - ev.at))} ago`.padEnd(9)}
              </Text>
              <Text color={ev.color}>{ev.icon}</Text>
              <Text color={theme.textMuted}>
                {truncatePanelText(ev.text, size.contentWidth - 16)}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </MonitorShell>
  );
}
