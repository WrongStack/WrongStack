import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The story lives in the shared package and translates with the app's i18next instance.
import '../../src/i18n';
import { SessionStoryView } from '../../src/components/SessionStoryView';
import { useUIStore } from '../../src/stores/ui-store';
import type { ChronicleEventView } from '../../src/types';

const harness = vi.hoisted(() => ({
  sessionId: 'tab-a',
  handlers: new Map<string, (message: unknown) => void>(),
  send: vi.fn(),
}));
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => client }));
const client = {
  supportsCapability: () => true,
  send: harness.send,
  on: (type: string, handler: (message: unknown) => void) => {
    harness.handlers.set(type, handler);
    return () => {
      harness.handlers.delete(type);
    };
  },
};
vi.mock('@/stores', () => ({
  useActiveSessionId: () => harness.sessionId,
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ session: { id: harness.sessionId, startedAt: Date.parse('2026-10-02T12:00:00Z') } }),
}));
const event = (id: string, actor: string, type: string): ChronicleEventView => ({
  schemaVersion: 1,
  eventId: id,
  eventType: type,
  sequence: 1,
  hash: '',
  previousHash: '',
  observedAt: '2026-10-02T12:00:02Z',
  persistedAt: '2026-10-02T12:00:02Z',
  scope: { sessionId: 'tab-a', agentId: actor },
  correlation: {},
  attributes: type === 'tool.executed' ? { toolName: 'read' } : { subagentId: actor, name: actor },
});
/** Answers the latest history query; the story applies the reply after a microtask. */
async function reply(events: ChronicleEventView[], requestId?: string) {
  const sent = harness.send.mock.calls
    .filter(([message]) => message.type === 'chronicle.query')
    .at(-1)?.[0];
  await act(async () =>
    harness.handlers.get('chronicle.query_result')?.({
      type: 'chronicle.query_result',
      payload: {
        requestId: requestId ?? sent.payload.requestId,
        events,
        total: events.length,
        summary: {},
      },
    }),
  );
}
afterEach(() => {
  cleanup();
  harness.send.mockClear();
  harness.handlers.clear();
  harness.sessionId = 'tab-a';
  useUIStore.setState({ storyContextRequested: false });
});

describe('Session Story', () => {
  it('opens the Context timeline on a shortcut request and consumes it once', () => {
    useUIStore.setState({ storyContextRequested: true });
    const view = render(<SessionStoryView />);
    expect(screen.getByRole('tab', { name: 'Context' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Context window over time')).toBeTruthy();
    expect(document.activeElement?.id).toBe('story-context-timeline');
    expect(useUIStore.getState().storyContextRequested).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: 'tools' }));
    view.unmount();
    render(<SessionStoryView />);
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('handles another shortcut while Story is already mounted', () => {
    render(<SessionStoryView />);
    fireEvent.click(screen.getByRole('tab', { name: 'Context' }));
    const target = document.getElementById('story-context-timeline');
    expect(target).not.toBeNull();
    const scroll = vi.fn();
    if (target) target.scrollIntoView = scroll;
    act(() => useUIStore.setState({ storyContextRequested: true }));
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    expect(document.activeElement).toBe(target);
    expect(useUIStore.getState().storyContextRequested).toBe(false);
  });

  it('compares models and opens the diagnostic event evidence', async () => {
    render(<SessionStoryView />);
    await reply([
      {
        ...event('attempt', 'leader', 'provider.attempt.failed'),
        runtime: { providerId: 'p', modelId: 'bad-model' },
        correlation: { attemptId: 'a' },
        durationNs: '2000000000',
        outcome: 'failure',
        attributes: {
          status: 429,
          failureKind: 'rate_limit',
          retryScheduled: true,
          retryDelayMs: 50,
        },
      },
    ]);
    fireEvent.click(screen.getByRole('tab', { name: 'models' }));
    expect(screen.getByText('Model performance & evidence')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bad-model' }));
    expect(screen.getByText('rate_limit: 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Speed, tokens & cost' }));
    expect(screen.getByText('Est. cost / pricing coverage')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /provider.attempt.failed/ }));
    expect(screen.getByText('Recorded metadata')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'timeline' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
  it('renders parallel subagent lanes, density, replay, filters and evidence', async () => {
    render(<SessionStoryView />);
    await reply([
      event('spawn-a', 'Worker A', 'subagent.spawned'),
      event('spawn-b', 'Worker B', 'subagent.spawned'),
      event('tool', 'Worker A', 'tool.executed'),
    ]);
    expect(
      screen.getByRole('img', { name: 'Session activity category distribution' }),
    ).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Observed team overlap over time' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'timeline' }));
    expect(screen.getByRole('img', { name: 'Session team timeline' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Session event density' })).toBeTruthy();
    expect(screen.getAllByText('Worker A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Worker B').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('read'));
    expect(screen.getByText('Recorded metadata')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search session events' }), {
      target: { value: 'does-not-exist' },
    });
    expect(screen.getByText('No events match this position and filter.')).toBeTruthy();
    fireEvent.change(screen.getByRole('slider', { name: 'Session replay position' }), {
      target: { value: '0' },
    });
    expect(screen.getByRole('slider').getAttribute('value')).toBe('0');
  });
  it('rejects stale replies and other-tab records after switching tabs', async () => {
    const view = render(<SessionStoryView />);
    const old = harness.send.mock.calls.find(([message]) => message.type === 'chronicle.query')?.[0]
      .payload.requestId;
    await reply([event('old', 'Old Worker', 'subagent.spawned')]);
    harness.sessionId = 'tab-b';
    view.rerender(<SessionStoryView />);
    await reply([event('late', 'Old Worker', 'subagent.spawned')], old);
    expect(screen.queryByText('Old Worker')).toBeNull();
    await reply([event('wrong-session', 'Other Worker', 'subagent.spawned')]);
    expect(screen.queryByText('Other Worker')).toBeNull();
  });
  it('keeps dense details behind dashboard tabs and supports keyboard navigation and effects opt-out', async () => {
    render(<SessionStoryView />);
    await reply([
      {
        ...event('start', 'Worker A', 'tool.started'),
        correlation: { toolCallId: 't1' },
        attributes: { toolName: 'read', input: { path: 'src/a.ts' } },
      },
      {
        ...event('end', 'Worker A', 'tool.executed'),
        correlation: { toolCallId: 't1' },
        outcome: 'success',
        durationNs: '250000000',
        attributes: { toolName: 'read', fileStats: { readLines: 12 } },
      },
    ]);
    expect(screen.queryByText('Event stream')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'tools' }));
    expect(screen.getAllByText('250 ms')).toHaveLength(3);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'tools' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'files' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('12')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }));
    expect(screen.getByText('Event stream')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Effects on' }));
    expect(screen.getByTestId('session-story').getAttribute('data-motion')).toBe('off');
  });
});
