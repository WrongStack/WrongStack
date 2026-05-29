import { Box, Text } from 'ink';
import type React from 'react';

const fmtElapsed = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  if (m > 0) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${s}s`;
};

export interface PhasePanelProps {
  /** Per-phase state from the App reducer. */
  phases: Record<string, {
    name: string;
    status: string;
    completedTasks: number;
    totalTasks: number;
    startedAt?: number;
  }>;
  /** Active running phase IDs. */
  runningPhaseIds: string[];
  /** nowTick for elapsed time display. */
  nowTick: number;
}

const STATUS: Record<string, { icon: string; color: string }> = {
  pending:   { icon: '○', color: 'gray' },
  ready:     { icon: '◐', color: 'cyan' },
  running:   { icon: '●', color: 'yellow' },
  paused:    { icon: '⏸', color: 'magenta' },
  completed: { icon: '✓', color: 'green' },
  failed:    { icon: '✗', color: 'red' },
  skipped:   { icon: '⊘', color: 'gray' },
};

function s(entry: string) {
  return STATUS[entry] ?? { icon: '?', color: 'white' };
}

 /**
 * AutoPhase sidebar panel — shown below fleet panel when AutoPhase is active.
 * Compact 2-line-per-phase view optimized for the TUI layout.
 * Unlike PhaseMonitor (an overlay), PhasePanel is always visible while active.
 */
export function PhasePanel({ phases, runningPhaseIds, nowTick }: PhasePanelProps): React.ReactElement | null {
  const list = Object.values(phases);
  if (list.length === 0) return null;

  const done = list.filter((p) => p.status === 'completed' || p.status === 'skipped').length;
  const running = list.filter((p) => p.status === 'running').length;
  const failed = list.filter((p) => p.status === 'failed').length;

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    >
      {/* Header */}
      <Box flexDirection="row" gap={2}>
        <Text dimColor>Phases</Text>
        <Text dimColor>│</Text>
        <Text color="yellow">▶{running}</Text>
        <Text dimColor>✓{done}</Text>
        {failed > 0 ? <Text color="red">✗{failed}</Text> : null}
        <Text dimColor>· {list.length} total</Text>
        <Text dimColor>· Ctrl+P for details</Text>
      </Box>

      {/* Per-phase compact rows */}
      {list.map((phase, i) => {
        const phaseKey = Object.keys(phases).find((k) => phases[k] === phase) ?? String(i);
        const st = s(phase.status);
        const progress = phase.totalTasks > 0
          ? `${phase.completedTasks}/${phase.totalTasks}`
          : '';
        const elapsed = phase.startedAt
          ? fmtElapsed(nowTick - phase.startedAt)
          : '';

        return (
          <Box key={phaseKey} flexDirection="row" gap={1}>
            <Text color={st.color}>{st.icon}</Text>
            <Text>{phase.name.slice(0, 14).padEnd(14)}</Text>
            <Text color={st.color} dimColor>{st.icon === '●' ? phase.status : ''}</Text>
            {progress ? (
              <Text dimColor> {progress}</Text>
            ) : null}
            {elapsed && st.icon === '●' ? (
              <Text dimColor> {elapsed}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
