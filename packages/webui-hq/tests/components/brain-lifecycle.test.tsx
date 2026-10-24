// @vitest-environment jsdom

import type { HqBrainEventPayload } from '@wrongstack/hq';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('../../src/domain/use-backfilled-events.js', () => ({
  useBackfilledEvents: () => ({ events: state.events, loading: false }),
}));

import { BrainView } from '../../src/views/brain.js';

function event(kind: HqBrainEventPayload['kind'], at: number, extra = {}, sessionId = 's1') {
  return {
    id: `${sessionId}-${at}`,
    clientId: 'host',
    sessionId,
    timestamp: new Date(at).toISOString(),
    type: 'brain.event',
    payload: { kind, requestId: 'same-request', at, ...extra },
  };
}

function textFor(events: unknown[]): string {
  state.events = events;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<BrainView />));
    return container.textContent ?? '';
  } finally {
    act(() => root.unmount());
  }
}

describe('Brain dashboard lifecycle', () => {
  it('removes answered prompts from the waiting count regardless of arrival order', () => {
    expect(
      textFor([event('decision_answered', 20), event('decision_ask_human', 10, { pending: true })]),
    ).not.toContain('waiting on a human');
  });

  it('keeps independent sessions pending and deduplicates prompt events', () => {
    expect(
      textFor([
        event('decision_ask_human', 10, { pending: true }),
        event('decision_ask_human', 11, { pending: true }),
        event('decision_answered', 20, {}, 's2'),
      ]),
    ).toContain('1 waiting on a human');
  });

  it('flags a failed council even without diversity warnings', () => {
    expect(textFor([event('council_resolved', 10, { decision: 'failed' })])).toContain(
      '1 degraded panel(s)',
    );
  });
});
