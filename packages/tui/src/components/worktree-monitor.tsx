import {
  formatWorktreeDuration,
  projectWorktreeTimeline,
  shortWorktreeBranch,
  type WorktreeLane,
  type WorktreeLaneOutcome,
  type WorktreeLanePhase,
  type WorktreeTimelineEvent,
  worktreeTimelineTicks,
} from '@wrongstack/contracts/types/worktree-timeline';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
  usePanelInput as useInput,
  useMonitorSize,
  usePanelShortcutsEnabled,
} from './monitor-shell.js';
import {
  WORKTREE_PHASE_CHAR,
  worktreeAxisLine,
  worktreeBarRuns,
  worktreeBaseRuns,
} from './worktree-timeline-bars.js';

const OUTCOME: Record<WorktreeLaneOutcome, { icon: string; color: () => string; label: string }> = {
  live: { icon: '●', color: () => theme.warn, label: 'running' },
  merged: { icon: '✓', color: () => theme.success, label: 'merged' },
  conflict: { icon: '⚠', color: () => theme.warn, label: 'conflict' },
  failed: { icon: '✗', color: () => theme.error, label: 'failed' },
  kept: { icon: '‖', color: () => theme.textMuted, label: 'kept' },
  discarded: { icon: '–', color: () => theme.textMuted, label: 'discarded' },
};

const PHASE_COLOR: Record<WorktreeLanePhase, () => string> = {
  working: () => theme.warn,
  queued: () => theme.accent,
  merging: () => theme.monitor.worktree,
  kept: () => theme.textMuted,
};

const PHASE_LABEL: Record<WorktreeLanePhase, string> = {
  working: 'working',
  queued: 'waiting to merge',
  merging: 'merging',
  kept: 'kept',
};

const STAGE_LABEL = {
  allocate: 'checkout creation failed',
  commit: 'commit refused',
  merge: 'merge failed',
} as const;

export function isWorktreeMonitorCloseKey(
  input: string,
  key: { escape?: boolean | undefined; ctrl?: boolean | undefined },
): boolean {
  return key.escape === true || (key.ctrl === true && input === 'w');
}

function clock(at: number, seconds: boolean): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return seconds ? `${hm}:${String(d.getSeconds()).padStart(2, '0')}` : hm;
}

function laneDuration(lane: WorktreeLane, end: number): number {
  return (lane.end ?? end) - lane.start;
}

/**
 * Full-screen Worktree monitor overlay (F4 / Ctrl+T). Every managed git
 * worktree as a lane on one time axis — working ▓, waiting to merge ▒,
 * merging █, kept for review ░ — under the base branch with a ● per squash
 * commit. ↑↓ selects a lane; its error, conflicts and phase times show below.
 * Same projection as the WebUI timeline and HQ (core `worktree-timeline`).
 */
export function WorktreeMonitor({
  events,
  nowTick,
  onClose,
}: {
  events: readonly WorktreeTimelineEvent[];
  nowTick: number;
  onClose: () => void;
}): React.ReactElement {
  const size = useMonitorSize();
  const timeline = useMemo(
    () => projectWorktreeTimeline(events, { now: nowTick }),
    [events, nowTick],
  );
  const lanes = timeline.lanes;
  // Start on the newest lane; arrows walk back through history.
  const [selected, setSelected] = useState(() => Math.max(0, lanes.length - 1));
  const shortcutsEnabled = usePanelShortcutsEnabled();
  useInput((input, key) => {
    // Ctrl+W is delete-word-back in the composer; only Esc closes while a
    // draft is being typed.
    if (key.escape === true || (shortcutsEnabled && isWorktreeMonitorCloseKey(input, key)))
      onClose();
    else if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) {
      setSelected((value) => Math.min(Math.max(0, lanes.length - 1), value + 1));
    }
  });
  useEffect(() => {
    setSelected((value) => Math.min(value, Math.max(0, lanes.length - 1)));
  }, [lanes.length]);

  const compact = size.columns < 92;
  const labelWidth = compact ? 16 : 26;
  const statsWidth = compact ? 8 : 18;
  const barWidth = Math.max(10, size.contentWidth - labelWidth - statsWidth - 4);
  const span = timeline.end - timeline.start;
  const withSeconds = span < 10 * 60_000;
  const ticks = worktreeTimelineTicks(
    timeline.start,
    timeline.end,
    Math.max(2, Math.floor(barWidth / 12)),
  );
  const detailRows = 6;
  const limit = Math.max(1, size.contentRows - 6 - detailRows);
  const window = panelWindow(lanes.length, selected, limit);
  const visible = lanes.slice(window.start, window.end);
  const current = lanes[selected];
  const counts = timeline.counts;

  return (
    <MonitorShell
      accent={theme.monitor.worktree}
      icon="⑂"
      title="WORKTREES"
      kicker={compact ? undefined : 'isolated changes over time'}
      right={
        <Text>
          <Text color={theme.warn}>● {counts.live}</Text>
          <Text color={theme.textMuted}> </Text>
          <Text color={theme.success}>✓ {counts.merged}</Text>
          {counts.conflict + counts.failed > 0 ? (
            <Text color={theme.error}> ⚠ {counts.conflict + counts.failed}</Text>
          ) : null}
        </Text>
      }
      footer={
        <Box gap={1} flexWrap="wrap">
          <KeyCap keepTogether keyName="↑↓" label="inspect" color={theme.monitor.worktree} />
          <KeyCap keepTogether keyName="F4/Esc" label="close" color={theme.monitor.worktree} />
          {(Object.keys(WORKTREE_PHASE_CHAR) as WorktreeLanePhase[]).map((phase) => (
            <Text key={phase} color={theme.textMuted}>
              <Text color={PHASE_COLOR[phase]()}>{WORKTREE_PHASE_CHAR[phase]}</Text>{' '}
              {PHASE_LABEL[phase]}
            </Text>
          ))}
          {timeline.avgQueueMs !== undefined ? (
            <Text color={theme.textMuted}>
              avg wait {formatWorktreeDuration(timeline.avgQueueMs)}
            </Text>
          ) : null}
        </Box>
      }
    >
      {lanes.length === 0 ? (
        <EmptyPanelState
          icon="◇"
          title="No isolated worktrees"
          detail="Goal phases, SDD tasks and fleet subagents that run in isolated worktrees appear here."
          accent={theme.monitor.worktree}
        />
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={theme.textMuted}>
              {'  '}
              {truncatePanelText(`BASE ${timeline.baseBranch ?? 'HEAD'}`, labelWidth).padEnd(
                labelWidth,
              )}
            </Text>
            <Text> </Text>
            {worktreeBaseRuns(timeline, barWidth).map((run, i) => (
              <Text key={`base-${i}`} color={run.commit ? theme.success : theme.borderSubtle}>
                {run.text}
              </Text>
            ))}
          </Box>

          {visible.map((lane, visibleIndex) => {
            const index = window.start + visibleIndex;
            const isSelected = index === selected;
            const meta = OUTCOME[lane.outcome];
            const stats =
              lane.commits.length > 0
                ? compact
                  ? `+${lane.insertions}`
                  : `+${lane.insertions} -${lane.deletions} ${formatWorktreeDuration(laneDuration(lane, timeline.end))}`
                : formatWorktreeDuration(laneDuration(lane, timeline.end));
            return (
              <Box key={lane.handleId}>
                <Text color={isSelected ? theme.monitor.worktree : theme.textMuted}>
                  {isSelected ? '›' : ' '}
                </Text>
                <Text color={meta.color()}>{meta.icon}</Text>
                <Text
                  color={isSelected ? theme.textPrimary : theme.textSecondary}
                  bold={isSelected}
                >
                  {truncatePanelText(shortWorktreeBranch(lane.branch), labelWidth).padEnd(
                    labelWidth,
                  )}
                </Text>
                <Text> </Text>
                {worktreeBarRuns(lane, timeline.start, timeline.end, barWidth).map((run, i) => (
                  <Text
                    key={`${lane.handleId}-${i}`}
                    color={run.phase ? PHASE_COLOR[run.phase]() : undefined}
                  >
                    {run.text}
                  </Text>
                ))}
                <Text color={theme.textMuted}>
                  {' '}
                  {truncatePanelText(stats, statsWidth).padStart(statsWidth)}
                </Text>
              </Box>
            );
          })}

          <Box>
            <Text color={theme.textMuted}>
              {' '.repeat(labelWidth + 3)}
              {worktreeAxisLine(ticks, timeline.start, timeline.end, barWidth, (at) =>
                clock(at, withSeconds),
              )}
            </Text>
          </Box>
          {window.below > 0 || window.start > 0 ? (
            <Text color={theme.textMuted}>
              {' '}
              {window.start > 0 ? `↑ ${window.start} earlier  ` : ''}
              {window.below > 0 ? `↓ ${window.below} more worktrees` : ''}
            </Text>
          ) : null}

          {current ? (
            <LaneDetail
              lane={current}
              end={Math.max(timeline.end, nowTick)}
              width={size.contentWidth}
            />
          ) : null}
        </Box>
      )}
    </MonitorShell>
  );
}

function LaneDetail({
  lane,
  end,
  width,
}: {
  lane: WorktreeLane;
  end: number;
  width: number;
}): React.ReactElement {
  const meta = OUTCOME[lane.outcome];
  const totals = new Map<WorktreeLanePhase, number>();
  for (const seg of lane.segments) {
    totals.set(seg.phase, (totals.get(seg.phase) ?? 0) + Math.max(0, (seg.end ?? end) - seg.start));
  }
  const phases = [...totals.entries()]
    .map(([phase, ms]) => `${PHASE_LABEL[phase]} ${formatWorktreeDuration(ms)}`)
    .join(' · ');
  const errorLine = lane.error?.trim().split('\n')[0];
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Box>
        <Text color={meta.color()} bold>
          {meta.icon} {meta.label.toUpperCase()}{' '}
        </Text>
        <Text color={theme.textPrimary} bold>
          {truncatePanelText(shortWorktreeBranch(lane.branch), Math.max(12, width - 30))}
        </Text>
        <Box flexGrow={1} />
        <Text color={theme.textMuted}>{lane.onDisk ? 'on disk' : 'removed'}</Text>
      </Box>
      <Text color={theme.textMuted}>
        {truncatePanelText(
          `${lane.ownerLabel}${lane.sha ? `  ·  ${lane.sha.slice(0, 7)}` : ''}${phases ? `  ·  ${phases}` : ''}`,
          width - 2,
        )}
      </Text>
      {errorLine ? (
        <Text>
          <Text color={theme.error} bold>
            {lane.failedStage ? STAGE_LABEL[lane.failedStage] : 'failed'}:{' '}
          </Text>
          <Text color={theme.textSecondary}>
            {truncatePanelText(errorLine, Math.max(18, width - 24))}
          </Text>
        </Text>
      ) : null}
      {lane.conflictFiles.length > 0 ? (
        <Text>
          <Text color={theme.warn} bold>
            ⚠ conflicts{' '}
          </Text>
          <Text color={theme.textSecondary}>
            {truncatePanelText(lane.conflictFiles.join(', '), Math.max(18, width - 15))}
          </Text>
        </Text>
      ) : null}
    </Box>
  );
}
