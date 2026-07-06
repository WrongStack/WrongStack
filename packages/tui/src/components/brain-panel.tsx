import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';

export type BrainRiskLevel = 'off' | 'low' | 'medium' | 'high' | 'all';

export interface BrainLogEntry {
  kind: string;
  question: string;
  outcome: string;
  age: string;
}

export interface BrainPanelProps {
  riskLevel: BrainRiskLevel;
  log: BrainLogEntry[];
  selected: number;
  hint?: string | undefined;
}

const CHROME_ROWS = 14;

const RISK_DESCS: Record<BrainRiskLevel, string> = {
  off: 'Human decides everything',
  low: 'Auto-decide low risk only',
  medium: 'Auto-decide up to medium risk',
  high: 'Auto-decide up to high risk',
  all: 'Auto-decide everything',
};

const RISK_COLORS: Record<BrainRiskLevel, string> = {
  off: 'gray',
  low: 'green',
  medium: 'yellow',
  high: 'red',
  all: 'magenta',
};

export function BrainPanel({
  riskLevel,
  log,
  selected,
  hint,
}: BrainPanelProps): React.ReactElement {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;

  // Window the log entries: reserve ~7 rows for the risk header + chrome.
  const maxVisible = Math.max(4, termRows - CHROME_ROWS);
  const total = log.length;
  const windowStart =
    total <= maxVisible
      ? 0
      : Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), total - maxVisible));
  const windowEnd = Math.min(windowStart + maxVisible, total);
  const above = windowStart;
  const below = total - windowEnd;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        ━━ Brain ━━
      </Text>
      <Text dimColor>↑/↓ navigate log · ←/→ change risk · Esc close</Text>

      <Box marginTop={1} flexDirection="column">
        {/* ── Risk ceiling section ── */}
        <Box>
          <Text bold>Risk ceiling: </Text>
          <Text color={RISK_COLORS[riskLevel]} bold>
            {riskLevel.toUpperCase()}
          </Text>
          <Text dimColor>{`  ${RISK_DESCS[riskLevel]}`}</Text>
        </Box>

        {/* ── Recent decisions section ── */}
        <Box marginTop={1} flexDirection="column">
          <Text bold color="blue">
            Recent decisions
          </Text>
          {total === 0 ? (
            <Text dimColor>  No decisions recorded yet this session.</Text>
          ) : (
            <>
              {above > 0 ? <Text dimColor>{`  ↑ ${above} more`}</Text> : null}
              {log.slice(windowStart, windowEnd).map((entry, i) => {
                const index = windowStart + i;
                const focused = index === selected;
                return (
                  <Text
                    key={`${entry.kind}-${i}`}
                    inverse={focused}
                    {...(focused ? { color: 'magenta' } : {})}
                    wrap="truncate-end"
                  >
                    {focused ? '› ' : '  '}
                    <Text dimColor>{entry.age.padEnd(8)}</Text>
                    <Text color="cyan">{entry.kind.padEnd(12)}</Text>
                    <Text>{entry.question.length > 60 ? `${entry.question.slice(0, 57)}…` : entry.question}</Text>
                    {entry.outcome ? <Text dimColor>{` → ${entry.outcome.length > 20 ? `${entry.outcome.slice(0, 17)}…` : entry.outcome}`}</Text> : null}
                  </Text>
                );
              })}
              {below > 0 ? <Text dimColor>{`  ↓ ${below} more`}</Text> : null}
            </>
          )}
        </Box>
      </Box>

      {hint ? (
        <Box marginTop={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
