import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/components/input.js';
import type { ComposerStatus } from '../src/components/composer-status-chip.js';
import { displayWidth, stripAnsi } from '../src/terminal-width.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Render <Input> and return the top-rail line (first frame line, ANSI-stripped by displayWidth). */
function topRail(status: ComposerStatus): string {
  const { lastFrame, unmount } = render(
    React.createElement(Input, {
      value: '',
      cursor: 0,
      status,
      onKey: () => {},
    }),
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame.split('\n')[0] ?? '';
}

describe('<Input> composer top rail', () => {
  it('renders the idle chip flat inside a corner-to-corner rail', () => {
    const rail = topRail({ kind: 'idle', fleetRunning: 0 });
    expect(rail.trimEnd().startsWith('╭')).toBe(true);
    expect(rail.trimEnd().endsWith('╮')).toBe(true);
    expect(rail).toContain('ASK WRONGSTACK');
    expect(rail).toContain('idle');
  });

  it('keeps the rail the same total width for idle vs a wide working word', () => {
    // The chip pads to a stable reserved slot, so different statuses must not
    // change the overall rail width (which would jitter the right corner).
    const idle = displayWidth(topRail({ kind: 'idle', fleetRunning: 0 }).trimEnd());
    const working = displayWidth(topRail({ kind: 'working', word: 'contemplating' }).trimEnd());
    expect(working).toBe(idle);
  });

  it('surfaces the working word and the background fleet fallback', () => {
    expect(topRail({ kind: 'working', word: 'cooking' })).toContain('cooking');
    expect(topRail({ kind: 'idle', fleetRunning: 2 })).toContain('agents >2');
    expect(topRail({ kind: 'confirm' })).toContain('CONFIRM');
  });

  it('keeps both corners when the agent count label grows', () => {
    const rail = topRail({ kind: 'idle', fleetRunning: 123_456_789 });
    expect(displayWidth(rail.trimEnd())).toBe(100);
    expect(rail.trimEnd()).toMatch(/^╭.*╮$/);
    expect(rail).toContain('agents >123456789');
  });

  it('animates the activity icon before ASK WRONGSTACK while working', () => {
    // The left icon pulses through an "energy orb" while the agent works, so it
    // must visibly change over time (never freeze on a single glyph).
    vi.useFakeTimers();
    const view = render(
      React.createElement(Input, {
        value: '',
        cursor: 0,
        status: { kind: 'working', word: 'thinking' },
        onKey: () => {},
      }),
    );
    const leadGlyph = (): string => {
      const line = stripAnsi((view.lastFrame() ?? '').split('\n')[0] ?? '');
      return line.match(/─ (\S+) ASK WRONGSTACK/)?.[1] ?? '';
    };
    const seen = new Set<string>();
    seen.add(leadGlyph());
    for (let i = 0; i < 10; i++) {
      act(() => vi.advanceTimersByTime(130));
      seen.add(leadGlyph());
    }
    // Pulses through several distinct orb frames — not a frozen icon.
    expect(seen.size).toBeGreaterThan(1);
    const ORB = new Set(['·', '◦', '•', '●', '◉']);
    for (const g of seen) expect(ORB.has(g)).toBe(true);
    view.unmount();
  });

  it('rests on a steady brand glyph before ASK WRONGSTACK when idle', () => {
    vi.useFakeTimers();
    const view = render(
      React.createElement(Input, {
        value: '',
        cursor: 0,
        status: { kind: 'idle', fleetRunning: 0 },
        onKey: () => {},
      }),
    );
    const line = (): string => stripAnsi((view.lastFrame() ?? '').split('\n')[0] ?? '');
    expect(line()).toContain('◆ ASK WRONGSTACK');
    act(() => vi.advanceTimersByTime(500));
    // Idle never animates — the glyph must not drift.
    expect(line()).toContain('◆ ASK WRONGSTACK');
    view.unmount();
  });
});
