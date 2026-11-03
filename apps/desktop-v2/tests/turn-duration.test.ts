import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { AgentWorking, TurnTools } from '../src/TurnTools';

vi.mock('../src/platform', () => ({}));

describe('turn duration', () => {
  it('measures a turn from its first iteration to its result', () => {
    let state = { ...emptyEngineState, sessionId: 's', connected: true };
    state = reduceEngine(state, {
      type: 'desktop.user_message',
      payload: { id: 'u', content: 'go' },
      at: 500,
    });
    state = reduceEngine(state, { type: 'iteration.started', payload: {}, at: 1_000 });
    expect(state.runStartAt).toBe(1_000);
    state = reduceEngine(state, { type: 'iteration.started', payload: {}, at: 2_000 });
    expect(state.runStartAt).toBe(1_000);
    state = reduceEngine(state, { type: 'provider.text_delta', payload: { text: 'done' } });
    state = reduceEngine(state, {
      type: 'run.result',
      payload: { status: 'done', iterations: 2 },
      at: 64_000,
    });
    const answer = state.messages.at(-1);
    expect(answer?.role).toBe('assistant');
    expect(state.turnStats[answer!.id]).toMatchObject({ iterations: 2, durationMs: 63_000 });
    expect(state.runStartAt).toBeNull();
    const html = renderToStaticMarkup(
      createElement(TurnTools, {
        events: [],
        stats: state.turnStats[answer!.id],
        onOpenFile: () => {},
      }),
    );
    expect(html).toContain('2 iterations · 1 min 03 s');
  });

  it('formats seconds, minutes and hours', () => {
    const meta = (durationMs: number) =>
      renderToStaticMarkup(
        createElement(TurnTools, {
          events: [],
          stats: { iterations: 0, prompt: 0, output: 0, cacheRead: 0, durationMs },
          onOpenFile: () => {},
        }),
      );
    expect(meta(400)).toContain('>0 s<');
    expect(meta(42_000)).toContain('>42 s<');
    expect(meta(185_000)).toContain('>3 min 05 s<');
    expect(meta(3_720_000)).toContain('>1 h 02 min<');
  });

  it('shows how long the running turn has run, when the journal knows its start', () => {
    const since = Date.now() - 12_000;
    expect(renderToStaticMarkup(createElement(AgentWorking, { waiting: false, since }))).toMatch(
      /WrongStack is working…<span class="agent-working-elapsed"> 1[23] s<\/span>/,
    );
    expect(
      renderToStaticMarkup(createElement(AgentWorking, { waiting: true, since: null })),
    ).not.toContain('agent-working-elapsed');
  });
});
