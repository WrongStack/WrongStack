import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  on: vi.fn(),
  reply: undefined as ((message: { payload: unknown }) => void) | undefined,
}));

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ on: seams.on }),
}));

vi.mock('@/stores/config-store', () => ({
  useConfigStore: { getState: () => ({ wsUrl: 'ws://test' }) },
}));

const { ensureInspectHandlerInstalled, useSessionInspectStore } = await import(
  '../../src/stores/session-inspect-store'
);
const { useUIStore } = await import('../../src/stores/ui-store');

type InspectData = Parameters<ReturnType<typeof useSessionInspectStore.getState>['setPayload']>[0];
function data(id: string): InspectData {
  return {
    id,
    title: `Inspection ${id}`,
    model: 'test',
    provider: 'test',
    startedAt: '2026-10-29T12:00:00Z',
    tokenTotal: 100,
    messageCount: 1,
    iterationCount: 1,
    toolCallCount: 1,
    toolErrorCount: 0,
    fileChangeCount: 0,
    compactionCount: 0,
    toolBreakdown: { read: 1 },
    events: [],
    fileEvents: [],
  };
}
function handler() {
  ensureInspectHandlerInstalled();
  seams.reply ??= seams.on.mock.calls[0]?.[1] as (message: { payload: unknown }) => void;
  if (!seams.reply) throw new Error('Inspection transport handler was not installed');
  return seams.reply;
}
function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

beforeEach(() => {
  useSessionInspectStore.getState().clear();
  useUIStore.setState({ inspectSessionId: 'current-session', currentView: 'session-inspect' });
});

describe('session-inspect error state', () => {
  it('redacts server errors before storing them for rendered UI', () => {
    const onReply = handler();
    expect(onReply).toBeDefined();

    const secret = ['s' + 'k', 'proj', '1234567890123456789012345678901234567890'].join('-');
    onReply({ payload: { id: 'current-session', error: `inspect failed with ${secret}` } });

    const error = useSessionInspectStore.getState().error;
    expect(error).toContain('inspect failed with');
    expect(error).not.toContain(secret);
  });

  it.each(['data', 'error'])(
    'ignores late %s replies from a previously inspected session',
    async (kind) => {
      const onReply = handler();
      const delayed = gate();
      useUIStore.setState({ inspectSessionId: 'previous-session' });
      const late = delayed.ready.then(() =>
        onReply({
          payload:
            kind === 'data'
              ? data('previous-session')
              : { id: 'previous-session', error: 'Previous session is unavailable' },
        }),
      );
      useUIStore.setState({ inspectSessionId: 'current-session' });
      onReply({ payload: data('current-session') });
      expect(useSessionInspectStore.getState().payload?.id).toBe('current-session');
      delayed.release();
      await late;
      expect(useSessionInspectStore.getState().payload?.id).toBe('current-session');
      expect(useSessionInspectStore.getState().error).toBeNull();
    },
  );

  it.each(['clear-id', 'navigate-away'])(
    'does not repopulate an inspection after %s',
    async (close) => {
      const onReply = handler();
      const delayed = gate();
      const late = delayed.ready.then(() => onReply({ payload: data('current-session') }));
      useUIStore.setState(
        close === 'clear-id' ? { inspectSessionId: null } : { currentView: 'chat' },
      );
      useSessionInspectStore.getState().clear();
      delayed.release();
      await late;
      expect(useSessionInspectStore.getState().payload).toBeNull();
      expect(useSessionInspectStore.getState().error).toBeNull();
    },
  );
});
