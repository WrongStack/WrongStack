import type { Message } from '@wrongstack/contracts/types';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import type { Settings } from '../src/app-state.js';
import { SETTINGS_DEFAULTS } from '../src/components/settings-picker-model.js';
import { createAppJourney, createJourneyAgent } from './helpers/app-journey-harness.js';
import { type RealTtyView, renderRealTty } from './helpers/real-tty.js';

let view: RealTtyView | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

it('keeps the reader position after idle time and follows new output only after paging to the tail', async () => {
  vi.useFakeTimers();
  const restoredMessages: Message[] = Array.from({ length: 50 }, (_, index) => ({
    role: 'assistant',
    content: [{ type: 'text', text: `READ-${String(index + 1).padStart(2, '0')} transcript line` }],
  }));
  const journey = createAppJourney(createJourneyAgent(restoredMessages));
  const settings: Settings = {
    ...SETTINGS_DEFAULTS,
    fleetChatVerbosity: 'off',
    featureTokenSaving: 'off',
    lastSettingsField: 67,
    showSidebar: false,
  };
  const tty = renderRealTty(
    <App
      {...journey.props}
      banner={false}
      restoredMessages={restoredMessages}
      getSettings={() => settings}
    />,
    { columns: 80, rows: 24 },
  );
  view = tty;
  await vi.advanceTimersByTimeAsync(300);
  expect(tty.lastFrame()).toContain('READ-50'); // Valid control: initially follows the tail.
  tty.stdin.write('\x1b[5~');
  await vi.advanceTimersByTimeAsync(300);
  const markers = () => tty.lastFrame().match(/READ-\d+/g);
  const selected = markers();
  expect(selected?.length).toBeGreaterThan(0);
  expect(tty.lastFrame()).not.toContain('READ-50');
  await vi.advanceTimersByTimeAsync(31_000);
  expect(markers()).toEqual(selected);

  // Explicit PageDown re-pins; a new submission's response then stays visible.
  for (let page = 0; page < 20 && !tty.lastFrame().includes('READ-50'); page++) {
    tty.stdin.write('\x1b[6~');
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(tty.lastFrame()).toContain('READ-50');
  vi.mocked(journey.agent.run).mockResolvedValueOnce({
    status: 'done',
    iterations: 1,
    finalText: 'NEW-LIVE-TAIL',
  });
  tty.stdin.write('hello\r');
  await vi.advanceTimersByTimeAsync(500);
  expect(tty.lastFrame()).toContain('NEW-LIVE-TAIL');
});
