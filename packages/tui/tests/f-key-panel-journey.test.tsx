import type { Agent, RunResult } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import { App, type Settings } from '../src/app.js';
import { SETTINGS_DEFAULTS } from '../src/components/settings-picker-model.js';
import { DEFAULT_PANEL_POSITIONS } from '../src/ui-contracts.js';
import {
  createAppJourney,
  createJourneyAgent,
  waitForJourney,
} from './helpers/app-journey-harness.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

vi.mock('@wrongstack/kanban', async (original) => ({
  ...(await original<typeof import('@wrongstack/kanban')>()),
  listBoards: vi.fn(async () => []),
}));
const panels = [
  ['F1', '\x1bOP', 'PROJECTS'],
  ['F2', '\x1bOQ', 'FLEET CONTROL'],
  ['F3', '\x1bOR', 'AGENTS'],
  ['F4', '\x1bOS', 'WORKTREES'],
  ['F5', '\x1b[15~', 'PLAN'],
  ['F6', '\x1b[17~', 'TODOS'],
  ['F7', '\x1b[18~', 'MESSAGE QUEUE'],
  ['F8', '\x1b[19~', 'PROCESSES'],
  ['F9', '\x1b[20~', 'GOAL'],
  ['F10', '\x1b[21~', 'SESSIONS'],
  ['F11', '\x1b[23~', 'COORDINATOR'],
  ['F12', '\x1b[24~', 'KANBAN'],
] as const;

describe('F1-F12 application journey', () => {
  it('moves a configured sidebar panel into the main area on width-only shrink and restores its placement on expansion', async () => {
    const journey = createAppJourney();
    const settings: Settings = {
      ...SETTINGS_DEFAULTS,
      fleetChatVerbosity: 'off',
      featureTokenSaving: 'off',
      lastSettingsField: 67,
      panelPositions: {
        ...DEFAULT_PANEL_POSITIONS,
        fleet: 'sidebar',
        worktree: 'sidebar',
      },
    };
    const view = renderRealTty(
      <App {...journey.props} banner={false} getSettings={() => settings} />,
      {
        columns: 84,
        rows: 24,
      },
    );
    try {
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Enter send'));
      view.stdin.write('preserved draft');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('preserved draft'));
      view.stdin.write('\x1bOQ');
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('AGENT SWARM');
        expect(view.lastFrame()).toContain('preserved draft');
      });
      view.resize(56, 24);
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('FLEET CONTROL');
        expect(view.lastFrame()).not.toContain('preserved draft');
      });
      view.stdin.write('z');
      view.resize(84, 24);
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('AGENT SWARM');
        expect(view.lastFrame()).not.toContain('FLEET CONTROL');
        expect(view.lastFrame()).toContain('preserved draft');
        expect(view.lastFrame()).not.toContain('preserved draftz');
      });
      view.resize(56, 24);
      await vi.waitFor(() => expect(view.lastFrame()).toContain('FLEET CONTROL'));
      view.stdin.write('\x1bOS');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('WORKTREES'));
      view.stdin.write('\x1b');
      await vi.waitFor(() => {
        expect(view.lastFrame()).not.toContain('WORKTREES');
        expect(view.lastFrame()).toContain('preserved draft');
      });
    } finally {
      view.unmount();
    }
  });

  it('keeps the project selection and fleet exit controls visible after shrinking to eight rows', async () => {
    const journey = createAppJourney();
    const view = renderRealTty(
      <App
        {...journey.props}
        banner={false}
        getProjectPickerItems={async () => [
          { key: 'first', label: 'First project', kind: 'project' },
          { key: 'second', label: 'Second project', kind: 'project' },
        ]}
      />,
      { columns: 40, rows: 24 },
    );
    try {
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Enter send'));
      view.stdin.write('\x1bOP');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('First project'));
      view.stdin.write('\x1b[B');
      await vi.waitFor(() => expect(view.lastFrame()).toMatch(/▎[^\n]*Second project/));
      view.resize(40, 8);
      await vi.waitFor(() => {
        const frame = view.lastFrame();
        expect(view.lines()).toHaveLength(8);
        expect(frame).toContain('PROJECTS');
        expect(frame).toMatch(/▎[^\n]*Second project/);
        expect(frame).toContain('F1/Esc');
      });
      view.stdin.write('\x1bOQ');
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('FLEET CONTROL');
        expect(view.lastFrame()).toContain('F2/Esc');
      });
      view.stdin.write('\x1b');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Enter send'));
      expect(view.lastFrame()).not.toContain('FLEET CONTROL');
    } finally {
      view.unmount();
    }
  });

  it.each([
    [120, 40],
    [80, 24],
    [52, 16],
    [40, 10],
  ])('visits every panel at %ix%i during a live run', async (columns, rows) => {
    let signal: AbortSignal | undefined;
    const agent = createJourneyAgent() as Agent;
    agent.run = vi.fn(
      async (_blocks, options) =>
        new Promise<RunResult>((resolve) => {
          signal = options?.signal;
          signal?.addEventListener('abort', () => resolve({ status: 'aborted', iterations: 0 }));
        }),
    );
    const journey = createAppJourney(agent);
    const view = renderRealTty(
      <App
        {...journey.props}
        initialAsk="hold this run"
        getProjectPickerItems={async () => [
          { key: 'project', label: 'Audit project', kind: 'project' },
        ]}
        getLiveSessions={async () => []}
      />,
      { columns, rows },
    );
    try {
      await waitForJourney(() => signal !== undefined);
      // A fixed settle is not a render barrier: when the event loop stalls past
      // the settle deadline (loaded CI/coverage run), Ink's 20ms Esc flush and
      // the settle timer expire in the same timers phase, so the assertion runs
      // before React commits the frame. Poll for the frame instead; a panel
      // that never opens/closes still fails at the timeout.
      const untilFrame = (assertion: () => void) =>
        vi.waitFor(assertion, { timeout: 5_000, interval: 20 });
      for (const [key, sequence, title] of panels) {
        view.stdin.write(sequence);
        await settle(150);
        await untilFrame(() => expect(view.lastFrame(), `${key} opened`).toContain(title));
        const failure = view.stdout.frames
          .join('\n')
          .match(/(?:ERROR|Maximum update depth)[\s\S]{0,1400}/)?.[0];
        expect(failure, `${key} opened at ${columns}x${rows}`).toBeUndefined();
        expect(signal?.aborted, `${key} did not abort work`).toBe(false);
        view.stdin.write('\x1b[B');
        view.stdin.write('\x1b[A');
        await settle(50);
        view.resize(columns, rows - 2);
        await settle(100);
        await untilFrame(() => {
          const frame = view.lastFrame();
          expect(frame, `${key} survives resize`).toContain(title);
          expect(frame, `${key} shows how to close after resize`).toContain('Esc');
        });
        view.resize(columns, rows);
        await settle(100);
        view.stdin.write('\x1b');
        await settle(150);
        await untilFrame(() =>
          expect(view.lastFrame(), `${key} closes with Esc`).not.toContain(title),
        );
        expect(signal?.aborted, `${key} close did not abort work`).toBe(false);
      }
    } finally {
      view.unmount();
    }
  });
});
