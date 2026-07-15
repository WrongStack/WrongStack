import { Box, Text, useInput } from '../ink.js';
import { useEffect, useState } from 'react';
import type React from 'react';
import { getProcessRegistry } from '@wrongstack/tools';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
  useMonitorSize,
} from './monitor-shell.js';

type PendingProcessAction =
  | { kind: 'kill'; pid: number; label: string }
  | { kind: 'force'; pid: number; label: string }
  | { kind: 'all'; label: string }
  | { kind: 'all-force'; label: string };

/**
 * F8 — Process List Monitor.
 *
 * Live view of all background bash/exec processes tracked by the global
 * ProcessRegistry. This panel OWNS the keyboard while open:
 * every keystroke is captured here and NEVER reaches the chat input,
 * because handleKey in app.tsx returns early when processListOpen is true
 * (before it can modify the input buffer). This two-layer design —
 * ProcessList's own useInput for shortcuts, handleKey's guard to suppress
 * everything else — keeps the input field completely unaffected.
 */
export function ProcessListMonitor(): React.ReactElement {
  const size = useMonitorSize();
  const [, setTick] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingAction, setPendingAction] = useState<PendingProcessAction | null>(null);

  // Force a re-render every second so elapsed times stay live.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Re-read from the registry on every render so the list is always fresh.
  const registry = getProcessRegistry();
  const all = registry.list();
  const stats = registry.stats();

  // Clamp selection when the list shrinks (process exited / killed / removed).
  // Without this, safeIndex fixes the render but selectedIndex stays stale,
  // causing a jump when a new process appears later.
  const safeIndex = Math.min(selectedIndex, Math.max(0, all.length - 1));
  useEffect(
    () => setSelectedIndex((value) => Math.min(value, Math.max(0, all.length - 1))),
    [all.length],
  );
  const selected = all[safeIndex];

  const now = Date.now();
  const running = all.filter((p) => !p.killed).length;

  // Circuit breaker state label
  const b = stats.breaker;
  const breakerColor =
    b.state === 'closed' ? theme.success : b.state === 'half-open' ? theme.warn : theme.error;

  const visibleLimit = Math.max(2, size.contentRows - (pendingAction ? 5 : 4));
  const window = panelWindow(all.length, safeIndex, visibleLimit);
  const visible = all.slice(window.start, window.end);
  const pageSize = visibleLimit;

  const runPendingAction = () => {
    if (!pendingAction) return;
    const liveRegistry = getProcessRegistry();
    if (pendingAction.kind === 'kill') liveRegistry.kill(pendingAction.pid);
    else if (pendingAction.kind === 'force') liveRegistry.kill(pendingAction.pid, { force: true });
    else if (pendingAction.kind === 'all') liveRegistry.killAll();
    else liveRegistry.killAll({ force: true });
    setPendingAction(null);
  };

  useInput((input, key) => {
    if (pendingAction) {
      if (key.return || input.toLowerCase() === 'y') runPendingAction();
      else if (input.toLowerCase() === 'n' || key.escape) setPendingAction(null);
      return;
    }
    // Navigation — these NEVER touch the chat input buffer
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(all.length - 1, prev + 1));
    } else if (key.pageUp) {
      setSelectedIndex((prev) => Math.max(0, prev - pageSize));
    } else if (key.pageDown) {
      setSelectedIndex((prev) => Math.min(all.length - 1, prev + pageSize));
    } else if (key.home || (key.ctrl && input === 'a') || input === 'g') {
      setSelectedIndex(0);
    } else if (key.end || (key.ctrl && input === 'e') || input === 'G') {
      setSelectedIndex(Math.max(0, all.length - 1));
    }
    // Actions — also NEVER touch the chat input buffer
    else if (key.return && selected) {
      setPendingAction({
        kind: 'kill',
        pid: selected.pid,
        label: `stop PID ${selected.pid} (${selected.name})`,
      });
    } else if (key.delete && selected) {
      setPendingAction({
        kind: 'force',
        pid: selected.pid,
        label: `force-stop PID ${selected.pid} (${selected.name})`,
      });
    } else if (input === 'a' && !key.ctrl) {
      setPendingAction({ kind: 'all', label: `stop all ${running} running processes` });
    } else if (input === 'A') {
      setPendingAction({ kind: 'all-force', label: `force-stop all ${running} running processes` });
    } else if (input === 'r') {
      getProcessRegistry().forceBreakerReset();
    }
    // Every other key is deliberately ignored — it will fall through
    // to handleKey in app.tsx, which returns early when processListOpen
    // is true, so nothing ever reaches the input buffer.
  });

  return (
    <MonitorShell
      accent={theme.error}
      icon={glyphs.process}
      title="PROCESSES"
      kicker={size.columns >= 90 ? 'background execution' : undefined}
      right={
        <Text>
          <Text color={running > 0 ? theme.warn : theme.success} bold>
            ● {running}
          </Text>
          <Text color={theme.textMuted}> / {all.length} tracked</Text>
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="↑↓" label="select" color={theme.error} />
          <KeyCap keyName="Enter" label="stop" color={theme.warn} />
          <KeyCap keyName="Del" label="force" color={theme.error} />
          <KeyCap keyName="F8" label="close" color={theme.error} />
        </Box>
      }
    >
      <Box marginTop={1}>
        <Text color={theme.textMuted}>CIRCUIT BREAKER </Text>
        <Text color={breakerColor} bold>
          ● {b.state.toUpperCase()}
        </Text>
        {b.state !== 'closed' ? (
          <Text color={theme.textMuted}>
            {' '}
            failures {b.consecutiveFailures}/5 · slow {b.slowCallsInWindow}/3
          </Text>
        ) : null}
        <Box flexGrow={1} />
        <KeyCap keyName="R" label="reset" color={breakerColor} />
      </Box>

      {pendingAction ? (
        <Box borderStyle="single" borderColor={theme.warn} paddingX={1} marginTop={1}>
          <Text color={theme.warn} bold>
            ⚠ {pendingAction.label}?
          </Text>
          <Box flexGrow={1} />
          <KeyCap keyName="Y/Enter" label="confirm" color={theme.error} />
          <Text> </Text>
          <KeyCap keyName="N" label="cancel" color={theme.success} />
        </Box>
      ) : null}

      {all.length === 0 ? (
        <EmptyPanelState
          icon="◇"
          title="No tracked processes"
          detail="Background bash and exec jobs will appear here."
          accent={theme.error}
        />
      ) : null}

      {window.above > 0 ? (
        <Text color={theme.textMuted}> ↑ {window.above} earlier processes</Text>
      ) : null}
      {visible.map((p, i) => {
        const age = ((now - p.startedAt) / 1000).toFixed(1);
        const isSelected = window.start + i === safeIndex;
        const cmd = truncatePanelText(p.command, Math.max(12, size.contentWidth - 31));

        return (
          <Box key={p.pid} flexDirection="row">
            <Text color={isSelected ? theme.error : theme.textMuted}>
              {isSelected ? '› ' : '  '}
            </Text>
            <Text color={theme.textMuted}>{String(p.pid).padEnd(7)}</Text>
            <Text color={theme.textMuted}>{truncatePanelText(p.name, 8).padEnd(9)}</Text>
            <Text color={theme.textMuted}>{`${age}s`.padEnd(8)}</Text>
            <Text color={isSelected ? theme.textPrimary : theme.textSecondary} bold={isSelected}>
              {cmd}
            </Text>
            <Box flexGrow={1} />
            {p.killed ? (
              <Text color={theme.error}>STOPPED</Text>
            ) : (
              <Text color={theme.success}>RUNNING</Text>
            )}
          </Box>
        );
      })}
      {window.below > 0 ? (
        <Text color={theme.textMuted}> ↓ {window.below} more processes</Text>
      ) : null}
      {all.length > 0 && !pendingAction ? (
        <Text color={theme.textMuted}>
          {' '}
          A stop all · Shift+A force all · PgUp/PgDn page · Home/End jump
        </Text>
      ) : null}
    </MonitorShell>
  );
}
