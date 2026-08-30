import { Box, Text } from '../ink.js';
import {
  activeMemoryContextCount,
  type MemoryContextMonitorState,
} from '../memory-context-monitor.js';
import { theme } from '../theme.js';
import { fmtRatioPct } from './status-bar-format.js';

export function MemoryContextWidget({ state }: { state: MemoryContextMonitorState }) {
  const summary = state.latest;
  if (!summary) return null;
  const records = Object.values(state.memories);
  const active = activeMemoryContextCount(state);
  const pending = records.filter((memory) => memory.state === 'injected').length;
  const left = records.filter((memory) => memory.state === 'exited').length;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1}>
      <Text>
        <Text bold color="magenta">
          {'MEMORY  '}
        </Text>
        <Text>{`${summary.matched} matched · `}</Text>
        <Text color="green">{`${summary.injected} injected`}</Text>
        <Text>{' · '}</Text>
        <Text color="yellow">{`${summary.filtered} filtered`}</Text>
        <Text>{' · '}</Text>
        <Text color="cyan">{`${active} ctx`}</Text>
        {pending > 0 ? <Text color="yellow">{` · ${pending} pending`}</Text> : null}
        {left > 0 ? <Text color={theme.textMuted}>{` · ${left} left`}</Text> : null}
      </Text>
      {summary.error ? (
        <Text color="red">{`${summary.error}`}</Text>
      ) : (
        <Text color={theme.textMuted}>
          {`${summary.trigger} · ctx ${fmtRatioPct(summary.contextPressure)} · +${summary.injectedChars} chars · /context = details`}
        </Text>
      )}
    </Box>
  );
}
