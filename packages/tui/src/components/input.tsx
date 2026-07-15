import { Box, Text, useInput, useStdin, useStdout } from '../ink.js';
import type React from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import { fnKey } from '../fn-keys.js';
import { type InputCell, layoutInputRows } from '../input-tokens.js';
import { type MouseEventInfo, isLeakedMouseInput, parseMouseEvents } from '../mouse.js';
import { displayWidth, truncateDisplay } from '../terminal-width.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import type { AnimationStyle } from './animation-style.js';
import {
  type ComposerStatus,
  ComposerStatusChip,
  composerStatusReservedWidth,
} from './composer-status-chip.js';

export const DEFAULT_INPUT_PROMPT = `${glyphs.prompt} `;

const COMPOSER_ACTIVITY_FRAMES = ['.', 'o', 'O', 'o'] as const;
const COMPOSER_ACTIVITY_INTERVAL_MS = 250;

/** Exact-width composer top rail with an isolated activity-icon timer.
 *
 * Layout:
 *   ╭─ icon TITLE ──────── status ─╮
 * The provider/model is shown in the status bar instead.
 */
function ComposerTopRail({
  width,
  title,
  status,
  animationStyle,
  disabled,
}: {
  width: number;
  title: string;
  status: ComposerStatus;
  animationStyle: AnimationStyle | 'cycle';
  disabled: boolean;
}): React.ReactElement {
  const active = status.kind === 'working';
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => setFrame((value) => (value + 1) % COMPOSER_ACTIVITY_FRAMES.length),
      COMPOSER_ACTIVITY_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [active]);

  const available = Math.max(0, width - 2);
  const icon = active ? (COMPOSER_ACTIVITY_FRAMES[frame] ?? '.') : glyphs.brand;

  // — 1. Status section (right side) —
  const requestedStatusWidth = composerStatusReservedWidth(status);
  const statusWidth = Math.min(requestedStatusWidth, Math.max(0, available - 3));
  const statusSectionW = statusWidth > 0 ? statusWidth + 3 : 0; // ' ' + chip + ' ─'
  const statusPrefix = statusWidth > 0 ? ' ' : '';
  const statusSuffix = statusWidth > 0 ? ' ─' : '';

  // — 2. Title section (left side) —
  // Reserve space for the title prefix: "─ icon TITLE "
  const titlePrefixRaw = title ? `─ ${icon} ${title} ` : '';
  // If no title, just show a leading dash so the rail doesn't start bare
  const titlePrefix = title ? titlePrefixRaw : '';
  const titleW = displayWidth(titlePrefix);

  // — 3. Fill — remaining space between title and status
  const remaining = Math.max(0, available - titleW - statusSectionW);

  return (
    <Text bold color={disabled ? theme.error : theme.brandPrimary}>
      {'╭'}
      {titlePrefix}
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

/** Columns available to input tokens inside the two-sided composer rail. */
export function inputContentWidth(termColumns: number): number {
  return Math.max(8, termColumns - 4);
}

export interface InputProps {
  prompt?: string | undefined;
  value: string;
  cursor: number;
  disabled?: boolean | undefined;
  hint?: string | undefined;
  /** Label embedded in the composer's top rail. */
  title?: string | undefined;
  /**
   * Right-aligned live status descriptor for the composer's top rail. Renders
   * as an animated {@link ComposerStatusChip} (the thinking word while working,
   * flat `idle`/`CONFIRM`/… otherwise). Defaults to idle when omitted.
   */
  status?: ComposerStatus | undefined;
  /** Animation style for the working-state chip (`'cycle'` rotates variants). */
  animationStyle?: AnimationStyle | 'cycle' | undefined;
  /** Stable bottom-rail help; a non-empty `hint` temporarily replaces it. */
  footerHint?: string | undefined;
  /**
   * When true the visible prompt rows are replaced by an empty placeholder of
   * `placeholderHeight` rows, but BOTH keyboard listeners (the Ink `useInput`
   * and the raw-stdin parser that produces F-keys / Home / End / wheel) stay
   * mounted. This is what keeps the central `handleKey` router — and therefore
   * the F-key/Esc toggles that open and CLOSE the monitor overlays — alive
   * while an overlay occupies the bottom region. Unmounting the Input here is
   * what previously left overlays (e.g. the F3 agents monitor) un-closable.
   */
  hidden?: boolean | undefined;
  /** Row count for the hidden placeholder so the bottom region never resizes. */
  placeholderHeight?: number | undefined;
  onKey: (input: string, key: KeyEvent) => void;
}

/**
 * Render one wrapped row of input cells into styled `<Text>` spans. Consecutive
 * cells with the same style are coalesced into a single span; the cursor cell is
 * always emitted on its own (inverse). `promptColor` styles the leading prompt.
 */
function renderRow(cells: InputCell[], rowKey: string, promptColor: string): React.ReactNode[] {
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
   *  Ink's useInput does not decode F-keys, so these are caught from raw stdin
   *  (same mechanism as Home/End) and surfaced here. F-keys are terminal-safe
   *  aliases for chords some terminals intercept (e.g. Windows Terminal eats
   *  Ctrl+F for "Find"). */
  fn?: number | undefined;
}

// Ink 5.x useInput does not expose home/end as boolean flags even though
// parseKeypress recognizes them. We subscribe to raw stdin to catch these.
function isHomeEnd(data: string): 'home' | 'end' | null {
  // Common terminal sequences for Home/End.
  // CSI H / CSI F are the most universal; the longer variants are fallbacks.
  if (data === '\x1b[H' || data === '\x1b[1~' || data === '\x1bOH' || data === '\x1b[7~')
    return 'home';
  if (data === '\x1b[F' || data === '\x1b[4~' || data === '\x1bOF' || data === '\x1b[8~')
    return 'end';
  return null;
}

function isCtrlArrow(data: string): 'left' | 'right' | null {
  // Xterm/Windows Terminal encode Ctrl+Arrow as CSI 1;5D/C. Some terminals
  // omit the "1;" prefix and send CSI 5D/C instead.
  if (data === '\x1b[1;5D' || data === '\x1b[5D') return 'left';
  if (data === '\x1b[1;5C' || data === '\x1b[5C') return 'right';
  return null;
}

/**
 * Detect Backspace / Delete from raw stdin bytes. Ink 5.x `useInput` may
 * miss these on Windows Terminal — Backspace often sends `\x08` (BS / Ctrl+H)
 * while most Unix terminals send `\x7f` (DEL). We catch both so the key works
 * regardless of terminal configuration. Delete sends the escape sequence
 * `\x1b[3~` which Ink usually handles, but we include it here for completeness
 * and to avoid relying on Ink internals.
 *
 * Also aliases `\x1b\x7f` and `\x1b\x08` (ESC+Backspace / Meta+Backspace) to
 * Ctrl+Backspace behaviour — delete the previous word. On macOS, Opt+Backspace
 * sends this sequence, and on Linux, Alt+Backspace does as well.
 */
function isBackspaceOrDelete(data: string): 'backspace' | 'delete' | 'metaBackspace' | null {
  if (data === '\x1b\x7f' || data === '\x1b\x08') return 'metaBackspace';
  if (data === '\x7f' || data === '\x08') return 'backspace';
  if (data === '\x1b[3~') return 'delete';
  return null;
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
  status,
  animationStyle = 'rainbow',
  footerHint = 'Enter send · Shift+Enter newline · @ file · / commands',
  hidden,
  placeholderHeight,
  onKey,
}: InputProps): React.ReactElement {
  // Suppress duplicate key events: when our raw-stdin handler catches a key
  // before Ink's useInput does, we set a suppression flag so Ink doesn't
  // fire a duplicate event. Without this, Backspace deletes two characters
  // — both the raw-stdin handler AND Ink fire onKey() for the same keystroke.
  const suppressInkEscRef = useRef(false);
  const suppressInkBackspaceRef = useRef(false);
  const suppressInkDeleteRef = useRef(false);
  const suppressInkCtrlLeftRef = useRef(false);
  const suppressInkCtrlRightRef = useRef(false);
  const suppressInkShiftEnterRef = useRef(false);

  useInput((input, key) => {
    // Ctrl+C must survive `disabled`. The prop is set exactly during
    // status==='aborting' and while a confirm panel is open — the two states
    // where the escalation ladder is the only way out — and on raw-mode
    // terminals (ConPTY/Windows) Ctrl+C arrives HERE as key data, never as a
    // SIGINT. Forward it to the key router (whose first line routes it into
    // the ladder); everything else stays blocked while disabled.
    if (disabled) {
      if (key.ctrl && (input === 'c' || input === 'C')) {
        onKey(input, key as KeyEvent);
      }
      return;
    }
    // Drop mouse reports that leaked through Ink as text. With mouse tracking on,
    // the terminal emits SGR reports (\x1b[<b;x;yM); Ink can't decode them, strips
    // the ESC, and would insert "[<b;x;yM" into the buffer. The raw-stdin handler
    // below parses the real events — here we just discard the leaked text.
    if (input && isLeakedMouseInput(input)) return;
    if (key.escape && suppressInkEscRef.current) {
      suppressInkEscRef.current = false;
      return;
    }
    if (key.backspace && suppressInkBackspaceRef.current) {
      suppressInkBackspaceRef.current = false;
      return;
    }
    if (key.delete && suppressInkDeleteRef.current) {
      suppressInkDeleteRef.current = false;
      return;
    }
    if (key.ctrl && key.leftArrow && suppressInkCtrlLeftRef.current) {
      suppressInkCtrlLeftRef.current = false;
      return;
    }
    if (key.ctrl && key.rightArrow && suppressInkCtrlRightRef.current) {
      suppressInkCtrlRightRef.current = false;
      return;
    }
    // Suppress duplicate Enter from useInput when raw handler caught Shift+Enter
    if (key.return && suppressInkShiftEnterRef.current) {
      suppressInkShiftEnterRef.current = false;
      return;
    }
    onKey(input, key as KeyEvent);
  });

  // Catch Home/End/Backspace/Delete that Ink's useInput may not surface
  // (especially on Windows Terminal where Backspace sends \x08 not \x7f).
  //
  // Also buffers a bare ESC for 10ms: if Backspace follows immediately,
  // it's ALT+Backspace / Opt+Backspace (delete previous word). Arrow keys,
  // Home, End, and other CSI sequences arrive within microseconds of the
  // ESC byte so the 10ms window is wide enough to catch split sequences
  // without introducing perceptible Esc latency. After 10ms with no
  // follow-up, a real Esc press is emitted.
  const { stdin } = useStdin();
  useEffect(() => {
    if (!stdin || disabled) return;
    let escTimer: ReturnType<typeof setTimeout> | null = null;

    const handleData = (data: Buffer) => {
      const s = data.toString();

      // ESC buffering: see comment block above.
      if (s === '\x1b') {
        escTimer = setTimeout(() => {
          escTimer = null;
          suppressInkEscRef.current = true;
          onKey('', { ...EMPTY_KEY, escape: true });
        }, 10);
        return;
      }
      if (escTimer !== null) {
        clearTimeout(escTimer);
        escTimer = null;
        if (s === '\x7f' || s === '\x08') {
          suppressInkBackspaceRef.current = true;
          onKey('', { ...EMPTY_KEY, backspace: true, ctrl: true });
          return;
        }
        // Not Backspace — let Ink handle the full sequence.
        return;
      }

      // Home / End
      const homeEnd = isHomeEnd(s);
      if (homeEnd === 'home') {
        onKey('', { ...EMPTY_KEY, home: true });
        return;
      }
      if (homeEnd === 'end') {
        onKey('', { ...EMPTY_KEY, end: true });
        return;
      }

      // Ctrl+Left / Ctrl+Right — Ink may surface these as plain arrows or text
      // depending on terminal, so decode the raw CSI sequence explicitly.
      const ctrlArrow = isCtrlArrow(s);
      if (ctrlArrow === 'left') {
        suppressInkCtrlLeftRef.current = true;
        onKey('', { ...EMPTY_KEY, leftArrow: true, ctrl: true });
        return;
      }
      if (ctrlArrow === 'right') {
        suppressInkCtrlRightRef.current = true;
        onKey('', { ...EMPTY_KEY, rightArrow: true, ctrl: true });
        return;
      }

      // Shift+Enter via CSI u protocol (kitty, Windows Terminal, etc.).
      // Some terminals send \x1b[13;2u for Shift+Enter; Ink's decode may not
      // set key.shift=true, so we catch it here and fire a synthetic event.
      if (s === '\x1b[13;2u') {
        suppressInkShiftEnterRef.current = true;
        onKey('', { ...EMPTY_KEY, return: true, shift: true });
        return;
      }

      // Backspace / Delete — caught here because Ink's useInput may miss
      // \x08 (BS) on Windows Terminal. We fire before Ink so the key is never lost.
      // Set suppression flags so Ink's useInput doesn't fire a duplicate event
      // (Backspace would delete two characters otherwise — both handlers fire onKey).
      const bsdel = isBackspaceOrDelete(s);
      if (bsdel === 'backspace') {
        suppressInkBackspaceRef.current = true;
        onKey('', { ...EMPTY_KEY, backspace: true });
        return;
      }
      if (bsdel === 'delete') {
        suppressInkDeleteRef.current = true;
        onKey('', { ...EMPTY_KEY, delete: true });
        return;
      }
      if (bsdel === 'metaBackspace') {
        // ALT+Backspace / Opt+Backspace / Cmd+Backspace (macOS Terminal) —
        // delete the previous word. Translates to Ctrl+Backspace which the
        // handleKey router already handles by slicing from the last space
        // to the cursor.
        suppressInkBackspaceRef.current = true;
        onKey('', { ...EMPTY_KEY, backspace: true, ctrl: true });
        return;
      }

      // Mouse reports (SGR protocol — enabled per-overlay/globally; see mouse.ts
      // and run-tui's lifecycle). A fast wheel scroll batches several reports into
      // one chunk, so emit each. The leak-drop in useInput above stops Ink from
      // also inserting these as text.
      const mouseEvents = parseMouseEvents(s);
      if (mouseEvents.length > 0) {
        for (const ev of mouseEvents) {
          onKey('', {
            ...EMPTY_KEY,
            mouse: ev,
            wheelDeltaY: ev.kind === 'wheel' ? ev.wheel : undefined,
          });
        }
        return;
      }

      // Function keys (F1–F12)
      const fn = fnKey(s);
      if (fn !== null) onKey('', { ...EMPTY_KEY, fn });
    };
    stdin.on('data', handleData);
    return () => {
      if (escTimer !== null) clearTimeout(escTimer);
      stdin.off('data', handleData);
    };
  }, [stdin, disabled, onKey]);

  // Track terminal width so the input wraps at the real column count and the
  // box grows to exactly the number of visual rows the content needs.
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout?.columns ?? 80);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setCols(stdout.columns ?? 80);
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Disabled (aborting an iteration) is the only signal that needs a
  // hard visual cue — paint the prompt red.
  const promptColor = disabled ? theme.error : theme.brandAccent;

  // One <Text> per wrapped row: the column box's height becomes the row count,
  // so a long message that soft-wraps (or any embedded newlines) gives the
  // input area a correct, line-count-driven height instead of clipping or
  // overflowing. layoutInputRows keeps the cursor on the right row/column.
  const contentWidth = inputContentWidth(cols);
  const rows = layoutInputRows(prompt, value, cursor, contentWidth);

  // Hidden mode: keep the listeners above mounted, but render only an empty
  // placeholder of the same height the visible input would occupy. The bottom
  // region stays a constant height (so Ink's log-update never bleeds the live
  // region into native scrollback) while keyboard handling stays alive.
  if (hidden) {
    return <Box height={Math.max(3, placeholderHeight ?? rows.length + 2)} />;
  }

  // Right-aligned live status chip. The rail is split into `head`/`tail`
  // strings around a fixed-width slot; the animated chip renders into that slot
  // padded to exactly `reservedWidth` so the right corner never jitters as the
  // spinner/word/dots animate. A missing `status` prop falls back to idle
  // (or aborting when the composer is disabled mid-abort).
  const railStatus: ComposerStatus =
    status ?? (disabled ? { kind: 'aborting' } : { kind: 'idle', fleetRunning: 0 });

  // Three-part bottom frame: colored border border, colorless hint text, colored filler + corner.
  // Note on width: the bottom frame has its own corners (╰, ╯), NOT the side
  // borders (│) used by content rows. So the budget is the full `cols`, not
  // `cols - 2` — if it were cols - 2 the bottom rule would end 2 chars short.
  const bottomHint = hint || footerHint;
  const availW = cols;
  const leftBorder = '╰─ ';
  const leftBW = 3;
  const maxHintW = Math.max(0, availW - leftBW - 2); // 2 for space before ╯ + ╯
  const hintW = displayWidth(bottomHint);
  const shownHint = hintW > maxHintW ? truncateDisplay(bottomHint, maxHintW) : bottomHint;
  const shownHintW = displayWidth(shownHint);
  const fillW = Math.max(0, availW - leftBW - shownHintW - 2); // 2 for " ╯"

  return (
    <Box flexDirection="column">
      <ComposerTopRail
        width={cols}
        title={title}
        status={railStatus}
        animationStyle={animationStyle}
        disabled={disabled ?? false}
      />
      {rows.map((row, i) => {
        const rowWidth = displayWidth(row.map((cell) => cell.ch).join(''));
        const padding = ' '.repeat(Math.max(0, contentWidth - rowWidth));
        return (
          <Text key={i}>
            <Text color={disabled ? theme.error : theme.brandPrimary}>{'│ '}</Text>
            {row.length === 0 ? null : renderRow(row, `r${i}`, promptColor)}
            <Text>{padding}</Text>
            <Text color={disabled ? theme.error : theme.brandPrimary}>{' │'}</Text>
          </Text>
        );
      })}
      {/* Bottom frame: border matches top rail (brandPrimary), hint text is muted */}
      <Text>
        <Text color={disabled ? theme.error : theme.brandPrimary}>{leftBorder}</Text>
        <Text color={theme.textMuted}>{shownHint}</Text>
        <Text color={disabled ? theme.error : theme.brandPrimary}>
          {fillW > 0 ? ' ' : ''}
          {'─'.repeat(fillW)}
          {'╯'}
        </Text>
      </Text>
    </Box>
  );
});
