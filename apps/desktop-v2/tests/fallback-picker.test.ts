import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { FallbackPicker, fallbackPending } from '../src/FallbackPicker';

const pending = (timestamp: number) => ({
  sessionId: 's1',
  from: { providerId: 'zai', model: 'glm-5' },
  status: 429,
  candidates: [
    { providerId: 'openai', model: 'gpt-5' },
    { providerId: 'anthropic', model: 'claude' },
  ],
  autoSwitchSeconds: 7,
  requestId: 'r1',
  timestamp,
});

it('reads the gate request and its auto-switch deadline', () => {
  expect(fallbackPending(pending(1_000))).toMatchObject({
    requestId: 'r1',
    status: 429,
    deadline: 8_000,
    candidates: [{ providerId: 'openai' }, { providerId: 'anthropic' }],
  });
  expect(fallbackPending({ ...pending(0), candidates: [] })).toBeNull();
  expect(fallbackPending({ ...pending(0), requestId: '' })).toBeNull();
});

it('shows the pending choice until its deadline and hides an expired one', () => {
  const view = (timestamp: number) =>
    renderToStaticMarkup(
      createElement(FallbackPicker, {
        state: {
          ...emptyEngineState,
          results: { 'provider.fallback_pending': pending(timestamp) },
        },
        send: async () => {},
      }),
    );
  const live = view(Date.now());
  expect(live).toContain('zai / glm-5 failed (status 429)');
  expect(live).toContain('Switch now');
  expect(live).toContain('Use anthropic / claude');
  expect(view(Date.now() - 60_000)).toBe('');
});
