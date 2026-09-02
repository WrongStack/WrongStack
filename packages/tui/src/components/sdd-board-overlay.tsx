import type { SddBoardSnapshot, SddBoardTask, SddTaskDisplayStatus } from '@wrongstack/sdd';
import type React from 'react';
import { Box, Text } from '../ink.js';

const STATUS: Record<SddTaskDisplayStatus, { icon: string; color: string }> = {
  pending: { icon: '○', color: 'gray' },
  queued: { icon: '◔', color: 'cyan' },
  in_progress: { icon: '▶', color: 'yellow' },
  blocked: { icon: '⊘', color: 'magenta' },
  review: { icon: '◆', color: 'blue' },
  failed: { icon: '✗', color: 'red' },
  completed: { icon: '✓', color: 'green' },
  cancelled: { icon: '⊝', color: 'gray' },
};

const RUN_STATUS: Record<string, string> = {
  running: 'yellow',
  paused: 'magenta',
  stopped: 'gray',
  completed: 'green',
  failed: 'red',
  deadlocked: 'red',
  idle: 'gray',
};

const PRIORITY: Record<string, string> = {
  critical: 'red',
  high: 'yellow',
  medium: 'cyan',
  low: 'gray',
};

/** Activity-feed kind → glyph + colour (mirrors the WebUI SDD_FEED_KIND). */
const FEED_KIND: Record<string, { icon: string; color: string }> = {
  started: { icon: '▶', color: 'yellow' },
  completed: { icon: '✓', color: 'green' },
  failed: { icon: '✗', color: 'red' },
  retrying: { icon: '↻', color: 'yellow' },
  wave: { icon: '≋', color: 'magenta' },
  deadlock: { icon: '⚠', color: 'red' },
  verification_failed: { icon: '⛊', color: 'red' },
  conflict: { icon: '⑂', color: 'yellow' },
  split: { icon: '⋔', color: 'cyan' },
  supervisor: { icon: '✦', color: 'magenta' },
};

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function TaskCard({ task }: { task: SddBoardTask }): React.ReactElement {
  const st = STATUS[task.displayStatus] ?? { icon: '?', color: 'white' };
  return (
    <Box flexDirection="column" marginBottom={1} width={26}>
      <Box flexDirection="row" gap={1}>
        <Text color={st.color} bold>
          {st.icon}
        </Text>
        <Text dimColor>{task.shortId}</Text>
        <Text color={PRIORITY[task.priority] ?? 'gray'}>{task.priority[0]?.toUpperCase()}</Text>
      </Box>
      <Text wrap="truncate-end">{clip(task.title, 24)}</Text>
      {task.deps.length > 0 ? <Text dimColor>← {clip(task.deps.join(', '), 22)}</Text> : null}
      {task.agentName ? (
        <Box flexDirection="row" gap={1}>
          <Text color={task.displayStatus === 'in_progress' ? 'yellow' : 'gray'}>●</Text>
          <Text color="cyan">{clip(task.agentName, 14)}</Text>
          {task.retries > 0 ? <Text color="red">↻{task.retries}</Text> : null}
        </Box>
      ) : null}
      {task.worktreeBranch ? <Text dimColor>⌥ {clip(task.worktreeBranch, 22)}</Text> : null}
    </Box>
  );
}

/**
 * Full-screen live SDD board overlay (Ctrl+B in TUI).
 *
 * Renders the CLI-owned multi-agent SDD run as FORGE-style topological
 * dependency columns (Start / Phase N), with the live worker + worktree on
 * each card. Read-only mirror of the EventBus `sdd.board.snapshot`; steering
 * happens from the WebUI or slash commands.
 */
export function SddBoardOverlay({
  snapshot,
  focusColumn = null,
}: {
  snapshot: SddBoardSnapshot;
  focusColumn?: number | null | undefined;
}): React.ReactElement {
  const byShort = new Map<string, SddBoardTask>(snapshot.tasks.map((t) => [t.shortId, t]));
  const p = snapshot.progress;
  const chains = snapshot.diagnostics?.deadlockChains ?? [];
  // Most-recent-first feed; the projector already caps + orders it.
  const recentFeed = (snapshot.feed ?? []).slice(0, 6);
  const focused =
    typeof focusColumn === 'number' && focusColumn >= 0 && focusColumn < snapshot.columns.length
      ? focusColumn
      : null;
  const columns = focused === null ? snapshot.columns : [snapshot.columns[focused]!];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Header */}
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Text bold color="cyan">
          SDD BOARD
        </Text>
        <Text dimColor>│</Text>
        <Text bold>{clip(snapshot.title, 32)}</Text>
        <Text dimColor>│</Text>
        <Text color={RUN_STATUS[snapshot.status] ?? 'white'}>{snapshot.status}</Text>
        <Text dimColor>│</Text>
        <Text dimColor>wave {snapshot.wave + 1}</Text>
        <Text dimColor>│</Text>
        <Text color="green">✓{p.completed}</Text>
        <Text dimColor>/</Text>
        <Text>{p.total}</Text>
        <Text dimColor>({p.percentComplete}%)</Text>
        {p.inProgress > 0 ? <Text color="yellow">▶{p.inProgress}</Text> : null}
        {p.failed > 0 ? <Text color="red">✗{p.failed}</Text> : null}
        <Text dimColor>│ Ctrl+B close · c clean wt · z rollback · x destroy</Text>
        {focused !== null ? (
          <Text dimColor>
            │ column {focused + 1}/{snapshot.columns.length} (←/→)
          </Text>
        ) : null}
      </Box>

      {/* Deadlock diagnostics */}
      {chains.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red" bold>
            ⚠ Deadlock — blocked by failed tasks:
          </Text>
          {chains.map((c) => (
            <Text key={c.blocked} color="red">
              {'  '}
              {c.blocked} ← {c.blockedBy.join(', ')}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Topological columns */}
      {snapshot.tasks.length === 0 ? (
        <Text dimColor>No active SDD run. Start one with /sdd execute.</Text>
      ) : (
        <Box flexDirection="row" gap={2}>
          {columns.map((col) => (
            <Box key={col.label} flexDirection="column" marginRight={1}>
              <Text bold color="cyan">
                {col.label}
              </Text>
              <Text dimColor>{'─'.repeat(12)}</Text>
              {col.taskIds
                .map((sid) => byShort.get(sid))
                .filter((t): t is SddBoardTask => Boolean(t))
                .map((t) => (
                  <TaskCard key={t.id} task={t} />
                ))}
            </Box>
          ))}
        </Box>
      )}

      {/* Recent activity — narrates verification / conflict / split / supervisor
          alongside the usual task lifecycle so the overlay isn't board-only. */}
      {recentFeed.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">
            Recent activity
          </Text>
          <Text dimColor>{'─'.repeat(12)}</Text>
          {recentFeed.map((f, i) => {
            const k = FEED_KIND[f.kind] ?? FEED_KIND.started;
            return (
              <Box key={`${f.ts}-${i}`} flexDirection="row" gap={1}>
                <Text color={k?.color ?? 'white'}>{k?.icon ?? '•'}</Text>
                <Text dimColor>{clip(f.text, 70)}</Text>
              </Box>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
}
