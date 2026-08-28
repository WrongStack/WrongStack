/**
 * CronJobsMonitor — F-key panel showing all scheduled cron jobs.
 *
 * Follows the same pattern as ProcessListMonitor:
 * - 1s tick for live elapsed times + data refresh
 * - MonitorShell wrapper for consistent chrome
 * - panelWindow for scrollable list
 * - Keyboard navigation (↑↓ PgUp/PgDn Home/End)
 * - Confirmation prompt for cancel action
 *
 * Data source: `getCronJobs` callback wired to the agent's `cron_list` tool.
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text, useInput } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
  useMonitorSize,
  usePanelShortcutsEnabled,
} from './monitor-shell.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CronJobView {
  name: string;
  intervalMs: number;
  action: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string;
  runCount: number;
  overdue: boolean;
}

export interface CronListResult {
  ok: boolean;
  count: number;
  maxConcurrent: number;
  jobs: CronJobView[];
  error?: string | undefined;
}

interface CronJobsMonitorProps {
  /** Async callback that returns the current cron list (wired to cron_list tool). */
  getCronJobs: () => Promise<CronListResult>;
  onCancel?: ((name: string) => Promise<string | null>) | undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = Date.now();
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);

  if (abs < 60_000) return diff >= 0 ? '<1m' : '<1m ago';
  if (abs < 3_600_000) {
    const mins = Math.round(abs / 60_000);
    return diff >= 0 ? `${mins}m` : `${mins}m ago`;
  }
  if (abs < 86_400_000) {
    const hrs = Math.round(abs / 3_600_000);
    return diff >= 0 ? `${hrs}h` : `${hrs}h ago`;
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Component ──────────────────────────────────────────────────────────────

export function CronJobsMonitor({
  getCronJobs,
  onCancel,
}: CronJobsMonitorProps): React.ReactElement {
  const size = useMonitorSize();
  // Monotonic tick incremented every second — drives re-renders + re-fetches
  const [tick, setTick] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [snapshot, setSnapshot] = useState<CronListResult | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  // 1s interval for live elapsed-time updates + data refresh
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Re-fetch cron data on every tick
  useEffect(() => {
    let cancelled = false;
    getCronJobs()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setSnapshot(result);
          setFetchError(null);
        } else {
          setFetchError(result.error ?? 'Unknown error');
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFetchError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [getCronJobs, tick]);

  const jobs = snapshot?.jobs ?? [];
  const count = snapshot?.count ?? 0;
  const maxConcurrent = snapshot?.maxConcurrent ?? 0;

  // Clamp selection when the list shrinks
  const safeIndex = Math.min(selectedIndex, Math.max(0, jobs.length - 1));
  useEffect(
    () => setSelectedIndex((v) => Math.min(v, Math.max(0, jobs.length - 1))),
    [jobs.length],
  );

  const overdueCount = jobs.filter((j) => j.overdue).length;
  const enabledCount = jobs.filter((j) => j.enabled).length;
  const totalRuns = jobs.reduce((s, j) => s + j.runCount, 0);

  const visibleLimit = Math.max(2, size.contentRows - 4);
  const pw = panelWindow(jobs.length, safeIndex, visibleLimit);
  const visible = jobs.slice(pw.start, pw.end);
  const pageSize = visibleLimit;

  // Column width budget
  const nameWidth = Math.max(8, Math.min(24, Math.floor(size.contentWidth * 0.22)));
  const intervalWidth = 9;
  const runsWidth = 5;
  const nextWidth = Math.max(8, Math.floor(size.contentWidth * 0.14));
  const lastWidth = nextWidth;
  const actionWidth = Math.max(
    6,
    size.contentWidth - nameWidth - intervalWidth - runsWidth - nextWidth - lastWidth - 14,
  );

  const shortcutsEnabled = usePanelShortcutsEnabled();
  useInput((input, key) => {
    if (confirmCancel) {
      if (input.toLowerCase() === 'y') {
        const name = confirmCancel;
        setConfirmCancel(null);
        void onCancel?.(name).then((error) => {
          if (error) setFetchError(error);
          else setTick((value) => value + 1);
        });
      } else if (input.toLowerCase() === 'n' || key.escape) {
        setConfirmCancel(null);
      }
      return;
    }
    // Navigation
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(jobs.length - 1, prev + 1));
    } else if (key.pageUp) {
      setSelectedIndex((prev) => Math.max(0, prev - pageSize));
    } else if (key.pageDown) {
      setSelectedIndex((prev) => Math.min(jobs.length - 1, prev + pageSize));
    } else if (key.home || (shortcutsEnabled && ((key.ctrl && input === 'a') || input === 'g'))) {
      setSelectedIndex(0);
    } else if (key.end || (shortcutsEnabled && ((key.ctrl && input === 'e') || input === 'G'))) {
      setSelectedIndex(Math.max(0, jobs.length - 1));
    } else if (input.toLowerCase() === 'x' && onCancel) {
      const job = jobs[safeIndex];
      if (job) setConfirmCancel(job.name);
    }
    // Every other key falls through to the app's keyboard handler
  });

  const jobColor = (job: CronJobView): string => {
    if (!job.enabled) return theme.textMuted;
    if (job.overdue) return theme.error;
    return theme.success;
  };

  const jobGlyph = (job: CronJobView): string => {
    if (!job.enabled) return glyphs.pending;
    if (job.overdue) return glyphs.warning;
    return glyphs.running;
  };

  return (
    <MonitorShell
      accent={theme.accent}
      icon={glyphs.clock}
      title="CRON JOBS"
      kicker={size.columns >= 90 ? 'scheduled tasks' : undefined}
      right={
        <Text>
          <Text color={enabledCount > 0 ? theme.success : theme.textMuted} bold>
            {'●'} {enabledCount}
          </Text>
          <Text color={theme.textMuted}> / {count} jobs</Text>
          {overdueCount > 0 ? (
            <Text color={theme.error}>
              {' '}
              {'●'} {overdueCount} overdue
            </Text>
          ) : null}
          {totalRuns > 0 ? <Text color={theme.textMuted}> · {totalRuns} runs</Text> : null}
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="↑↓" label="select" color={theme.accent} />
          <KeyCap keyName="PgUp/Dn" label="page" color={theme.accent} />
          {onCancel ? <KeyCap keyName="x" label="cancel job" color={theme.error} /> : null}
          <KeyCap keyName="Esc" label="close" color={theme.accent} />
        </Box>
      }
    >
      {/* Error banner */}
      {fetchError ? (
        <Box marginTop={1}>
          <Text color={theme.error}>⚠ {fetchError}</Text>
        </Box>
      ) : null}
      {confirmCancel ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>Cancel “{confirmCancel}”? y confirm · n cancel</Text>
        </Box>
      ) : null}

      {/* Summary line */}
      {jobs.length > 0 ? (
        <Box marginTop={1}>
          <Text color={theme.textMuted}>
            max {maxConcurrent} concurrent · {totalRuns} total runs
          </Text>
        </Box>
      ) : null}

      {/* Empty state */}
      {jobs.length === 0 && !fetchError ? (
        <EmptyPanelState
          icon={glyphs.clock}
          title="No cron jobs"
          detail="Schedule one with cron_schedule."
          accent={theme.accent}
        />
      ) : null}

      {pw.above > 0 ? <Text color={theme.textMuted}> ↑ {pw.above} earlier jobs</Text> : null}

      {/* Job list */}
      {visible.map((job, i) => {
        const isSelected = pw.start + i === safeIndex;
        const c = jobColor(job);
        const g = jobGlyph(job);
        const name = truncatePanelText(job.name, nameWidth);
        const interval = fmtInterval(job.intervalMs);
        const runs = String(job.runCount).padStart(runsWidth);
        const next = fmtTime(job.nextRun);
        const last = fmtTime(job.lastRun);
        const action = truncatePanelText(job.action, actionWidth);

        return (
          <Box key={job.name} flexDirection="row">
            <Text color={isSelected ? theme.accent : theme.textMuted}>
              {isSelected ? '› ' : '  '}
            </Text>
            <Text color={c}>{g} </Text>
            <Text color={isSelected ? theme.textPrimary : c} bold={isSelected}>
              {name}
            </Text>
            <Text color={theme.textMuted}> {interval}</Text>
            <Text color={theme.textMuted}> {runs}</Text>
            {nextWidth >= 8 ? <Text color={theme.textMuted}> {next}</Text> : null}
            {lastWidth >= 8 ? <Text color={theme.textMuted}> {last}</Text> : null}
            <Box flexGrow={1} />
            {actionWidth >= 6 ? <Text color={theme.textMuted}>{action}</Text> : null}
          </Box>
        );
      })}

      {pw.below > 0 ? <Text color={theme.textMuted}> ↓ {pw.below} more jobs</Text> : null}
    </MonitorShell>
  );
}
