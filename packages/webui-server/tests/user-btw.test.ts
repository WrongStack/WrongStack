import {
  Context,
  consumeBtwNotes,
  pendingUserBtwInstructions,
  setBtwNote,
  setUserBtwInstruction,
} from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createConversationOperations } from '../src/server/conversation-operations.js';
import { handleConversationRoute } from '../src/server/conversation-routes.js';
import { handleUserBtw } from '../src/server/user-btw-handler.js';

function context(id: string) {
  return new Context({
    systemPrompt: [],
    provider: null as never,
    session: {
      id,
      pendingToolUses: [],
      append: async () => {},
      appendBatch: async () => {},
      flush: async () => {},
      close: async () => {},
      recordFileChange() {},
      recordSideEffect() {},
      writeCheckpoint: async () => {},
      writeFileSnapshot: async () => {},
      truncateToCheckpoint: async () => 0,
      clearSession: async () => {},
      writeInFlightMarker: async () => {},
      clearInFlightMarker: async () => {},
    },
    signal: new AbortController().signal,
    tokenCounter: { account() {} } as never,
    cwd: 'D:/fixture',
    projectRoot: 'D:/fixture',
    model: 'fixture',
  });
}

const socket = {} as WebSocket;

describe('session-owned human BTW route', () => {
  it('routes add/get through the conversation family and drains with the real core notes', async () => {
    const target = context('target');
    const other = context('foreground');
    const sent: Array<{ type: string; payload: unknown }> = [];
    const emit = (message: { type: string; payload: unknown }) => sent.push(message);
    const handler = vi.fn((_ws: WebSocket, msg: Parameters<typeof handleUserBtw>[0]) =>
      handleUserBtw(msg, { sessionId: 'target', context: target, running: true, reply: emit }),
    );
    const handlers = {
      userMessage: vi.fn(),
      topicAdvice: vi.fn(),
      abort: vi.fn(),
      ping: vi.fn(),
      confirmTool: vi.fn(),
      submitUserInput: vi.fn(),
      btw: handler,
    };
    expect(
      await handleConversationRoute(
        socket,
        { type: 'btw.add', payload: { requestId: 'r1', text: 'Keep compatibility' } },
        handlers,
      ),
    ).toBe(true);
    expect(sent.at(-1)).toMatchObject({
      type: 'btw.state',
      payload: {
        sessionId: 'target',
        requestId: 'r1',
        success: true,
        id: expect.stringMatching(/^btw:/),
        items: [expect.objectContaining({ text: 'Keep compatibility' })],
      },
    });
    expect(pendingUserBtwInstructions(other)).toEqual([]);
    expect(consumeBtwNotes(target).join('\n')).toContain('User instruction:\nKeep compatibility');
    await handleConversationRoute(
      socket,
      { type: 'btw.get', payload: { requestId: 'r2' } },
      handlers,
    );
    expect(sent.at(-1)).toMatchObject({ payload: { requestId: 'r2', items: [] } });
    expect(handlers.userMessage).not.toHaveBeenCalled();
    expect(handlers.abort).not.toHaveBeenCalled();
  });
  it('refuses invalid, oversized, idle, and mismatched-session submissions without accepting them', () => {
    const ctx = context('target');
    const reply = vi.fn();
    for (const text of ['', ' ', 'x'.repeat(65537), '検'.repeat(22000)]) {
      handleUserBtw(
        { type: 'btw.add', payload: { requestId: 'bad', text } },
        { sessionId: 'target', context: ctx, running: true, reply },
      );
      expect(reply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ success: false, requestId: 'bad' }),
        }),
      );
    }
    for (const options of [
      { sessionId: 'target', running: false },
      { sessionId: 'foreign', running: true },
    ]) {
      handleUserBtw(
        { type: 'btw.add', payload: { text: 'do not lose this' } },
        { ...options, context: ctx, reply },
      );
      expect(reply).toHaveBeenLastCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ success: false }) }),
      );
    }
    expect(pendingUserBtwInstructions(ctx)).toEqual([]);
  });
  it('does not let peer-awareness bursts evict accepted human instructions', () => {
    const ctx = context('target');
    for (let index = 0; index < 20; index++)
      setUserBtwInstruction(ctx, `btw:${index}`, `Instruction ${index}`);
    for (let index = 0; index < 30; index++) setBtwNote(ctx, `[MAILBOX BTW] peer ${index}`);
    expect(pendingUserBtwInstructions(ctx)).toHaveLength(20);
    expect(() => setUserBtwInstruction(ctx, 'overflow', 'Keep my draft')).toThrow(
      'Too many pending',
    );
    expect(consumeBtwNotes(ctx)).toHaveLength(20);
  });
  it('refuses an unknown session before resolving or constructing an agent', async () => {
    const getAgent = vi.fn();
    const send = vi.fn();
    const routes = createConversationOperations({
      getAgent,
      getSessionId: () => 'foreground',
      hasSession: () => false,
      runControl: { begin: vi.fn(), end: vi.fn(), abort: vi.fn() },
      pendingConfirms: new Map(),
      submitUserInput: vi.fn(),
      send,
      notifyAbort: vi.fn(),
    });
    await routes.btw?.(socket, {
      type: 'btw.add',
      payload: { sessionId: 'unknown', requestId: 'foreign', text: 'instruction' },
    });
    expect(getAgent).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({ requestedSessionId: 'unknown' }),
      }),
    );
  });
});
