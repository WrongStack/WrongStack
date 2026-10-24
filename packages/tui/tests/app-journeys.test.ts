import type { Message } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createAppJourney,
  createJourneyAgent,
  waitForJourney,
} from './helpers/app-journey-harness.js';

describe('top-level App journeys', () => {
  it('submits the boot prompt through App and commits user/assistant history', async () => {
    const journey = createAppJourney();
    vi.mocked(journey.agent.run).mockResolvedValue({
      status: 'done',
      iterations: 1,
      finalText: 'journey assistant response',
    });
    const view = journey.mount({
      enhanceEnabled: false,
      initialAsk: 'journey user prompt',
    });

    await waitForJourney(() => vi.mocked(journey.agent.run).mock.calls.length === 1);
    await waitForJourney(() => (view.lastFrame() ?? '').includes('journey assistant response'));

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('journey user prompt');
    expect(frame).toContain('journey assistant response');
    view.unmount();
  });

  it('rehydrates resumed messages through the top-level App history composition', async () => {
    const restoredMessages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'resumed user prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'resumed assistant answer' }] },
    ];
    const journey = createAppJourney(createJourneyAgent(restoredMessages));
    const view = journey.mount({ banner: false, restoredMessages });

    await waitForJourney(() => (view.lastFrame() ?? '').includes('resumed assistant answer'));

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('resumed user prompt');
    expect(frame).toContain('resumed assistant answer');
    expect(journey.agent.run).not.toHaveBeenCalled();
    view.unmount();
  });
});
