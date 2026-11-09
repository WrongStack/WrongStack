import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { chimeraFollowup, chimeraFollowupState } from '../src/chimera-followup';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { TranscriptMessage } from '../src/TranscriptMessage';

vi.mock('../src/platform', () => ({}));

const start = () =>
  reduceEngine(emptyEngineState, {
    type: 'session.start',
    payload: { sessionId: 'core-a', provider: 'local', model: 'test' },
  });
const report = (extra: Record<string, unknown> = {}) => ({
  type: 'chimera.report_available',
  at: 100,
  payload: {
    sessionId: 'core-a',
    reportId: 'review-1',
    message: 'Review needs attention',
    hasActionableFindings: true,
    ...extra,
  },
});

describe('conversation Chimera report', () => {
  it('marks refined follow-ups sent only after the engine accepts the real user message', () => {
    const original = chimeraFollowup('r');
    const pending = reduceEngine(
      { ...start(), synced: true },
      {
        type: 'desktop.user_message',
        payload: {
          id: 'u',
          requestId: 'rq',
          content: 'Refined instructions',
          journalRaw: original,
        },
      },
    );
    expect(chimeraFollowupState(pending, 'r', '', 0)).toBeNull();
    const accepted = reduceEngine(pending, {
      type: 'key.operation_result',
      payload: { requestId: 'rq', phase: 'user_message', success: true },
    });
    expect(chimeraFollowupState(accepted, 'r', '', 0)).toBe('sent');
    const refused = reduceEngine(pending, {
      type: 'key.operation_result',
      payload: { requestId: 'rq', phase: 'user_message', success: false },
    });
    expect(chimeraFollowupState(refused, 'r', '', 0)).toBeNull();
  });
  it('keeps ordinary conversation messages and refuses foreign or unowned report notices', () => {
    const state = reduceEngine(start(), {
      type: 'provider.text_delta',
      payload: { text: 'Hello', messageId: 'a' },
    });
    expect(state.messages[0]?.text).toBe('Hello');
    expect(reduceEngine(state, report({ sessionId: 'core-b' }))).toBe(state);
    expect(reduceEngine(state, report({ sessionId: undefined })).messages).toEqual(state.messages);
    expect(reduceEngine(state, report({ hasActionableFindings: false })).messages).toEqual(
      state.messages,
    );
  });

  it('puts one actionable report into its own transcript, including journal replay', () => {
    const state = reduceEngine(start(), report());
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: 'chimera:review-1',
      text: 'Review needs attention',
      chimera: { reportId: 'review-1', sessionId: 'core-a' },
    });
    expect(reduceEngine(state, report()).messages).toEqual(state.messages);
    const html = renderToStaticMarkup(
      createElement(TranscriptMessage, {
        message: state.messages[0]!,
        state: { turnActivity: {}, turnStats: {} },
        onLink: () => {},
        onOpenFile: () => {},
        chimeraAction: { run: () => {} },
        onOpenChimera: () => {},
      }),
    );
    expect(html).toContain('Prepare follow-up');
    expect(html).toContain('Open report');
    expect(html).not.toContain('Show source');
  });

  it('does not inject historical query results as new chat messages', () => {
    expect(
      reduceEngine(start(), {
        type: 'chimera.reports',
        payload: { sessionId: 'core-a', reports: [{ reportId: 'old' }] },
      }).messages,
    ).toEqual([]);
  });
});
