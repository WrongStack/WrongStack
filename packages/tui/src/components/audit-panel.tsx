import type { SideEffect } from '@wrongstack/contracts/types';
import { Text } from '../ink.js';
import { theme } from '../theme.js';
import { MonitorShell } from './monitor-shell.js';

interface AuditPanelProps {
  /** Side effects from ctx.sideEffects, passed from the host. */
  sideEffects: SideEffect[];
  onClose: () => void;
  maxRows?: number | undefined;
}

const RISK_COLORS: Record<string, string> = {
  shell: 'yellow',
  package: 'blue',
  network: 'green',
  'fs.write': 'magenta',
  config: 'cyan',
};

function formatInput(se: SideEffect): string {
  const cmd = se.input['command'];
  if (typeof cmd === 'string') return cmd.slice(0, 70);
  const url = se.input['url'];
  if (typeof url === 'string') return url.slice(0, 70);
  const pkgs = se.input['packages'];
  if (Array.isArray(pkgs)) return pkgs.join(', ').slice(0, 70);
  return JSON.stringify(se.input).slice(0, 70);
}

function formatTime(ts: string): string {
  return ts.slice(11, 19);
}

export function AuditPanel({ sideEffects, onClose: _onClose, maxRows }: AuditPanelProps) {
  // P2 #5: live-refresh the snapshot when sideEffects changes (tool.executed
  // triggers a re-render via the parent's state update). Reverses so newest
  // is at the top, caps at 50.
  const snapshot = [...sideEffects].reverse().slice(0, 50);

  return (
    <MonitorShell
      accent={theme.accent}
      icon=""
      title={`Side Effects Audit (${snapshot.length})`}
      maxHeight={maxRows}
      footer={
        <Text dimColor wrap="truncate-end">
          Esc close · Alt+PgUp/PgDn scroll
        </Text>
      }
    >
      {snapshot.length === 0 ? <Text dimColor>No side effects recorded yet.</Text> : null}
      {snapshot.map((se, i) => {
        const color = RISK_COLORS[se.risk] ?? 'gray';
        return (
          <Text key={`${se.toolUseId}-${i}`} wrap="truncate-end">
            <Text dimColor>{formatTime(se.ts)} </Text>
            <Text bold color={color as never}>
              {se.toolName.padEnd(8)}{' '}
            </Text>
            <Text color={color as never}>{se.risk.padEnd(7)} </Text>
            <Text>{formatInput(se)}</Text>
            {se.outcome ? <Text dimColor>→ {se.outcome}</Text> : null}
          </Text>
        );
      })}
    </MonitorShell>
  );
}
