import type React from 'react';
import { Text } from '../ink.js';
import type { InputCell } from '../input-tokens.js';
import { useElapsedMs } from '../second-clock.js';
import { displayWidth } from '../terminal-width.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import type { AnimationStyle } from './animation-style.js';
import {
  ComposerActivityIcon,
  type ComposerStatus,
  ComposerStatusChip,
  composerStatusReservedWidth,
} from './composer-status-chip.js';
import { fmtElapsed } from './status-bar.js';

/** Exact-width composer top rail with an isolated activity-icon timer.
 *
 * Layout:
 *   ╭─ icon TITLE ──────── status ─╮
 * The provider/model is shown in the status bar instead.
 */
export function ComposerTopRail({
  width,
  title,
  status,
  animationStyle,
  disabled,
  workingClock,
  icon = glyphs.brand,
  accent,
}: {
  width: number;
  title: string;
  status: ComposerStatus;
  animationStyle: AnimationStyle | 'cycle';
  disabled: boolean;
  workingClock?: { base: number; startedAt: number | null } | undefined;
  /** Glyph drawn before the title; defaults to the brand glyph. */
  icon?: string | undefined;
  /** Rail color override (e.g. warn color while bash mode is active). */
  accent?: string | undefined;
}): React.ReactElement {
  const available = Math.max(0, width - 2);
  // Per-second repaint is confined to this rail: the shared 1s clock is only
  // subscribed while a work spell is live (startedAt !== null).
  const workingTime = useElapsedMs(workingClock?.base ?? 0, workingClock?.startedAt ?? null);
  // The 'static' style flattens the whole working surface: the left orb rests
  // on the brand glyph instead of pulsing (the right chip renders flat text).
  // 'cycle' keeps animating — it means "shuffle all styles".
  const staticMode = animationStyle === 'static';

  // — 1. Status section (right side) —
  const requestedStatusWidth = composerStatusReservedWidth(status);
  const statusWidth = Math.min(requestedStatusWidth, Math.max(0, available - 3));
  const statusSectionW = statusWidth > 0 ? statusWidth + 3 : 0; // ' ' + chip + ' ─'
  const statusPrefix = statusWidth > 0 ? ' ' : '';
  const statusSuffix = statusWidth > 0 ? ' ─' : '';

  // — 2. Title section (left side) —
  // Reserve space for the title prefix: "─ icon TITLE "
  const titlePrefixRaw = title ? `─ ${icon} ${title}` : '';
  // Working time chip: [MM:SS] or [H:MM:SS], shown only when > 0
  const workingTimeChip =
    workingTime != null && workingTime > 0 ? ` [${fmtElapsed(workingTime)}]` : '';
  // If no title, just show a leading dash so the rail doesn't start bare
  const titlePrefix = title ? `${titlePrefixRaw}${workingTimeChip} ` : '';
  const titleW = displayWidth(titlePrefix);

  // — 3. Fill — remaining space between title and status
  const remaining = Math.max(0, available - titleW - statusSectionW);

  return (
    <Text bold color={disabled ? theme.error : (accent ?? theme.brandPrimary)}>
      {'╭'}
      {title ? (
        <>
          <Text>{'─ '}</Text>
          {staticMode ? (
            <Text bold>{glyphs.brand}</Text>
          ) : (
            <ComposerActivityIcon status={status} idleGlyph={glyphs.brand} disabled={disabled} />
          )}
          <Text>{` ${title}`}</Text>
          {workingTimeChip ? <Text dimColor>{workingTimeChip}</Text> : null}
          <Text> </Text>
        </>
      ) : null}
      {remaining > 0 ? '─'.repeat(remaining) : null}
      {statusPrefix}
      {statusWidth > 0 ? (
        <ComposerStatusChip
          status={status}
          animationStyle={animationStyle}
          reservedWidth={statusWidth}
        />
      ) : null}
      {statusSuffix}
      {'╮'}
    </Text>
  );
}

/**
 * Render one wrapped row of input cells into styled `<Text>` spans. Consecutive
 * cells with the same style are coalesced into a single span; the cursor cell is
 * always emitted on its own (inverse). `promptColor` styles the leading prompt.
 */
export function renderRow(
  cells: InputCell[],
  rowKey: string,
  promptColor: string,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let run = '';
  let runStart = 0;
  let runStyle: 'prompt' | 'chip' | 'plain' | null = null;
  const flush = (end: number) => {
    if (run === '' || runStyle === null) return;
    const key = `${rowKey}-${runStart}`;
    if (runStyle === 'prompt')
      out.push(
        <Text key={key} color={promptColor}>
          {run}
        </Text>,
      );
    else if (runStyle === 'chip')
      out.push(
        <Text key={key} color="cyan" dimColor>
          {run}
        </Text>,
      );
    else out.push(<Text key={key}>{run}</Text>);
    run = '';
    runStart = end;
  };
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as InputCell;
    if (cell.cursor) {
      flush(i);
      out.push(
        <Text key={`${rowKey}-c${i}`} inverse>
          {cell.ch}
        </Text>,
      );
      runStart = i + 1;
      continue;
    }
    const style = cell.prompt ? 'prompt' : cell.chip ? 'chip' : 'plain';
    if (style !== runStyle) {
      flush(i);
      runStyle = style;
      runStart = i;
    }
    run += cell.ch;
  }
  flush(cells.length);
  return out;
}
