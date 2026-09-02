import { EventBus } from '@wrongstack/core/kernel';
import type { Message, SessionEvent } from '@wrongstack/core/types';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { History } from '../src/components/history/index.js';
import type { HistoryEntry } from '../src/components/history/types.js';
import { createAppJourney, createJourneyAgent } from './helpers/app-journey-harness.js';

const reconstructionSpies = vi.hoisted(() => ({
  entries: vi.fn(),
  checkpoints: vi.fn(),
}));

vi.mock('../src/app-initial-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app-initial-state.js')>();
  return {
    ...actual,
    buildRestoredEntries: reconstructionSpies.entries.mockImplementation(
      actual.buildRestoredEntries,
    ),
    buildRestoredCheckpoints: reconstructionSpies.checkpoints.mockImplementation(
      actual.buildRestoredCheckpoints,
    ),
  };
});

function ResumeRerenderHarness({
  props,
  events,
}: {
  props: React.ComponentProps<typeof App>;
  events: EventBus;
}): React.ReactElement {
  const [, setTimerRender] = React.useState(0);
  const [, setStreamRender] = React.useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => setTimerRender((tick) => tick + 1), 25);
    return () => clearInterval(timer);
  }, []);
  React.useEffect(
    () => events.on('provider.text_delta', () => setStreamRender((tick) => tick + 1)),
    [events],
  );

  return React.createElement(App, { ...props, events });
}

describe('Issue 005 — resumed history rendering', () => {
  beforeEach(() => {
    reconstructionSpies.entries.mockClear();
    reconstructionSpies.checkpoints.mockClear();
  });

  afterEach(() => {
    reconstructionSpies.entries.mockClear();
    reconstructionSpies.checkpoints.mockClear();
    vi.useRealTimers();
  });

  it('does not reconstruct a stable resumed session during timer or stream rerenders', async () => {
    const restoredMessages: Message[] = [
      {
        role: 'user',
        content: 'large resumed question',
        ts: '2026-07-23T00:00:00.000Z',
      },
      {
        role: 'assistant',
        content: 'large resumed answer',
        ts: '2026-07-23T00:00:01.000Z',
      },
    ];
    const restoredEvents: SessionEvent[] = [
      {
        type: 'checkpoint',
        ts: '2026-07-23T00:00:02.000Z',
        promptIndex: 0,
        promptPreview: 'large resumed question',
      },
    ];
    const agent = createJourneyAgent(restoredMessages);
    const journey = createAppJourney(agent);
    const events = new EventBus();
    const props = {
      ...journey.props,
      banner: false,
      enhanceEnabled: false,
      restoredMessages,
      restoredEvents,
    };
    const view = render(React.createElement(ResumeRerenderHarness, { props, events }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reconstructionSpies.entries).toHaveBeenCalledOnce();
    expect(reconstructionSpies.checkpoints).toHaveBeenCalledOnce();

    // The harness clock causes several parent/App renders with the exact same
    // restored arrays. None may rebuild the JSONL-derived display structures.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reconstructionSpies.entries).toHaveBeenCalledOnce();
    expect(reconstructionSpies.checkpoints).toHaveBeenCalledOnce();

    events.emit('provider.text_delta', { ctx: agent.ctx, text: 'live stream delta' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(reconstructionSpies.entries).toHaveBeenCalledOnce();
    expect(reconstructionSpies.checkpoints).toHaveBeenCalledOnce();

    view.unmount();
  });

  it('retains transcript entries on resize without emitting a second banner', async () => {
    const entries: HistoryEntry[] = [
      {
        id: 0,
        kind: 'banner',
        version: '1.0.0',
        provider: 'test-provider',
        model: 'test-model',
        cwd: '/project',
      },
      {
        id: 1,
        kind: 'banner',
        version: '1.0.0',
        provider: 'duplicate-provider',
        model: 'duplicate-model',
        cwd: '/project',
      },
      { id: 2, kind: 'info', text: 'resize-safe transcript marker' },
    ];

    const view = render(
      React.createElement(History, {
        entries,
        generation: 0,
        toolStream: null,
        setSuggestions: vi.fn(),
        autonomyMode: 'off',
        todos: [],
      }),
    );

    expect(view.lastFrame() ?? '').toContain('test-provider');
    expect(view.lastFrame() ?? '').not.toContain('duplicate-provider');

    Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 72 });
    await React.act(async () => {
      process.stdout.emit('resize');
      await new Promise((resolve) => setImmediate(resolve));
    });

    const resizedFrame = view.lastFrame() ?? '';
    expect(resizedFrame).toContain('resize-safe transcript marker');
    expect(resizedFrame).toContain('test-provider');
    expect(resizedFrame).not.toContain('duplicate-provider');

    view.unmount();
  });

  it('renders restored user and assistant entries as visible history output', () => {
    const entries: HistoryEntry[] = [
      { id: 1, kind: 'user', text: 'restore this question' },
      { id: 2, kind: 'assistant', text: 'restored answer text' },
    ];

    const { lastFrame, unmount } = render(
      React.createElement(History, {
        entries,
        generation: 1,
        toolStream: null,
        setSuggestions: vi.fn(),
        autonomyMode: 'off',
        todos: [],
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('USER');
    expect(frame).toContain('ASSISTANT');
    expect(frame).toContain('restore this question');
    expect(frame).toContain('restored answer text');

    unmount();
  });

  it('renders restored tool entries alongside resumed history output', () => {
    const entries: HistoryEntry[] = [
      { id: 1, kind: 'user', text: 'inspect file' },
      { id: 2, kind: 'assistant', text: 'running read now' },
      {
        id: 3,
        kind: 'tool',
        name: 'read',
        durationMs: 42,
        ok: true,
        input: { path: 'src/example.ts' },
        output: 'export const answer = 42;',
        outputBytes: 25,
        outputLines: 1,
      },
    ];

    const { lastFrame, unmount } = render(
      React.createElement(History, {
        entries,
        generation: 1,
        toolStream: null,
        setSuggestions: vi.fn(),
        autonomyMode: 'off',
        todos: [],
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('inspect file');
    expect(frame).toContain('running read now');
    expect(frame).toContain('read');
    expect(frame).toContain('src/example.ts');

    unmount();
  });
});
