// Animated status chip embedded in the composer's top rail (right side).
//
// This replaces the old static `WORKING`/`READY` string that `frameRule` baked
// into the border. It mirrors the statusline's `ThinkingChip` look — while the
// agent works it paints the configured thinking word with the chosen animation
// style (rainbow/wave/pulse/dots/breathe); when idle it shows a flat `idle`
// (or `agents >N` when background subagents are running).
//
// TWO invariants make it safe to live inside a fixed-width border:
//   1. Isolation — animation state stays local to the chip and uses Ink's
//      shared scheduler, so keyboard listeners do not churn at ~4Hz.
//   2. No jitter — every render is padded to exactly `reservedWidth` columns,
//      so the growing `dots` ellipsis and rolling word can't push the right
//      corner around. `composerStatusReservedWidth` computes that stable width
//      from the descriptor (not the live animation frame).

import { Text, useAnimation } from '../ink.js';
import type React from 'react';
import { displayWidth, truncateDisplay } from '../terminal-width.js';
import { resolveIconStyle } from '../ui-glyphs.js';
import {
  type AnimationStyle,
  BREATHE_FRAMES,
  COLOR_TICK_MS,
  colorPhaseFromTime,
  DOTS_FRAMES,
  HUE_WHEEL,
  mixHex,
  pulseColor,
  rainbowColor,
  styleForCycleTick,
  waveColor,
} from './animation-style.js';

// Spinner cadence — matches the statusline's braille spinner so the two
// surfaces breathe in sync. Frames reuse BREATHE_FRAMES (identical set).
const SPINNER_INTERVAL_MS = 1_000;

// ─── Activity icon (left of the composer title) ───────────────────────────
//
// The glyph that sits just before the "ASK WRONGSTACK" title breathes while the
// agent is busy and rests on the flat brand glyph when idle. It is a *separate*
// self-animating component so its ~8Hz frame ticks re-render only this one
// glyph — never the surrounding <Input> (same isolation the status chip uses).

// Frame cadence for the pulsing orb. Faster than the right-side chip so the two
// surfaces read as "heartbeat" (left) vs "slow breath" (right) rather than
// ticking in lockstep.
const ACTIVITY_INTERVAL_MS = 130;

// A symmetric grow→peak→shrink pulse. The unicode set is a true "energy orb";
// the ascii set deliberately echoes the classic `.` → `o` → `0` animation for
// terminals running the plain icon profile.
const ACTIVITY_FRAMES_UNICODE = ['·', '◦', '•', '●', '◉', '●', '•', '◦'] as const;
const ACTIVITY_FRAMES_ASCII = ['.', 'o', 'O', '0', 'O', 'o'] as const;

// Catppuccin surface0 — the dim end of every brightness pulse.
const PULSE_DIM = '#313244';

function activityFrames(): readonly string[] {
  return resolveIconStyle() === 'ascii' ? ACTIVITY_FRAMES_ASCII : ACTIVITY_FRAMES_UNICODE;
}

/**
 * Colour for the activity icon at pulse index `frame`. `working` walks the full
 * Catppuccin hue wheel (one stop per frame) for a lively "thinking" shimmer; the
 * transient states pulse a single hue between dim and bright in step with the
 * orb's size so the glyph visibly breathes.
 */
function activityColor(kind: ComposerStatus['kind'], frame: number, energy: number): string {
  switch (kind) {
    case 'working':
      return HUE_WHEEL[frame % HUE_WHEEL.length] ?? '#cba6f7';
    case 'aborting':
    case 'confirm':
      return mixHex(PULSE_DIM, '#f38ba8', energy); // pulsing red
    case 'queued':
      return mixHex(PULSE_DIM, '#89dceb', energy); // pulsing sky
    default:
      return mixHex(PULSE_DIM, '#94e2d5', energy); // pulsing teal (fallback)
  }
}

interface ComposerActivityIconProps {
  status: ComposerStatus;
  /** Glyph shown when the agent is idle (the flat brand mark). */
  idleGlyph: string;
  /** Recolours the resting/pulsing glyph to the error tone while aborting. */
  disabled: boolean;
}

/**
 * Isolated, self-animating activity glyph for the composer top rail. Idle →
 * flat brand glyph (inherits the rail's brand colour); busy → a size-and-colour
 * pulse. Always exactly one column wide so the rail geometry never shifts.
 */
export function ComposerActivityIcon({
  status,
  idleGlyph,
  disabled,
}: ComposerActivityIconProps): React.ReactElement {
  const active = status.kind !== 'idle';
  const { frame } = useAnimation({
    interval: ACTIVITY_INTERVAL_MS,
    isActive: active && !disabled,
  });

  if (!active) {
    // Inherit the rail's brand/error colour by not setting one (unless aborting
    // via `disabled`, which paints the whole rail red anyway).
    return <Text bold>{idleGlyph}</Text>;
  }

  const frames = activityFrames();
  const idx = frame % frames.length;
  const glyph = frames[idx] ?? idleGlyph;
  // Triangle 0→1→0 across the frame set → brightness tracks the orb's size.
  const energy = 0.4 + 0.6 * Math.sin((idx / frames.length) * Math.PI);
  const color = disabled
    ? mixHex(PULSE_DIM, '#f38ba8', energy)
    : activityColor(status.kind, frame, energy);

  return (
    <Text bold color={color}>
      {glyph}
    </Text>
  );
}

/**
 * Composer status descriptor. Distinct from the raw runtime status so the
 * chip's render (and its reserved width) is driven by one small, testable
 * value instead of scattered flags.
 */
export type ComposerStatus =
  | { kind: 'idle'; fleetRunning: number }
  | { kind: 'working'; word: string }
  | { kind: 'aborting' }
  | { kind: 'confirm' }
  | { kind: 'queued'; count: number };

/**
 * Build the composer status descriptor from the raw runtime state. Priority
 * mirrors the old `composerStatusLabel`: an open confirm panel and an in-flight
 * abort outrank the working/queued/idle states.
 */
export function composerStatusFromState(opts: {
  status: 'idle' | 'running' | 'streaming' | 'aborting';
  confirmCount: number;
  queueCount: number;
  thinkingWord: string;
  fleetRunning: number;
}): ComposerStatus {
  if (opts.confirmCount > 0) return { kind: 'confirm' };
  if (opts.status === 'running' || opts.status === 'streaming') {
    return { kind: 'working', word: opts.thinkingWord };
  }
  if (opts.status === 'aborting') return { kind: 'aborting' };
  if (opts.queueCount > 0) return { kind: 'queued', count: opts.queueCount };
  return { kind: 'idle', fleetRunning: opts.fleetRunning };
}

/** Static (non-animated) label + Ink color for the flat states. */
function staticLabel(status: ComposerStatus): { text: string; color: string; bold?: boolean } {
  switch (status.kind) {
    case 'confirm':
      return { text: 'CONFIRM', color: 'red', bold: true };
    case 'aborting':
      return { text: 'aborting…', color: 'red' };
    case 'queued':
      return { text: `queued ${status.count}`, color: 'cyan' };
    case 'idle':
      return status.fleetRunning > 0
        ? { text: `agents >${status.fleetRunning}`, color: 'magenta' }
        : { text: 'idle', color: 'cyan' };
    case 'working':
      // Not used for static render — working animates. Fallback for width calc.
      return { text: `⠋ ${status.word}…`, color: 'green' };
  }
}

/**
 * Stable column width the chip occupies for a given status — independent of the
 * live animation frame so the border geometry never shifts. For `working` we
 * reserve `spinner + space + word + '...'` (the `dots` style's widest frame is
 * three dots; the `…` used by other styles is narrower), i.e. `w(word) + 5`.
 * Pure + exported for testing.
 */
export function composerStatusReservedWidth(status: ComposerStatus): number {
  if (status.kind === 'working') {
    // 1 (spinner) + 1 (space) + word + 3 (widest dots frame)
    return displayWidth(status.word) + 5;
  }
  return displayWidth(staticLabel(status).text);
}

/** Right-pad a rendered node to exactly `reservedWidth` columns. */
function withPad(
  node: React.ReactNode,
  contentWidth: number,
  reservedWidth: number,
): React.ReactNode {
  const pad = Math.max(0, reservedWidth - contentWidth);
  return (
    <>
      {node}
      {pad > 0 ? <Text>{' '.repeat(pad)}</Text> : null}
    </>
  );
}

/** Fit plain chip text inside the rail slot without consuming the right corner. */
function fitStatusText(text: string, reservedWidth: number): string {
  return truncateDisplay(text, Math.max(0, reservedWidth));
}

/**
 * Render the animated working chip for the resolved style. Returns the styled
 * nodes plus the plain content width so the caller can pad to `reservedWidth`.
 */
function renderWorking(
  word: string,
  style: AnimationStyle,
  spinner: string,
  phase: number,
  colorPhase: number,
  maxWidth: number,
): { node: React.ReactNode; width: number } {
  if (style === 'dots') {
    // Spinner + word + a growing/shrinking dot run (no baseline ellipsis).
    // Uses `phase` (slow 1s cadence) — not `colorPhase` — so the dots
    // grow/shrink at a readable pace.
    const suffix = DOTS_FRAMES[phase % DOTS_FRAMES.length] ?? '';
    const text = truncateDisplay(`${spinner} ${word}${suffix}`, maxWidth);
    return {
      node: (
        <Text bold color="green">
          {text}
        </Text>
      ),
      width: displayWidth(text),
    };
  }
  if (style === 'static') {
    // Flat working label — no spinner, no suffix. The width reservation
    // (word + 5) keeps the rail geometry identical to other styles.
    const text = truncateDisplay(word, maxWidth);
    return {
      node: (
        <Text bold color="green">
          {text}
        </Text>
      ),
      width: displayWidth(text),
    };
  }
  if (style === 'breathe') {
    // The spinner IS the breathing element; text stays flat.
    const text = truncateDisplay(`${spinner} ${word}`, maxWidth);
    return {
      node: (
        <Text bold color="green">
          {text}
        </Text>
      ),
      width: displayWidth(text),
    };
  }
  // rainbow / wave / pulse all decorate `⠋ word…`.
  const text = truncateDisplay(`${spinner} ${word}…`, maxWidth);
  const chars = Array.from(text);
  if (style === 'pulse') {
    return {
      node: (
        <Text bold color={pulseColor(colorPhase)}>
          {text}
        </Text>
      ),
      width: displayWidth(text),
    };
  }
  const colorFor =
    style === 'wave'
      ? (i: number) => waveColor(i, colorPhase, chars.length)
      : (i: number) => rainbowColor(i, colorPhase);
  return {
    node: (
      <Text bold>
        {chars.map((ch, i) => (
          <Text key={i} color={colorFor(i)}>
            {ch}
          </Text>
        ))}
      </Text>
    ),
    width: displayWidth(text),
  };
}

interface ComposerStatusChipProps {
  status: ComposerStatus;
  /** Animation style for the working state (`'cycle'` rotates the variants). */
  animationStyle: AnimationStyle | 'cycle';
  /** Fixed slot width — the chip pads its output to exactly this many columns. */
  reservedWidth: number;
}

/**
 * Isolated, self-animating composer status chip. Uses Ink's shared animation
 * scheduler so animation re-renders never propagate into <Input>. Renders
 * flat text for idle/confirm/aborting/queued and an animated working word.
 */
export function ComposerStatusChip({
  status,
  animationStyle,
  reservedWidth,
}: ComposerStatusChipProps): React.ReactElement {
  const animating = status.kind === 'working';
  const { frame: spinnerIdx, time: animationTime } = useAnimation({
    interval: SPINNER_INTERVAL_MS,
    isActive: animating,
  });
  const cycleTick = Math.floor(animationTime / 1000);

  // Fast color animation tick — separate from the 1s spinner so the
  // rainbow/wave/pulse gradient moves smoothly (~8 updates/s).
  const { time: colorTime } = useAnimation({
    interval: COLOR_TICK_MS,
    isActive: animating,
  });
  const colorPhase = animating ? colorPhaseFromTime(colorTime) : 0;

  if (status.kind === 'working') {
    const live: AnimationStyle =
      animationStyle === 'cycle' ? styleForCycleTick(cycleTick) : animationStyle;
    const spinner = BREATHE_FRAMES[spinnerIdx % BREATHE_FRAMES.length] ?? '⠋';
    const { node, width } = renderWorking(
      status.word,
      live,
      spinner,
      spinnerIdx,
      colorPhase,
      reservedWidth,
    );
    return <Text>{withPad(node, width, reservedWidth)}</Text>;
  }

  const { text, color, bold } = staticLabel(status);
  const fittedText = fitStatusText(text, reservedWidth);
  return (
    <Text>
      {withPad(
        <Text color={color} bold={bold ?? false}>
          {fittedText}
        </Text>,
        displayWidth(fittedText),
        reservedWidth,
      )}
    </Text>
  );
}
