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

it('keeps the active draft row visible after shrinking a terminal with a long draft', async () => {
  const journey = createAppJourney();
  const tty = renderRealTty(<App {...journey.props} banner={false} enhanceEnabled={false} />, {
    columns: 40,
    rows: 24,
  });
  view = tty;
  const draft = `DRAFT-START ${'wrapped text '.repeat(39)}${' '.repeat(20)}DRAFT-END`;
  await vi.waitFor(() => expect(tty.lastFrame()).toContain('Enter send'));
  tty.stdin.write(draft);
  await vi.waitFor(() => expect(tty.lastFrame()).toContain('DRAFT-END'));
  tty.stdin.write('\x1b[H');
  await vi.waitFor(() => expect(tty.lastFrame()).toContain('DRAFT-START'));
  tty.resize(40, 8);
  await vi.waitFor(() => {
    expect(tty.lines().length).toBe(8);
    expect(tty.lastFrame()).toContain('DRAFT-START');
  });
  tty.stdin.write('\x1b[F');
  await vi.waitFor(() => expect(tty.lastFrame()).toContain('DRAFT-END'));
  tty.resize(40, 24);
  await vi.waitFor(() => expect(tty.lines().length).toBe(24));
  tty.stdin.write('\r');
  await vi.waitFor(() => expect(journey.agent.run, tty.lastFrame()).toHaveBeenCalledOnce());
  expect(vi.mocked(journey.agent.run).mock.calls[0]?.[0]).toEqual([{ type: 'text', text: draft }]);
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
