import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { type EngineEvent, emptyEngineState, reduceEngine } from '../src/engine-state';
import { TranscriptMessage } from '../src/TranscriptMessage';

vi.mock('../src/platform', () => ({}));

const delta = (text: string): EngineEvent => ({
  type: 'provider.text_delta',
  payload: { messageId: 'current', text },
});
const work = (type: string, id: string): EngineEvent => ({
  type,
  payload: { id, name: 'read', input: { path: `${id}.ts` }, ok: true },
});
const fold = (events: EngineEvent[]) => events.reduce(reduceEngine, emptyEngineState);
const transcript = (state: ReturnType<typeof fold>) =>
  state.messages
    .map((message) =>
      renderToStaticMarkup(
        createElement(TranscriptMessage, {
          message,
          state,
          onLink: () => {},
          onOpenFile: () => {},
        }),
      ),
    )
    .join('');

describe('chronological chat work', () => {
  it('keeps ordinary token deltas together', () => {
    expect(fold([delta('One '), delta('message.')]).messages.map((m) => m.text)).toEqual([
      'One message.',
    ]);
  });

  it.each([false, true])(
    'interleaves separate tool groups and commentary, completed=%s',
    (completed) => {
      const events = [
        delta('First update.'),
        work('tool.started', 'first'),
        work('tool.executed', 'first'),
        { type: 'iteration.started', payload: { index: 1 } },
        delta('Second update.'),
        work('tool.started', 'second'),
        work('tool.executed', 'second'),
        delta('Final answer.'),
      ];
      if (completed)
        events.push({ type: 'run.result', payload: { status: 'done', iterations: 3 } });
      const state = fold(events);
      expect(state.messages.map((m) => m.text)).toEqual([
        'First update.',
        'Second update.',
        'Final answer.',
      ]);
      const html = transcript(state);
      expect(html.indexOf('first.ts')).toBeGreaterThan(html.indexOf('First update.'));
      expect(html.indexOf('first.ts')).toBeLessThan(html.indexOf('Second update.'));
      expect(html.indexOf('second.ts')).toBeGreaterThan(html.indexOf('Second update.'));
      expect(html.indexOf('second.ts')).toBeLessThan(html.indexOf('Final answer.'));
      // The shared overview and lossless input both name the file; tool calls still appear once.
      expect(html.match(/class="activity-entry activity-done"/g)?.length).toBe(2);
      expect(html.match(/<strong>read<\/strong>/g)?.length).toBe(2);
    },
  );

  it('keeps work before the first response beside the user prompt', () => {
    const state = fold([
      { type: 'desktop.user_message', payload: { id: 'u', content: 'Please inspect' } },
      work('tool.started', 'first'),
      work('tool.executed', 'first'),
      delta('Found it.'),
    ]);
    const html = transcript(state);
    expect(html.indexOf('first.ts')).toBeGreaterThan(html.indexOf('Please inspect'));
    expect(html.indexOf('first.ts')).toBeLessThan(html.indexOf('Found it.'));
  });

  it('starts a new message on the next provider response even without tools', () => {
    const state = fold([
      delta('First response.'),
      { type: 'provider.response', payload: {} },
      delta('Next response.'),
    ]);
    expect(state.messages.map((m) => m.text)).toEqual(['First response.', 'Next response.']);
  });
});
