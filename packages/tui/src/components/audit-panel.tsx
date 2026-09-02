import { Box, Text } from 'ink';
import type { SideEffect } from '@wrongstack/core/types';

interface AuditPanelProps {
  /** Side effects from ctx.sideEffects, passed from the host. */
  sideEffects: SideEffect[];
  onClose: () => void;
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

export function AuditPanel({ sideEffects, onClose: _onClose }: AuditPanelProps) {
  // P2 #5: live-refresh the snapshot when sideEffects changes (tool.executed
  // triggers a re-render via the parent's state update). Reverses so newest
  // is at the top, caps at 50.
  const snapshot = [...sideEffects].reverse().slice(0, 50);

  if (snapshot.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold>Side Effects Audit</Text>
          <Text dimColor>Esc to close</Text>
        </Box>
        <Box paddingY={1}>
          <Text dimColor>No side effects recorded yet.</Text>
        </Box>
        <Box>
          <Text dimColor>
            Bash commands, package installs, and network requests will appear here.
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Side Effects Audit ({snapshot.length})</Text>
        <Text dimColor>Esc to close</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {snapshot.map((se, i) => {
          const color = RISK_COLORS[se.risk] ?? 'gray';
          return (
            <Box key={`${se.toolUseId}-${i}`} flexDirection="row" gap={1}>
              <Text dimColor>{formatTime(se.ts)}</Text>
              <Text bold color={color as never}>
                {se.toolName.padEnd(8)}
              </Text>
              <Text color={color as never}>{se.risk.padEnd(7)}</Text>
              <Text>{formatInput(se)}</Text>
              {se.outcome ? <Text dimColor>→ {se.outcome}</Text> : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
