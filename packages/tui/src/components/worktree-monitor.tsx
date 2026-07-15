import { Box, Text, useInput } from '../ink.js';
import type React from 'react';
import { useEffect, useState } from 'react';
import { theme } from '../theme.js';
import type { WorktreeRow } from './worktree-panel.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
  useMonitorSize,
} from './monitor-shell.js';

const fmtElapsed = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  if (m > 0) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${s}s`;
};

const WT_STATUS: Record<string, { icon: string; color: string; label: string }> = {
  allocating: { icon: '○', color: 'gray', label: 'allocating' },
  active: { icon: '●', color: 'yellow', label: 'active' },
  committing: { icon: '◐', color: 'cyan', label: 'committing' },
  merging: { icon: '⇡', color: 'blue', label: 'merging' },
  merged: { icon: '✓', color: 'green', label: 'merged' },
  'needs-review': { icon: '⚠', color: 'magenta', label: 'needs-review' },
  failed: { icon: '✗', color: 'red', label: 'failed' },
};

function fmt(s: string) {
  return WT_STATUS[s] ?? { icon: '?', color: 'white', label: s };
}

export function isWorktreeMonitorCloseKey(
  input: string,
  key: { escape?: boolean | undefined; ctrl?: boolean | undefined },
): boolean {
  return key.escape === true || (key.ctrl === true && input === 'w');
}

/**
 * Full-screen Worktree monitor overlay (Ctrl+T to open, Ctrl+T to close).
 * Shows each AutoPhase worktree: branch, base→branch, owner phase, diff stats,
 * and conflict files for any worktree left in needs-review.
 *
 * Prunes merged/failed worktrees older than TERMINAL_TTL_MS to prevent
 * accumulation in long-running sessions.
 */
export function WorktreeMonitor({
  worktrees,
  baseBranch,
  nowTick,
  onClose,
}: {
  worktrees: Record<string, WorktreeRow & { baseBranch?: string | undefined }>;
  baseBranch?: string | undefined;
  nowTick: number;
  onClose: () => void;
}): React.ReactElement {
  const size = useMonitorSize();
  const [selected, setSelected] = useState(0);
  useInput((input, key) => {
    if (isWorktreeMonitorCloseKey(input, key)) onClose();
    else if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) {
      setSelected((value) => Math.min(Math.max(0, recent.length - 1), value + 1));
    }
  });

  /** Terminal worktrees older than this are pruned from the view. */
  const TERMINAL_TTL_MS = 5 * 60_000; // 5 minutes

  const list = Object.values(worktrees);

  // Show live worktrees + recently-terminated ones only.
  const recent = list
    .filter((w) => {
      if (['active', 'committing', 'merging', 'needs-review'].includes(w.status)) return true;
      return nowTick - (w.allocatedAt ?? nowTick) < TERMINAL_TTL_MS;
    })
    .sort((a, b) => {
      const rank = (status: string) =>
        status === 'needs-review'
          ? 0
          : ['active', 'committing', 'merging'].includes(status)
            ? 1
            : 2;
      return rank(a.status) - rank(b.status) || (b.allocatedAt ?? 0) - (a.allocatedAt ?? 0);
    });

  // Counts from ALL entries (accurate), display from recent only.
  const active = list.filter((w) => ['active', 'committing', 'merging'].includes(w.status)).length;
  const merged = list.filter((w) => w.status === 'merged').length;
  const failed = list.filter((w) => w.status === 'failed' || w.status === 'needs-review').length;
  const staleTerminal = list.length - recent.length;
  useEffect(() => {
    setSelected((value) => Math.min(value, Math.max(0, recent.length - 1)));
  }, [recent.length]);

  const cardRows = size.columns >= 92 ? 3 : 4;
  const limit = Math.max(1, Math.floor((size.contentRows - 3) / cardRows));
  const window = panelWindow(recent.length, selected, limit);
  const visible = recent.slice(window.start, window.end);
  const compact = size.columns < 92;

  return (
    <MonitorShell
      accent={theme.monitor.worktree}
      icon="⑂"
      title="WORKTREES"
      kicker={compact ? undefined : 'isolated changes'}
      right={
        <Text>
          <Text color={theme.warn}>● {active}</Text>
          <Text color={theme.textMuted}> </Text>
          <Text color={theme.success}>✓ {merged}</Text>
          {failed > 0 ? <Text color={theme.error}> ⚠ {failed}</Text> : null}
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="↑↓" label="inspect" color={theme.monitor.worktree} />
          <KeyCap keyName="F4" label="close" color={theme.monitor.worktree} />
          <Text color={theme.textMuted}>/worktree merge &lt;branch&gt;</Text>
          {staleTerminal > 0 ? <Text color={theme.textMuted}>{staleTerminal} archived</Text> : null}
        </Box>
      }
    >
      <Box marginTop={1}>
        <Text color={theme.textMuted}>
          BASE <Text color={theme.textSecondary}>{baseBranch ?? 'project default'}</Text>
          {'  ·  '}showing {visible.length}/{recent.length || 0}
        </Text>
      </Box>

      {recent.length === 0 ? (
        <EmptyPanelState
          icon="◇"
          title="No isolated worktrees"
          detail="They will appear when AutoPhase runs with worktree isolation enabled."
          accent={theme.monitor.worktree}
        />
      ) : (
        visible.map((w, visibleIndex) => {
          const s = fmt(w.status);
          const short = w.branch.replace(/^wstack\/ap\//, '');
          const elapsed = w.allocatedAt ? fmtElapsed(nowTick - w.allocatedAt) : '—';
          const conflictWidth = Math.max(18, size.contentWidth - 15);
          const isSelected = window.start + visibleIndex === selected;
          return (
            <Box key={w.branch} flexDirection="column" marginTop={1} paddingX={1}>
              <Box>
                <Text color={isSelected ? theme.monitor.worktree : theme.textMuted}>
                  {isSelected ? '› ' : '  '}
                </Text>
                <Text color={s.color} bold>
                  {s.icon} {s.label.toUpperCase().padEnd(12)}
                </Text>
                <Text color={theme.textPrimary} bold>
                  {truncatePanelText(short, compact ? 24 : 42)}
                </Text>
                <Box flexGrow={1} />
                <Text color={theme.textMuted}>{elapsed}</Text>
              </Box>
              <Box marginLeft={2}>
                <Text color={theme.textMuted}>
                  {truncatePanelText(
                    `${w.baseBranch ?? baseBranch ?? 'base'} → ${short}`,
                    compact ? 38 : 58,
                  )}
                </Text>
                {!compact ? <Text color={theme.textMuted}> owner {w.ownerLabel}</Text> : null}
                <Box flexGrow={1} />
                <Text color={theme.success}>+{w.insertions}</Text>
                <Text color={theme.error}> -{w.deletions}</Text>
                <Text color={theme.textMuted}> {w.files} files</Text>
              </Box>
              {compact ? <Text color={theme.textMuted}> owner {w.ownerLabel}</Text> : null}
              {w.conflictFiles && w.conflictFiles.length > 0 ? (
                <Box marginLeft={2}>
                  <Text color={theme.warn} bold>
                    ⚠ conflicts{' '}
                  </Text>
                  <Text color={theme.textSecondary}>
                    {truncatePanelText(w.conflictFiles.join(', '), conflictWidth)}
                  </Text>
                </Box>
              ) : null}
            </Box>
          );
        })
      )}
      {window.below > 0 ? (
        <Text color={theme.textMuted}> ↓ {window.below} more worktrees</Text>
      ) : null}
    </MonitorShell>
  );
}
