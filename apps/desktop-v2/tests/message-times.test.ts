import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { displayLocale } from '../src/display-dates';
import { emptyEngineState, reduceEngine, replayEngineBatch } from '../src/engine-state';
import { TranscriptMessage } from '../src/TranscriptMessage';
import { dayLabel } from '../src/transcript-window';

vi.mock('../src/platform', () => ({}));

const base = { ...emptyEngineState, sessionId: 's', connected: true };

describe('message times', () => {
  it('gives a message the time of the frame that added it, or the latest time seen', () => {
    let state = reduceEngine(base, {
      type: 'desktop.user_message',
      payload: { id: 'u1', content: 'hello' },
      at: 1_000,
    });
    expect(state.messages[0]).toMatchObject({ id: 'u1', at: 1_000 });
    state = reduceEngine(state, { type: 'iteration.started', payload: {}, at: 2_000 });
    // A token delta carries no time: the answer it starts takes the latest one.
    state = reduceEngine(state, { type: 'provider.text_delta', payload: { text: 'hi' } });
    state = reduceEngine(state, { type: 'provider.text_delta', payload: { text: '!' } });
    expect(state.messages[1]).toMatchObject({ role: 'assistant', text: 'hi!', at: 2_000 });
    expect(state.lastAt).toBe(2_000);
  });

  it('keeps the frame time through a replayed journal page and leaves older journals untimed', () => {
    const replayed = replayEngineBatch(
      base,
      [{ type: 'desktop.user_message', payload: { id: 'u1', content: 'x' }, at: 5_000 }],
      false,
    );
    expect(replayed.messages[0]?.at).toBe(5_000);
    const old = reduceEngine(base, {
      type: 'desktop.user_message',
      payload: { id: 'u2', content: 'y' },
    });
    expect(old.messages[0]?.at).toBeUndefined();
  });

  it('separates days and names today and yesterday', () => {
    const now = new Date(2026, 10, 3, 15, 0).getTime();
    const today = new Date(2026, 10, 3, 9, 30).getTime();
    const yesterday = new Date(2026, 10, 2, 22, 0).getTime();
    expect(dayLabel({ at: today }, undefined, now)).toBe('Today');
    expect(dayLabel({ at: today }, { at: today - 60_000 }, now)).toBeUndefined();
    expect(dayLabel({ at: today }, { at: yesterday }, now)).toBe('Today');
    expect(dayLabel({ at: yesterday }, undefined, now)).toBe('Yesterday');
    expect(dayLabel({}, undefined, now)).toBeUndefined();
    expect(dayLabel({ at: new Date(2026, 9, 1).getTime() }, undefined, now)).toBe(
      new Date(2026, 9, 1).toLocaleDateString(displayLocale(), {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }),
    );
  });

  it('shows the time beside the author and the day before the message', () => {
    const at = new Date(2026, 10, 3, 9, 5).getTime();
    const html = renderToStaticMarkup(
      createElement(TranscriptMessage, {
        message: { id: 'm', role: 'user', text: 'hi', at },
        state: { turnActivity: {}, turnStats: {} },
        onLink: () => {},
        onOpenFile: () => {},
        day: 'Today',
      }),
    );
    expect(html).toContain('<div class="chat-day"><span>Today</span></div>');
    expect(html).toContain(`<time dateTime="${new Date(at).toISOString()}"`);
    expect(html).toContain(
      new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    );
  });
});
