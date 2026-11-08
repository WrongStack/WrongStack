// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationNotices } from '../src/ConversationNotices';
import { appendNotice, conversationNotice } from '../src/conversation-notices';
import { type EngineState, emptyEngineState, reduceEngine } from '../src/engine-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const text = (type: string, payload: Record<string, unknown>) =>
  conversationNotice(type, payload, 'n1', 0)?.text;

describe('run events the WebUI announces', () => {
  it('tells once per conversation that a newer WrongStack release is out', () => {
    expect(
      text('session.start', { appVersion: '1.5.2', latestVersion: '1.5.3', updateAvailable: true }),
    ).toBe('WrongStack 1.5.3 is available (this app is 1.5.2).');
    expect(
      conversationNotice(
        'session.start',
        { appVersion: '1.5.2', latestVersion: '1.5.3', updateAvailable: true },
        'n1',
        0,
      ),
    ).toMatchObject({
      severity: 'info',
      once: true,
      hint: expect.stringContaining('wstack desktop update'),
    });
    expect(
      text('session.start', {
        appVersion: '1.5.2',
        latestVersion: '1.5.2',
        updateAvailable: false,
      }),
    ).toBeUndefined();
    expect(text('session.start', { updateAvailable: true })).toBeUndefined();

    let state: EngineState = { ...emptyEngineState, sessionId: 's' };
    const start = {
      type: 'session.start',
      payload: {
        sessionId: 's',
        appVersion: '1.5.2',
        latestVersion: '1.5.3',
        updateAvailable: true,
      },
    };
    state = reduceEngine(state, start);
    state = reduceEngine(state, start);
    expect(
      state.notices.filter((notice) => notice.text.startsWith('WrongStack 1.5.3')),
    ).toHaveLength(1);
  });

  it('words each event as the WebUI does', () => {
    expect(text('provider.stream_error', { eventType: 'ping', message: 'bad frame' })).toBe(
      'Provider stream warning (ping): bad frame.',
    );
    expect(
      text('provider.model_switched', {
        from: { providerId: 'zai', model: 'glm-5' },
        to: { providerId: 'openai', model: 'gpt-5' },
      }),
    ).toBe('Model: openai/gpt-5 (was zai/glm-5).');
    expect(text('checkpoint.written', { promptIndex: 4, fileCount: 2 })).toBe(
      'Checkpoint #4 written (2 files).',
    );
    expect(text('token.cost_estimate_unavailable', { model: 'local-llm' })).toBe(
      'Cost estimate unavailable for local-llm.',
    );
    expect(text('trust.persisted', { tool: 'bash', pattern: 'git *', decision: 'always' })).toBe(
      'Always allowed bash: git *.',
    );
    expect(text('delegation.delivery_pending', { count: 2, delegationIds: ['d1', 'd2'] })).toBe(
      '2 background delegation results ready (d1, d2).',
    );
    expect(text('delegation.auto_wake_suppressed', { reason: 'chain_cap', pending: 1 })).toContain(
      'Auto-wake paused: 1 background result held',
    );
    expect(
      text('mcp.server.disconnected', {
        name: 'github',
        reason: 'spawn failed\nstack',
        terminal: true,
      }),
    ).toBe('MCP server "github" is not connected (spawn failed); its tools are unavailable.');
    expect(text('mcp.server.reconnected', { name: 'github' })).toBe(
      'MCP server "github" is connected again.',
    );
  });

  it('stays quiet when nothing changed or nothing is final', () => {
    const same = { providerId: 'zai', model: 'glm-5' };
    expect(text('provider.model_switched', { from: same, to: same })).toBeUndefined();
    expect(text('mcp.server.disconnected', { name: 'github', reason: 'retrying' })).toBeUndefined();
    expect(text('delegation.auto_wake_suppressed', { reason: 'other' })).toBeUndefined();
  });

  it('shows a cost warning once per conversation', () => {
    const cost = conversationNotice('token.cost_estimate_unavailable', { model: 'x' }, 'a', 0);
    const other = conversationNotice('provider.stream_error', { eventType: 'e' }, 'b', 0);
    if (!cost || !other) throw new Error('expected notices');
    const notices = appendNotice(appendNotice(appendNotice([], cost), other), { ...cost, id: 'c' });
    expect(notices.map((notice) => notice.id)).toEqual(['a', 'b']);
  });

  it('shows passing notices only when they happen live, never from a replayed journal', () => {
    const frame = {
      type: 'provider.model_switched',
      payload: { to: { providerId: 'openai', model: 'gpt-5' } },
    };
    const replaying: EngineState = { ...emptyEngineState, synced: false, hydrating: true };
    expect(reduceEngine(replaying, frame).notices).toEqual([]);
    expect(reduceEngine(emptyEngineState, frame).notices.map((notice) => notice.text)).toEqual([
      'Model: openai/gpt-5.',
    ]);
    const lasting = { type: 'provider.stream_error', payload: { eventType: 'e', message: 'm' } };
    expect(reduceEngine(replaying, lasting).notices).toHaveLength(1);
  });
});

describe('passing notices close by themselves', () => {
  afterEach(() => vi.useRealTimers());

  it('closes a passing notice after a few seconds and keeps a lasting one', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const passing = conversationNotice('mcp.server.reconnected', { name: 'github' }, 'p', now);
    const lasting = conversationNotice('provider.stream_error', { eventType: 'e' }, 'l', now);
    if (!passing || !lasting) throw new Error('expected notices');
    const host = document.createElement('div');
    act(() =>
      createRoot(host).render(createElement(ConversationNotices, { notices: [passing, lasting] })),
    );
    expect(host.querySelectorAll('.conversation-notice')).toHaveLength(2);
    act(() => vi.advanceTimersByTime(8_100));
    expect(host.querySelectorAll('.conversation-notice')).toHaveLength(1);
    expect(host.textContent).toContain('Provider stream warning');
  });
});
