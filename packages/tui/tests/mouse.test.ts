import { describe, expect, it } from 'vitest';
import {
  MOUSE_CLICK_ON,
  MOUSE_DRAG_ON,
  MOUSE_HOVER_ON,
  MOUSE_OFF,
  isLeakedMouseInput,
  parseMouseEvent,
  parseMouseEvents,
  shouldEnableMouseTracking,
} from '../src/mouse.js';

const ESC = String.fromCharCode(27);
// Build an SGR mouse report: ESC [ < Cb ; Cx ; Cy (M|m)
const sgr = (cb: number, x: number, y: number, final: 'M' | 'm' = 'M') =>
  `${ESC}[<${cb};${x};${y}${final}`;

describe('mouse enable/disable sequences', () => {
  it('enables SGR coordinates (1006) and never touches the alt buffer (1049)', () => {
    for (const seq of [MOUSE_CLICK_ON, MOUSE_DRAG_ON, MOUSE_HOVER_ON]) {
      expect(seq).toContain('?1006h');
      expect(seq).toContain('?1000h');
      expect(seq).not.toContain('1049'); // stays in the normal screen buffer
    }
    expect(MOUSE_HOVER_ON).toContain('?1003h'); // any-event tracking for hover
    expect(MOUSE_CLICK_ON).not.toContain('?1003h'); // click mode is cheap
  });

  it('MOUSE_OFF disables every tracking mode it can enable', () => {
    for (const mode of ['1000', '1002', '1003', '1006']) {
      expect(MOUSE_OFF).toContain(`?${mode}l`);
    }
  });
});

describe('shouldEnableMouseTracking', () => {
  it('keeps full mouse mode active without an overlay', () => {
    expect(
      shouldEnableMouseTracking({
        fullMode: true,
        overlayOpen: false,
        managedHistory: true,
        protocol: 'sgr',
      }),
    ).toBe(true);
  });

  it('keeps tracking active for managed history while full mode is off', () => {
    expect(
      shouldEnableMouseTracking({
        fullMode: false,
        overlayOpen: false,
        managedHistory: true,
        protocol: 'sgr',
      }),
    ).toBe(true);
  });

  it('borrows tracking for overlays without managed history', () => {
    expect(
      shouldEnableMouseTracking({
        fullMode: false,
        overlayOpen: true,
        managedHistory: false,
        protocol: 'sgr',
      }),
    ).toBe(true);
    expect(
      shouldEnableMouseTracking({
        fullMode: false,
        overlayOpen: false,
        managedHistory: false,
        protocol: 'sgr',
      }),
    ).toBe(false);
  });

  it.each(['none', 'x10', 'urxvt'] as const)(
    'never enables SGR tracking for the unsupported %s protocol',
    (protocol) => {
      expect(
        shouldEnableMouseTracking({
          fullMode: true,
          overlayOpen: true,
          managedHistory: true,
          protocol,
        }),
      ).toBe(false);
    },
  );

  it('keeps compatibility when no capability profile was provided', () => {
    expect(
      shouldEnableMouseTracking({
        fullMode: true,
        overlayOpen: false,
        managedHistory: true,
      }),
    ).toBe(true);
  });
});

describe('parseMouseEvent', () => {
  it('returns null for non-mouse data', () => {
    expect(parseMouseEvent('a')).toBeNull();
    expect(parseMouseEvent(`${ESC}[A`)).toBeNull(); // arrow up
    expect(parseMouseEvent(`${ESC}[<64;10`)).toBeNull(); // incomplete
  });

  it('decodes wheel up (cb=64) and down (cb=65)', () => {
    expect(parseMouseEvent(sgr(64, 5, 7))).toMatchObject({
      kind: 'wheel',
      button: 'none',
      wheel: 1,
      x: 5,
      y: 7,
    });
    expect(parseMouseEvent(sgr(65, 5, 7))).toMatchObject({ kind: 'wheel', wheel: -1 });
  });

  it('decodes left/middle/right press with 1-based coords', () => {
    expect(parseMouseEvent(sgr(0, 12, 3))).toMatchObject({
      kind: 'press',
      button: 'left',
      x: 12,
      y: 3,
      wheel: 0,
    });
    expect(parseMouseEvent(sgr(1, 1, 1))).toMatchObject({ kind: 'press', button: 'middle' });
    expect(parseMouseEvent(sgr(2, 1, 1))).toMatchObject({ kind: 'press', button: 'right' });
  });

  it('distinguishes release (final "m") from press (final "M")', () => {
    expect(parseMouseEvent(sgr(0, 4, 4, 'm'))).toMatchObject({ kind: 'release', button: 'left' });
    expect(parseMouseEvent(sgr(0, 4, 4, 'M'))).toMatchObject({ kind: 'press', button: 'left' });
  });

  it('decodes drag (motion +32 with a button held)', () => {
    const ev = parseMouseEvent(sgr(0 + 32, 9, 9)); // left button + motion
    expect(ev).toMatchObject({ kind: 'move', button: 'left', motion: true });
  });

  it('decodes free hover (motion +32 with no button = low bits 3)', () => {
    const ev = parseMouseEvent(sgr(3 + 32, 20, 2)); // none + motion
    expect(ev).toMatchObject({ kind: 'move', button: 'none', motion: true });
  });

  it('decodes shift/meta/ctrl modifier bits', () => {
    const ev = parseMouseEvent(sgr(0 + 4 + 8 + 16, 1, 1)); // left + shift + meta + ctrl
    expect(ev).toMatchObject({ shift: true, meta: true, ctrl: true, button: 'left' });
    const plain = parseMouseEvent(sgr(0, 1, 1));
    expect(plain).toMatchObject({ shift: false, meta: false, ctrl: false });
  });

  it('anchored parse rejects a chunk with extra bytes', () => {
    // The real regression: a batched/decorated chunk must NOT parse as one event.
    expect(parseMouseEvent(sgr(64, 1, 1) + sgr(65, 1, 1))).toBeNull();
  });
});

describe('parseMouseEvents (batched scan)', () => {
  it('extracts every report from a coalesced wheel-scroll chunk', () => {
    const chunk = sgr(64, 5, 5) + sgr(64, 5, 5) + sgr(65, 5, 5);
    const evs = parseMouseEvents(chunk);
    expect(evs.map((e) => e.wheel)).toEqual([1, 1, -1]);
  });

  it('returns [] for non-mouse data', () => {
    expect(parseMouseEvents('hello')).toEqual([]);
    expect(parseMouseEvents(`${ESC}[A`)).toEqual([]);
  });

  it('finds a report even with surrounding noise', () => {
    expect(parseMouseEvents(`x${sgr(2, 7, 8)}`)).toMatchObject([{ button: 'right', x: 7, y: 8 }]);
  });
});

describe('isLeakedMouseInput', () => {
  it('matches the ESC-stripped form Ink inserts as text', () => {
    // Ink strips the leading ESC: "\x1b[<64;10;5M" -> "[<64;10;5M".
    expect(isLeakedMouseInput('[<64;10;5M')).toBe(true);
    expect(isLeakedMouseInput('[<0;3;4m')).toBe(true);
    // Batched leak (fast scroll) keeps inner ESCs but still contains the core.
    expect(isLeakedMouseInput(`[<64;1;1M${ESC}[<64;1;1M`)).toBe(true);
  });

  it('does not match ordinary typed text', () => {
    expect(isLeakedMouseInput('hello world')).toBe(false);
    expect(isLeakedMouseInput('a < b ; c')).toBe(false);
    expect(isLeakedMouseInput('')).toBe(false);
  });
});
