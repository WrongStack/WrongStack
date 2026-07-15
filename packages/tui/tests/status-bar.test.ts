import { describe, expect, it } from 'vitest';
import {
  fmtElapsed,
  renderMeter,
  renderProgress,
  stateChip,
  statusBarAutonomySpan,
  statusBarModelSpan,
  hasTokenDisplay,
  tokenDisplayTotals,
} from '../src/components/status-bar.js';
import { theme } from '../src/theme.js';

describe('statusBarModelSpan (hit-test geometry)', () => {
  it('places the model chip after the state chip (no version)', () => {
    const span = statusBarModelSpan({ state: 'idle', model: 'anthropic/claude' });
    // cap(1) + segment padding(1) + "● idle"(6) + transition(1) + padding(1) = 10
    expect(span).toEqual({ start: 11, len: 'anthropic/claude'.length });
  });

  it('widens the offset for the longer "thinking…" state label', () => {
    const idle = statusBarModelSpan({ state: 'idle', model: 'm' });
    const busy = statusBarModelSpan({ state: 'running', model: 'm' });
    // "thinking…"(9) vs "idle"(4) → +5
    expect(busy.start - idle.start).toBe(5);
  });

  it('accounts for a configured thinking word', () => {
    const idle = statusBarModelSpan({ state: 'idle', model: 'm' });
    const busy = statusBarModelSpan({ state: 'running', thinkingWord: 'working', model: 'm' });
    // "working…"(8) vs "idle"(4) → +4
    expect(busy.start - idle.start).toBe(4);
  });

  it('drops the state-chip term when the state chip is hidden', () => {
    // The composer top-rail chip now owns the state indicator, so the statusline
    // hides its own `state` chip and the model chip shifts left by the whole
    // "● {label}" segment (content + two pads + one transition).
    const shown = statusBarModelSpan({ state: 'running', thinkingWord: 'working', model: 'm' });
    const hidden = statusBarModelSpan({
      state: 'running',
      thinkingWord: 'working',
      stateHidden: true,
      model: 'm',
    });
    // "● working…"(10) + pad(1) + pad(1) + transition(1) = 13 removed.
    expect(shown.start - hidden.start).toBe(13);
    // With no version and no state chip, the model sits right after the cap.
    expect(hidden.start).toBe(2);
  });
});

describe('statusBarAutonomySpan (hit-test geometry)', () => {
  it('returns null when autonomy is off or unset', () => {
    expect(statusBarAutonomySpan({ autonomy: 'off' })).toBeNull();
    expect(statusBarAutonomySpan({})).toBeNull();
  });

  it('starts at the left padding when YOLO is not shown', () => {
    expect(statusBarAutonomySpan({ autonomy: 'auto' })).toEqual({
      start: 2,
      len: 2 + 'AUTO'.length,
    });
  });

  it('shifts right past the YOLO chip + separator', () => {
    const span = statusBarAutonomySpan({ yolo: true, autonomy: 'eternal' });
    // cap(1) + " ! YOLO "(8) + transition(1) + next segment padding(1) = 11
    expect(span).toEqual({ start: 11, len: 2 + 'ETERNAL'.length });
  });
});

describe('fmtElapsed', () => {
  it('renders mm:ss under one hour', () => {
    expect(fmtElapsed(0)).toBe('00:00');
    expect(fmtElapsed(5_000)).toBe('00:05');
    expect(fmtElapsed(65_000)).toBe('01:05');
    expect(fmtElapsed(59 * 60_000 + 30_000)).toBe('59:30');
  });

  it('switches to h:mm:ss at exactly one hour', () => {
    expect(fmtElapsed(60 * 60_000)).toBe('1:00:00');
    expect(fmtElapsed(60 * 60_000 + 1_000)).toBe('1:00:01');
    expect(fmtElapsed(3 * 60 * 60_000 + 15 * 60_000 + 7_000)).toBe('3:15:07');
  });

  it('rounds milliseconds down (floor)', () => {
    expect(fmtElapsed(999)).toBe('00:00');
    expect(fmtElapsed(1_999)).toBe('00:01');
  });

  it('pads seconds and minutes with leading zeros under an hour', () => {
    expect(fmtElapsed(3_000)).toBe('00:03');
    expect(fmtElapsed(63_000)).toBe('01:03');
  });
});

describe('stateChip', () => {
  it('shows plain idle when no background agents are running', () => {
    expect(stateChip('idle', 0)).toEqual({ label: 'idle', color: theme.accent });
  });

  it('surfaces the live agent count when idle but background agents run', () => {
    expect(stateChip('idle', 1)).toEqual({ label: 'agents ▶1', color: theme.monitor.agents });
    expect(stateChip('idle', 3)).toEqual({ label: 'agents ▶3', color: theme.monitor.agents });
  });

  it('keeps foreground states regardless of fleet count', () => {
    // A running/streaming foreground already implies activity — the chip
    // reflects the foreground, not the background fleet.
    expect(stateChip('running', 5)).toEqual({ label: 'thinking…', color: theme.success });
    expect(stateChip('streaming', 5)).toEqual({ label: 'thinking…', color: theme.success });
    expect(stateChip('aborting', 5)).toEqual({ label: 'aborting…', color: theme.warn });
  });

  it('uses a configured single-word foreground label', () => {
    expect(stateChip('running', 0, 'working')).toEqual({ label: 'working…', color: theme.success });
  });

  it('falls back to thinking for invalid configured words', () => {
    expect(stateChip('running', 0, 'two words')).toEqual({ label: 'thinking…', color: theme.success });
    expect(stateChip('running', 0, 'x'.repeat(17))).toEqual({ label: 'thinking…', color: theme.success });
  });
});

describe('renderProgress', () => {
  it('renders an empty bar at ratio 0', () => {
    expect(renderProgress(0, 10)).toBe('░░░░░░░░░░');
  });

  it('renders a full bar at ratio 1', () => {
    expect(renderProgress(1, 10)).toBe('██████████');
  });

  it('shows at least one filled cell for any non-zero ratio (so 1% != 0%)', () => {
    const bar = renderProgress(0.01, 10);
    expect(bar.startsWith('█')).toBe(true);
    expect(bar.length).toBe(10);
  });

  it('rounds 50% to 5 of 10 cells', () => {
    expect(renderProgress(0.5, 10)).toBe('█████░░░░░');
  });

  it('clamps ratios outside [0,1]', () => {
    expect(renderProgress(-0.5, 8)).toBe('░░░░░░░░');
    expect(renderProgress(1.7, 8)).toBe('████████');
  });

  it('keeps total width stable across all ratios', () => {
    for (let i = 0; i <= 10; i++) {
      expect(renderProgress(i / 10, 12).length).toBe(12);
    }
  });
});

describe('renderMeter (bracket-style)', () => {
  it('is empty at 0 and full at 1', () => {
    expect(renderMeter(0, 10)).toBe('[o.........]');
    expect(renderMeter(1, 10)).toBe('[0000000000]');
  });

  it('keeps total visual width stable across all ratios', () => {
    for (let i = 0; i <= 24; i++) {
      // Brackets add 2 chars: `[` + width cells + `]`
      expect([...renderMeter(i / 24, 12)].length).toBe(14);
    }
  });

  it('renders a fractional leading cell instead of jumping a whole cell', () => {
    // 1/24 × 12 cells = 0.5 → rounded to 1 filled cell
    const bar = renderMeter(1 / 12 / 2, 12);
    expect(bar).toBe('[0o..........]');
  });

  it('clamps out-of-range ratios', () => {
    expect(renderMeter(-1, 8)).toBe('[o.......]');
    expect(renderMeter(2, 8)).toBe('[00000000]');
  });
});

describe('tokenDisplayTotals', () => {
  it('falls back to current request input tokens when provider usage totals are zero', () => {
    expect(tokenDisplayTotals({ input: 0, output: 0 }, { input: 3210, cacheRead: 40, cacheWrite: 10 })).toEqual({
      input: 3260,
      output: 0,
    });
  });

  it('prefers accounted provider usage once it is available', () => {
    expect(
      tokenDisplayTotals(
        { input: 1000, output: 200, cacheRead: 300, cacheWrite: 400 },
        { input: 3210, cacheRead: 40, cacheWrite: 10 },
      ),
    ).toEqual({ input: 1700, output: 200 });
  });

  it('marks the token chip visible when only outgoing request tokens exist', () => {
    expect(hasTokenDisplay(tokenDisplayTotals(undefined, { input: 3210, cacheRead: 40, cacheWrite: 10 }))).toBe(true);
  });

  it('keeps the token chip hidden when no input or output tokens exist', () => {
    expect(hasTokenDisplay(tokenDisplayTotals({ input: 0, output: 0 }, undefined))).toBe(false);
  });
});
