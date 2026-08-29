import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ send: vi.fn(), consumeRequestedSwitch: () => true }),
}));

import { WS_HANDLERS } from '../../src/hooks/ws-handlers';
import { useChatLanes } from '../../src/stores/chat-lanes';
import { useChatStore } from '../../src/stores/chat-store';
import { useFleetStore } from '../../src/stores/fleet-store';
import { useSessionLanes } from '../../src/stores/session-lanes';
import { useSessionStore } from '../../src/stores/session-store';
import type { WSServerMessage } from '../../src/types';

/**
 * Live and replayed renderings of the SAME events must agree.
 *
 * This is the property the four separate replay renderers kept breaking: a
 * session looked one way while it ran and another way after a reload, so a
 * resume read as "some other session loaded" rather than "this one carried
 * on". Each case here plays a turn through the LIVE handlers, then plays the
 * journal that turn would have produced through the REPLAY handler, and
 * compares what the chat holds.
 *
 * Ids and timestamps are deliberately not compared — they are allowed to
 * differ. Everything the eye sees is not.
 */

const SESSION = 'sess_parity';
const BASE = {
  sessionId: SESSION,
  model: 'test-model',
  provider: 'test-provider',
  maxContext: 200_000,
};

function fire(type: WSServerMessage['type'], payload: Record<string, unknown>): void {
  WS_HANDLERS[type]?.({ type, payload: { sessionId: SESSION, ...payload } } as never);
}

function reset(): void {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })) as never;
  }
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' } as never);
  useSessionLanes.setState({ lanes: {}, activeSessionId: '__unbound__' } as never);
  useFleetStore.setState({
    agents: new Map(),
    leaderId: undefined,
    eventTimeline: [],
    agentTimeline: [],
    agentTranscripts: new Map(),
  } as never);
  useSessionStore.setState({ sessionId: SESSION } as never);
  fire('session.start', { ...BASE, reset: true });
  useChatStore.getState().clearMessages();
}

/** What the eye sees, for one chat row. */
function shape() {
  return useChatStore.getState().messages.map((m) => ({
    role: m.role,
    content: m.content,
    toolName: m.toolName,
    toolResult: m.toolResult,
    toolDurationMs: m.toolDurationMs,
    isError: m.isError,
  }));
}

beforeEach(reset);

describe('a tool call renders the same live and replayed', () => {
  const TOOL_USE_ID = 'toolu_1';

  it('keeps the name, output, duration and outcome across a reload', () => {
    // ── Live ────────────────────────────────────────────────────────────
    fire('tool.started', {
      name: 'read',
      id: TOOL_USE_ID,
      input: { path: 'a.ts' },
    });
    fire('tool.executed', {
      name: 'read',
      id: TOOL_USE_ID,
      output: 'file body',
      ok: true,
      durationMs: 42,
      outputBytes: 9,
    });
    const live = shape();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ role: 'tool', toolName: 'read', toolDurationMs: 42 });

    // ── Replayed ────────────────────────────────────────────────────────
    reset();
    fire('session.start', {
      ...BASE,
      reset: true,
      replayReason: 'redisplay',
      replayMessages: [
        {
          role: 'assistant',
          ts: '2026-01-01T00:00:00Z',
          content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'read', input: { path: 'a.ts' } }],
        },
        {
          role: 'user',
          ts: '2026-01-01T00:00:01Z',
          content: [
            {
              type: 'tool_result',
              tool_use_id: TOOL_USE_ID,
              content: 'file body',
              is_error: false,
            },
          ],
        },
      ],
      // The half that used not to cross the wire at all.
      replayToolMeta: [{ id: TOOL_USE_ID, name: 'read', durationMs: 42, outputBytes: 9, ok: true }],
    });

    expect(shape()).toEqual(live);
  });

  it('a call the journal never resolved replays as unfinished, not failed', () => {
    reset();
    fire('session.start', {
      ...BASE,
      reset: true,
      replayReason: 'redisplay',
      replayMessages: [
        {
          role: 'assistant',
          ts: '2026-01-01T00:00:00Z',
          content: [{ type: 'tool_use', id: 'toolu_open', name: 'exec', input: {} }],
        },
      ],
    });
    const [entry] = shape();
    // Live, a tool bubble carries no `isError` until its result lands. A
    // replayed one must not invent a failure for a call that was still
    // running when the process stopped.
    expect(entry).toMatchObject({ role: 'tool', toolName: 'exec' });
    expect(entry?.isError).toBeUndefined();
  });
});

describe('delegation lifecycle stays out of resumed main chat', () => {
  const DELEGATE = {
    target: 'reviewer',
    task: 'review the diff',
    subagentId: 'sa1',
  };
  const COMPLETION = {
    ...DELEGATE,
    ok: true,
    summary: 'reviewer finished cleanly',
    durationMs: 4200,
    iterations: 3,
    toolCalls: 7,
    costUsd: 0.0123,
  };

  it('keeps delegate lifecycle out of live and resumed main chat', () => {
    fire('delegate.started', DELEGATE);
    fire('delegate.completed', COMPLETION);
    const live = shape();
    expect(live).toEqual([]);

    reset();
    fire('session.start', {
      ...BASE,
      reset: true,
      replayReason: 'redisplay',
      replayMessages: [{ role: 'user', ts: '2026-01-01T00:00:00Z', content: 'go' }],
      replayMarkers: [
        {
          ts: '2026-01-01T00:00:01Z',
          source: 'delegate_started',
          level: 'info',
          text: 'ignored — the surface renders from `detail`',
          agentId: 'sa1',
          detail: { kind: 'delegate_started', ...DELEGATE },
        },
        {
          ts: '2026-01-01T00:00:02Z',
          source: 'delegate_completed',
          level: 'info',
          text: 'ignored — the surface renders from `detail`',
          agentId: 'sa1',
          detail: { kind: 'delegate_completed', ...COMPLETION },
        },
      ],
    });

    const replayed = shape();
    expect(live).toEqual([]);
    expect(replayed).toEqual([expect.objectContaining({ role: 'user', content: 'go' })]);
  });
});
