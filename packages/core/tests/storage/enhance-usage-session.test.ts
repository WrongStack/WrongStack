import type { SessionEvent, SessionMetadata } from '@wrongstack/contracts/types/session';
import { describe, expect, it } from 'vitest';
import { summarizeSessionEvents } from '../../src/storage/session-store/summary-builder.js';
import { SessionSummaryTracker } from '../../src/storage/session-summary-tracker.js';

const ts = '2026-01-01T00:00:00.000Z';
const baseMeta: SessionMetadata = {
  id: 's1',
  startedAt: ts,
  model: 'gpt-4',
  provider: 'openai',
};

const ev = (partial: { type: SessionEvent['type'] } & Record<string, unknown>): SessionEvent =>
  ({ ts, ...partial }) as SessionEvent;

describe('enhance_usage — refiner spend in the session cost pipeline', () => {
  it('live tracker folds enhance_usage into tokenTotal without messageCount or model changes', () => {
    const tracker = new SessionSummaryTracker({ id: 's1', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'user_input', content: 'hello brave world' }));
    tracker.observe(
      ev({
        type: 'llm_response',
        content: [],
        stopReason: 'end_turn',
        usage: { input: 100, output: 10 },
        model: 'gpt-4',
        provider: 'openai',
      }),
    );
    tracker.observe(
      ev({
        type: 'enhance_usage',
        usage: { input: 12, output: 8 },
        provider: 'openai',
        model: 'haiku-refiner',
      }),
    );
    const summary = tracker.snapshot();
    // 100 fresh agent input + 10 agent output + 12 + 8 refiner = 130.
    expect(summary.tokenTotal).toBe(130);
    // Only user_input + llm_response count as messages; refiner passes must not.
    expect(summary.messageCount).toBe(2);
    // The refiner model must never overwrite the session's routed model.
    expect(summary.model).toBe('gpt-4');
  });

  it('disk rebuild folds enhance_usage the same way as the live tracker', async () => {
    const events: SessionEvent[] = [
      ev({ type: 'user_input', content: 'hello brave world' }),
      ev({
        type: 'enhance_usage',
        usage: { input: 30, output: 10, cacheRead: 50 },
        provider: 'openai',
        model: 'haiku-refiner',
      }),
    ];
    const summary = await summarizeSessionEvents({
      id: 's1',
      events,
      mtime: '2026-01-01T00:00:03.000Z',
    });
    // effectiveInput = 30 fresh + 50 cacheRead; + 10 output = 90.
    expect(summary.tokenTotal).toBe(90);
    expect(summary.messageCount).toBe(1);
    expect(summary.model).not.toBe('haiku-refiner');
  });
});
