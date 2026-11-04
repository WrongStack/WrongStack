import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { NextStepsPanel } from '../src/NextStepsPanel';

describe('completed-turn suggestions', () => {
  it('projects canonical suggestions only after a successful turn and clears them on a new accepted turn', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 'one' },
    });
    state = reduceEngine(state, {
      type: 'provider.text_delta',
      payload: {
        sessionId: 'one',
        messageId: 'current',
        text: 'Working\n<nextsteps>\n1. Review the diff\n2. Run tests\n</nextsteps>',
      },
    });
    expect(state.nextSteps).toEqual([]);
    state = reduceEngine(state, {
      type: 'run.result',
      payload: {
        sessionId: 'one',
        status: 'done',
        finalText: 'Done.\n<nextsteps>\n1. Review the diff\n2. Run tests\n</nextsteps>',
      },
    });
    expect(state.nextSteps.map((step) => step.text)).toEqual(['Review the diff', 'Run tests']);
    const html = renderToStaticMarkup(
      createElement(NextStepsPanel, { steps: state.nextSteps, onAdd: () => {} }),
    );
    for (const text of [
      'Suggested next steps',
      'Review the diff',
      'Run tests',
      'Add selected to draft',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('Your message');
    const sendable = renderToStaticMarkup(
      createElement(NextStepsPanel, {
        steps: state.nextSteps,
        onAdd: () => {},
        onSend: async () => true,
      }),
    );
    expect(sendable).toContain('Your message');
    expect(sendable).toMatch(/disabled="">.*Send 0 steps<\/button>/s);
    state = reduceEngine(state, {
      type: 'desktop.user_message',
      payload: { sessionId: 'one', id: 'new', content: 'Continue' },
    });
    expect(state.nextSteps).toEqual([]);
  });
  it('accepts only successful nextsteps tool results from the current run and clears them on context reset', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 'one' },
    });
    state = reduceEngine(state, {
      type: 'tool.started',
      payload: {
        sessionId: 'one',
        id: 'tool-1',
        name: 'nextsteps',
        input: { steps: [{ text: 'Inspect results' }, { text: 'Run checks' }] },
      },
    });
    state = reduceEngine(state, {
      type: 'tool.executed',
      payload: { sessionId: 'one', id: 'tool-1', name: 'nextsteps', ok: false },
    });
    state = reduceEngine(state, {
      type: 'run.result',
      payload: { sessionId: 'one', status: 'done', finalText: 'No suggestions.' },
    });
    expect(state.nextSteps).toEqual([]);
    state = reduceEngine(state, {
      type: 'tool.started',
      payload: {
        sessionId: 'one',
        id: 'tool-2',
        name: 'nextsteps',
        input: { steps: [{ text: 'Inspect results' }] },
      },
    });
    state = reduceEngine(state, {
      type: 'tool.executed',
      payload: { sessionId: 'one', id: 'tool-2', name: 'nextsteps', ok: true },
    });
    state = reduceEngine(state, {
      type: 'run.result',
      payload: { sessionId: 'one', status: 'done', finalText: 'Done.' },
    });
    expect(state.nextSteps.map((step) => step.text)).toEqual(['Inspect results']);
    state = reduceEngine(state, {
      type: 'session.start',
      payload: { sessionId: 'one', reset: true },
    });
    expect(state.nextSteps).toEqual([]);
  });
  it('does not invent suggestions from incomplete, failed, fenced or foreign-session output', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 'one' },
    });
    state = reduceEngine(state, {
      type: 'run.result',
      payload: {
        sessionId: 'other',
        status: 'done',
        finalText: '<nextsteps>\n1. Other project\n</nextsteps>',
      },
    });
    expect(state.nextSteps).toEqual([]);
    state = reduceEngine(state, {
      type: 'run.result',
      payload: {
        sessionId: 'one',
        status: 'failed',
        finalText: '<nextsteps>\n1. Never offer\n</nextsteps>',
      },
    });
    expect(state.nextSteps).toEqual([]);
    state = reduceEngine(state, {
      type: 'run.result',
      payload: {
        sessionId: 'one',
        status: 'done',
        finalText: '```\n<nextsteps>\n1. Example only\n</nextsteps>\n```',
      },
    });
    expect(state.nextSteps).toEqual([]);
  });
});
