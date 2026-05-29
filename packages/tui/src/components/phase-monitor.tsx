import { Box, Text, useInput } from 'ink';
import type React from 'react';

const fmtElapsed = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  if (m > 0) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${s}s`;
};

export interface PhaseMonitorProps {
  /** Per-phase state from the App reducer. */
  phases: Record<string, {
    name: string;
    status: string;
    completedTasks: number;
    totalTasks: number;
    startedAt?: number;
  }>;
  /** IDs of currently running phases. */
  runningPhaseIds: string[];
  /** Session-level elapsed ms. */
  elapsedMs: number;
  /** nowTick for elapsed time calculation. */
  nowTick: number;
  onClose: () => void;
}

const PHASE_STATUS: Record<string, { icon: string; color: string; label: string }> = {
  pending:    { icon: '⏳', color: 'gray',   label: 'pending' },
  ready:      { icon: '🔜', color: 'cyan',   label: 'ready' },
  running:    { icon: '▶',  color: 'yellow', label: 'running' },
  paused:     { icon: '⏸',  color: 'magenta', label: 'paused' },
  completed:  { icon: '✓',  color: 'green',  label: 'done' },
  failed:     { icon: '✗',  color: 'red',    label: 'failed' },
  skipped:    { icon: '⏭',  color: 'gray',   label: 'skipped' },
};

function fmtPhase(s: string): { icon: string; color: string; label: string } {
  return PHASE_STATUS[s] ?? { icon: '?', color: 'white', label: s };
}

/**
 * Full-screen PhaseMonitor overlay (Ctrl+P in TUI).
 *
 * Layout:
 *   Header: project title + elapsed time + Ctrl+P to close
 *   Per-phase rows:
 *     · icon · name · status · (task progress) · started/elapsed
 *   Bottom: keyboard hint
 */
export function PhaseMonitor({
  phases,
  runningPhaseIds,
  elapsedMs,
  nowTick,
  onClose,
}: PhaseMonitorProps): React.ReactElement {
  useInput((_, key) => {
    if (key.escape) onClose();
  });

  const phaseList = Object.values(phases);
  const running = phaseList.filter((p) => runningPhaseIds.includes(Object.keys(phases).find((k) => phases[k] === p) ?? ''));
  const done = phaseList.filter((p) => p.status === 'completed' || p.status === 'skipped');
  const failed = phaseList.filter((p) => p.status === 'failed');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Header */}
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Text bold color="cyan">PHASE MONITOR</Text>
        <Text dimColor>│</Text>
        <Text dimColor>⏱ {fmtElapsed(elapsedMs)}</Text>
        <Text dimColor>│</Text>
        <Text color="yellow">▶{running.length}</Text>
        <Text dimColor>·</Text>
        <Text color="green">✓{done.length}</Text>
        {failed.length > 0 ? (
          <>
            <Text dimColor>·</Text>
            <Text color="red">✗{failed.length}</Text>
          </>
        ) : null}
        <Text dimColor>│ Ctrl+P / Esc to close</Text>
      </Box>

      {phaseList.length === 0 ? (
        <Text dimColor>No phases active. Use /autophase start [title] to begin.</Text>
      ) : (
        phaseList.map((phase, i) => {
          const s = fmtPhase(phase.status);
          const phaseKey = Object.keys(phases).find((k) => phases[k] === phase) ?? String(i);
          const isRunning = runningPhaseIds.includes(phaseKey);
          const elapsed = phase.startedAt ? fmtElapsed(nowTick - phase.startedAt) : '—';
          const progress = phase.totalTasks > 0
            ? `${phase.completedTasks}/${phase.totalTasks}`
            : '—';

          return (
            <Box key={phaseKey} flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1}>
                <Text color={s.color} bold>{s.icon}</Text>
                <Text bold>{phase.name}</Text>
                <Text dimColor>·</Text>
                <Text color={s.color}>{s.label}</Text>
                {isRunning ? (
                  <>
                    <Text dimColor>·</Text>
                    <Text dimColor>elapsed {elapsed}</Text>
                  </>
                ) : null}
                {phase.totalTasks > 0 && (
                  <>
                    <Text dimColor>·</Text>
                    <Text dimColor>tasks {progress}</Text>
                  </>
                )}
              </Box>
            </Box>
          );
        })
      )}

      {/* Keyboard hints */}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate phases · Esc close</Text>
      </Box>
    </Box>
  );
}
