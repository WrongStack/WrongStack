import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTerminalTitle } from '../src/terminal-title.js';

/** A fake TTY stdout that records every written chunk. */
function fakeStdout(isTTY: boolean) {
  const writes: string[] = [];
  return {
    isTTY,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    writes,
  } as never as NodeJS.WriteStream & { writes: string[] };
}

// OSC-0 framing: ESC ] 0 ; <title> BEL. Built from char codes so the test
// source carries no literal control characters (biome lint).
const OSC_PREFIX = `${String.fromCharCode(27)}]0;`;
const BEL = String.fromCharCode(7);

/** Extract the title text from the last OSC-0 sequence written. */
function lastTitle(out: { writes: string[] }): string | undefined {
  for (let i = out.writes.length - 1; i >= 0; i--) {
    const w = out.writes[i]!;
    const start = w.indexOf(OSC_PREFIX);
    if (start === -1) continue;
    const end = w.indexOf(BEL, start + OSC_PREFIX.length);
    if (end === -1) continue;
    return w.slice(start + OSC_PREFIX.length, end);
  }
  return undefined;
}

describe('startTerminalTitle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    delete process.env['WRONGSTACK_NO_TITLE'];
  });

  it('is a no-op on a non-TTY stdout', () => {
    const out = fakeStdout(false);
    const { stop } = startTerminalTitle({ stdout: out, events: new EventBus(), model: 'm' });
    vi.advanceTimersByTime(500);
    expect(out.writes).toHaveLength(0);
    stop();
    expect(out.writes).toHaveLength(0);
  });

  it('honors WRONGSTACK_NO_TITLE=1', () => {
    process.env['WRONGSTACK_NO_TITLE'] = '1';
    const out = fakeStdout(true);
    const { stop } = startTerminalTitle({ stdout: out, events: new EventBus(), model: 'm' });
    vi.advanceTimersByTime(500);
    expect(out.writes).toHaveLength(0);
    stop();
  });

  it('shows the idle marquee before any activity', () => {
    const out = fakeStdout(true);
    const { stop } = startTerminalTitle({
      stdout: out,
      events: new EventBus(),
      model: 'claude-opus-4-8',
      intervalMs: 50,
    });
    vi.advanceTimersByTime(60);
    const t = lastTitle(out)!;
    expect(t).toBeTruthy();
    // marquee scrolls the app name; the ✦ marker or app text appears
    expect(/WrongStack|✦/.test(t)).toBe(true);
    stop();
  });

  it('switches to a tool status with the spinner + tool name', () => {
    const events = new EventBus();
    const out = fakeStdout(true);
    const { stop } = startTerminalTitle({ stdout: out, events, model: 'm', intervalMs: 50 });
    events.emit('tool.started', { name: 'bash', id: 'x' } as never);
    vi.advanceTimersByTime(60);
    const t = lastTitle(out)!;
    expect(t).toContain('▸ bash');
    stop();
  });

  it('falls back to idle after the activity window elapses', () => {
    const events = new EventBus();
    const out = fakeStdout(true);
    const { stop } = startTerminalTitle({
      stdout: out,
      events,
      model: 'm',
      intervalMs: 50,
      idleAfterMs: 200,
    });
    events.emit('tool.started', { name: 'grep', id: 'y' } as never);
    vi.advanceTimersByTime(60);
    expect(lastTitle(out)).toContain('▸ grep');
    // No further events; after idleAfterMs the title returns to the marquee.
    vi.advanceTimersByTime(400);
    expect(lastTitle(out)).not.toContain('▸ grep');
    stop();
  });

  it('resets to a static title on stop and unsubscribes', () => {
    const events = new EventBus();
    const out = fakeStdout(true);
    const { stop } = startTerminalTitle({
      stdout: out,
      events,
      model: 'claude-opus-4-8',
      intervalMs: 50,
      appName: 'WS',
    });
    vi.advanceTimersByTime(60);
    stop();
    expect(lastTitle(out)).toBe('WS');
    // After stop, further events must not write anything new.
    const before = out.writes.length;
    events.emit('tool.started', { name: 'bash', id: 'z' } as never);
    vi.advanceTimersByTime(200);
    expect(out.writes.length).toBe(before);
  });

  it('uses app name in the stop title', () => {
    const events = new EventBus();
    const out = fakeStdout(true);
    const { stop } = startTerminalTitle({
      stdout: out,
      events,
      model: 'claude-haiku-4-5-20251001',
      intervalMs: 50,
    });
    stop();
    expect(lastTitle(out)).toBe('WrongStack');
  });

  it('updates the idle title after setModel', () => {
    const out = fakeStdout(true);
    const { stop, setModel } = startTerminalTitle({
      stdout: out,
      events: new EventBus(),
      model: 'claude-opus-4-8',
      intervalMs: 50,
    });
    vi.advanceTimersByTime(60);
    // Idle title starts with the initial model.
    expect(lastTitle(out)).toContain('claude-opus-4-8');

    setModel('claude-haiku-4-5-20251001');
    // The next timer tick picks up the new model.
    vi.advanceTimersByTime(60);
    const t = lastTitle(out)!;
    expect(t).toContain('claude-haiku-4-5-20251001');
    expect(t).not.toContain('claude-opus-4-8');
    stop();
  });
});
