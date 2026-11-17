import type React from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import { fnKey } from '../fn-keys.js';
import { useActiveTheme } from '../hooks/use-active-theme.js';
import { useComposerPointer } from '../hooks/use-composer-pointer.js';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, type DOMElement, Text, useInput, useStdin } from '../ink.js';
import { type InputCell, layoutInputRows } from '../input-tokens.js';
import { isLeakedMouseInput, type MouseEventInfo, parseMouseEvents } from '../mouse.js';
import { TerminalReportParser } from '../terminal-reports.js';
import { displayWidth, truncateDisplay } from '../terminal-width.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import type { AnimationStyle } from './animation-style.js';
import type { ComposerStatus } from './composer-status-chip.js';
import { ComposerTopRail, renderRow } from './input-rows.js';
import { TextSelectionOverlay } from './text-selection-overlay.js';

export const DEFAULT_INPUT_PROMPT = `${glyphs.prompt} `;
export const MAX_INPUT_BODY_ROWS = 10;

/** Columns available to input tokens inside the two-sided composer rail. */
export function inputContentWidth(termColumns: number): number {
  return Math.max(8, termColumns - 4);
}

export interface InputProps {
  selectionMode?: 'block' | 'text' | undefined;
  onSelectionModeToggle?: (() => void) | undefined;
  onSelectionBegin?: (() => void) | undefined;
  prompt?: string | undefined;
  value: string;
  cursor: number;
  disabled?: boolean | undefined;
  hint?: string | undefined;
  /** Label embedded in the composer's top rail. */
  title?: string | undefined;
  /** Glyph shown before the title in the top rail (defaults to the brand glyph). */
  railIcon?: string | undefined;
  /**
   * Frame/prompt color override for a special composer mode (e.g. the warn
   * color while bash mode is active). Defaults to the theme brand colors;
   * `disabled` still wins with the error color.
   */
  accent?: string | undefined;
  /**
   * Right-aligned live status descriptor for the composer's top rail. Renders
   * as an animated {@link ComposerStatusChip} (the thinking word while working,
   * flat `idle`/`CONFIRM`/… otherwise). Defaults to idle when omitted.
   */
  status?: ComposerStatus | undefined;
  /** Animation style for the working-state chip (`'cycle'` rotates variants). */
  animationStyle?: AnimationStyle | 'cycle' | undefined;
  /**
   * Working time in ms — total time the agent has been actively running/streaming.
   * Displayed on the composer top rail as a dimmed time chip after the version.
   * Only visible when > 0; ticks up only while the agent is working.
   */
  workingTime?: number | undefined;
  /** Stable bottom-rail help; a non-empty `hint` temporarily replaces it. */
  footerHint?: string | undefined;
  /**
   * When true the visible prompt rows are replaced by an empty placeholder of
   * `placeholderHeight` rows, but BOTH keyboard listeners (the Ink `useInput`
   * and the raw-stdin parser that produces F-keys / wheel) stay
   * mounted. This is what keeps the central `handleKey` router — and therefore
   * the F-key/Esc toggles that open and CLOSE the monitor overlays — alive
   * while an overlay occupies the bottom region. Unmounting the Input here is
   * what previously left overlays (e.g. the F3 agents monitor) un-closable.
   */
  hidden?: boolean | undefined;
  /** Row count for the hidden placeholder so the bottom region never resizes. */
  placeholderHeight?: number | undefined;
  onKey: (input: string, key: KeyEvent) => void;
  /**
   * Optional cap on the column width used for wrapping and frame sizing.
   * When set, the input area treats this as its effective terminal width
   * instead of `stdout.columns` — needed when the input sits in a column
   * narrower than the full terminal (e.g. beside a sidebar).
   */
  maxWidth?: number | undefined;
  /** Maximum number of wrapped draft rows the host has room to show. */
  maxBodyRows?: number | undefined;
}

export interface KeyEvent {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  pageUp: boolean;
  pageDown: boolean;
  home: boolean;
  end: boolean;
  /** Mouse wheel scroll: positive = up (away from user), negative = down. */
  wheelDeltaY?: number | undefined;
  /**
   * Full mouse report (click/release/drag/hover/wheel) when terminal mouse
   * tracking is enabled. `wheelDeltaY` above is the back-compat shorthand for
   * `mouse.wheel`; consumers wanting clicks/coords should read `mouse`.
   */
  mouse?: MouseEventInfo | undefined;
  /** Function-key number 1–12 when a plain F-key was pressed, else undefined.
   *  Ink's public Key has no F-key field, so these are caught from raw stdin
   *  as complete transport reports and surfaced here. F-keys are terminal-safe
   *  aliases for chords some terminals intercept (e.g. Windows Terminal eats
   *  Ctrl+F for "Find"). */
  fn?: number | undefined;
  /** Literal bracketed-paste payload, never an editing or submit key. */
  paste?: boolean | undefined;
}

export const EMPTY_KEY: KeyEvent = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  return: false,
  escape: false,
  ctrl: false,
  meta: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  pageUp: false,
  pageDown: false,
  home: false,
  end: false,
};

export const Input = memo(function Input({
  prompt = DEFAULT_INPUT_PROMPT,
  value,
  cursor,
  disabled,
  hint,
  title = 'ASK WRONGSTACK',
  railIcon,
  accent,
  status,
  animationStyle = 'rainbow',
  workingTime,
  footerHint = 'Enter send · @ file · / commands · $ skill',
  hidden,
  placeholderHeight,
  onKey,
  maxWidth,
  maxBodyRows = MAX_INPUT_BODY_ROWS,
  selectionMode = 'block',
  onSelectionModeToggle,
  onSelectionBegin,
}: InputProps): React.ReactElement | null {
  useActiveTheme();
  const composerNodeRef = useRef<DOMElement | null>(null);
  const pointer = useComposerPointer();
  const pointerHandlerRef = useRef(pointer.handle);
  pointerHandlerRef.current = pointer.handle;
  const pendingFunctions = useRef<number[]>([]);
  const functionIndex = useRef(0);
  // Ink 8 owns editing keys and escape timing. Parsing them again from raw
  // reads used to duplicate Home/End and made semantics depend on packet size.
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    // Decode the missing F-key field on Ink's corresponding event, preserving
    // its position among ordinary keys in the same transport read.
    if (!input && !Object.keys(EMPTY_KEY).some((name) => key[name as keyof typeof key] === true)) {
      const fn = pendingFunctions.current[functionIndex.current];
      if (fn !== undefined) {
        functionIndex.current++;
        if (functionIndex.current === pendingFunctions.current.length) {
          pendingFunctions.current = [];
          functionIndex.current = 0;
        }
        onKey('', { ...EMPTY_KEY, fn });
      }
      return;
    }
    if (disabled) {
      if ((key.ctrl && ['c', 'C', 'v', 'V'].includes(input)) || key.home || key.end) {
        onKey(input, key as KeyEvent);
      }
      return;
    }
    if (!key.paste && input && isLeakedMouseInput(input)) return;
    // Preserve the established Alt/Option+Backspace word-delete alias.
    onKey(input, key.backspace && key.meta ? { ...key, ctrl: true } : (key as KeyEvent));
  });

  const { stdin } = useStdin();
  const reportParser = useRef(new TerminalReportParser());
  const keyHandler = useRef(onKey);
  keyHandler.current = onKey;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    if (!stdin) return;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    const handleData = (data: Buffer | string) => {
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      for (const report of reportParser.current.push(data.toString())) {
        const mouseEvents = parseMouseEvents(report);
        for (const ev of mouseEvents) {
          if (!disabledRef.current && pointerHandlerRef.current(ev)) continue;
          keyHandler.current('', {
            ...EMPTY_KEY,
            mouse: ev,
            wheelDeltaY: ev.kind === 'wheel' ? ev.wheel : undefined,
          });
        }
        const fn = fnKey(report);
        if (fn !== null) pendingFunctions.current.push(fn);
      }
      pendingTimer = reportParser.current.hasPendingControl
        ? setTimeout(() => reportParser.current.discardPendingControl(), 20)
        : undefined;
    };
    stdin.on('data', handleData);
    return () => {
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      stdin.off('data', handleData);
    };
  }, [stdin]);

  // Track terminal width so the input wraps at the real column count and the
  // box grows to exactly the number of visual rows the content needs.
  // The one site that already subscribed to the SAME stream it read; the hook
  // makes that the rule instead of the exception.
  const { columns: cols } = useTerminalSize({ maxWidth });

  // Disabled (aborting an iteration) is the only signal that needs a
  // hard visual cue — paint the prompt red. A mode override (bash mode's
  // warn color) otherwise replaces the brand accent.
  const promptColor = disabled ? theme.error : (accent ?? theme.brandAccent);

  // One <Text> per wrapped row: the column box's height becomes the row count,
  // so a long message that soft-wraps (or any embedded newlines) gives the
  // input area a correct, line-count-driven height instead of clipping or
  // overflowing. layoutInputRows keeps the cursor on the right row/column.
  const contentWidth = inputContentWidth(cols);
  const rows = layoutInputRows(prompt, value, cursor, contentWidth);

  // Constrain visible row count — when the prompt fills more than this many
  // wrapped rows the input area scrolls internally; the cursor row is kept
  // in the visible window and up/down arrow at the viewport edges scroll.
  // This prevents the input from pushing the chat history off the top of the
  // terminal on long prompts (GitHub issue #295).
  const visibleRowLimit = Math.max(1, Math.min(MAX_INPUT_BODY_ROWS, maxBodyRows));
  const needsScroll = rows.length > visibleRowLimit;

  // ── Scroll offset management ────────────────────────────────────────────
  // Determine which row the cursor is on (the *first* row with a cursor cell).
  let cursorRow = rows.length - 1; // default to last row
  outer: for (let r = 0; r < rows.length; r++) {
    const cells = rows[r] as InputCell[];
    for (const cell of cells) {
      if (cell.cursor) {
        cursorRow = r;
        break outer;
      }
    }
  }
  // Keep the cursor visible in the same render that changed the row budget.
  // Remember the resulting offset so subsequent moves inside the window do
  // not move the window again.
  const [vScroll, setVScroll] = useState(0);
  const clampedScroll = needsScroll
    ? Math.max(
        0,
        cursorRow - visibleRowLimit + 1,
        Math.min(vScroll, cursorRow, rows.length - visibleRowLimit),
      )
    : 0;
  useEffect(() => {
    if (clampedScroll !== vScroll) setVScroll(clampedScroll);
  }, [clampedScroll, vScroll]);

  // Slice the visible rows.
  const visibleRows = needsScroll
    ? rows.slice(clampedScroll, clampedScroll + visibleRowLimit)
    : rows;

  pointer.model.current = {
    node: composerNodeRef.current,
    runs: visibleRows.map((row, index) => ({
      row: index + 1,
      col:
        2 +
        displayWidth(
          row
            .filter((cell) => cell.prompt)
            .map((cell) => cell.ch)
            .join(''),
        ),
      text: row
        .filter((cell) => !cell.prompt)
        .map((cell) => cell.ch)
        .join(''),
    })),
    width: cols,
    rows: visibleRows.length,
    hidden: hidden ?? false,
    disabled: disabled ?? false,
    value,
    scroll: clampedScroll,
    mode: selectionMode,
    toggle: onSelectionModeToggle,
    begin: onSelectionBegin,
  };

  // Hidden mode: keep the listeners above mounted, but render only an empty
  // placeholder of the same height the visible input would occupy. The bottom
  // region stays a constant height (so Ink's log-update never bleeds the live
  // region into native scrollback) while keyboard handling stays alive.
  if (hidden) {
    if (placeholderHeight === 0) {
      return <Box height={0} />;
    }
    return <Box height={Math.max(3, placeholderHeight ?? visibleRows.length + 2)} />;
  }

  // Right-aligned live status chip. The rail is split into `head`/`tail`
  // strings around a fixed-width slot; the animated chip renders into that slot
  // padded to exactly `reservedWidth` so the right corner never jitters as the
  // spinner/word/dots animate. A missing `status` prop falls back to idle
  // (or aborting when the composer is disabled mid-abort).
  const railStatus: ComposerStatus =
    status ?? (disabled ? { kind: 'aborting' } : { kind: 'idle', fleetRunning: 0 });

  // When scrolling is active, show a scroll indicator in the bottom frame.
  const scrollIndicator = needsScroll ? `  ${clampedScroll + 1}/${rows.length}` : '';

  // ── Bottom frame with optional scroll indicator ──
  // Three-part bottom frame: colored border border, colorless hint text + scroll indicator, colored filler + corner.
  const modeLabel =
    cols >= 14 && onSelectionModeToggle
      ? `[${selectionMode === 'text' ? 'Text' : 'Block'}] · `
      : '';
  const bottomHint = modeLabel + (pointer.notice || hint || footerHint);
  const availW = cols;
  const leftBorder = '╰─ ';
  const leftBW = 3;
  const maxHintW = Math.max(0, availW - leftBW - 2 - displayWidth(scrollIndicator));
  const hintW = displayWidth(bottomHint);
  const shownHint = hintW > maxHintW ? truncateDisplay(bottomHint, maxHintW) : bottomHint;
  const shownHintW = displayWidth(shownHint);
  const fillW = Math.max(0, availW - leftBW - shownHintW - 2 - displayWidth(scrollIndicator));

  return (
    <Box
      ref={(node) => {
        composerNodeRef.current = node;
        if (pointer.model.current) pointer.model.current.node = node;
      }}
      flexDirection="column"
      height={visibleRows.length + 2}
    >
      <ComposerTopRail
        width={cols}
        title={title}
        icon={railIcon}
        accent={accent}
        status={railStatus}
        animationStyle={animationStyle}
        disabled={disabled ?? false}
        workingTime={workingTime}
      />
      {visibleRows.map((row, i) => {
        const rowWidth = displayWidth(row.map((cell) => cell.ch).join(''));
        const padding = ' '.repeat(Math.max(0, contentWidth - rowWidth));
        return (
          <Text key={i}>
            <Text color={disabled ? theme.error : (accent ?? theme.brandPrimary)}>{'│ '}</Text>
            {row.length === 0 ? null : renderRow(row, `r${i}`, promptColor)}
            <Text>{padding}</Text>
            <Text color={disabled ? theme.error : (accent ?? theme.brandPrimary)}>{' │'}</Text>
          </Text>
        );
      })}
      <TextSelectionOverlay runs={pointer.selection.runs} range={pointer.selection.range} />
      {/* Bottom frame: border matches top rail, hint text is muted */}
      <Text>
        <Text color={disabled ? theme.error : (accent ?? theme.brandPrimary)}>{leftBorder}</Text>
        <Text color={theme.textMuted}>{shownHint}</Text>
        {scrollIndicator ? <Text color={theme.textMuted}>{scrollIndicator}</Text> : null}
        <Text color={disabled ? theme.error : (accent ?? theme.brandPrimary)}>
          {fillW > 0 ? ' ' : ''}
          {'─'.repeat(fillW)}
          {'╯'}
        </Text>
      </Text>
    </Box>
  );
});
