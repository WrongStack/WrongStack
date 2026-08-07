import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createConversationOperations } from '../src/server/conversation-operations.js';

const ws = {} as WebSocket;

function harness(options: { busy?: boolean } = {}) {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const aborted: Array<{ type: string; payload: unknown }> = [];
  const controller = new AbortController();
  const run = vi.fn(async () => ({ status: 'completed', iterations: 2, finalText: 'done' }));
  const begin = vi.fn(() => (options.busy ? undefined : controller));
  const end = vi.fn();
  const abort = vi.fn();
  const routes = createConversationOperations({
    getAgent: () =>
      ({
        run,
        ctx: {
          provider: { id: 'provider', capabilities: { vision: true } },
          model: 'model',
          messages: [],
          meta: {},
        },
        tools: { list: () => [] },
      }) as never,
    getSessionId: () => 'session-live',
    runControl: { begin, end, abort },
    pendingConfirms: new Map(),
    send: (_ws, message) => sent.push(message),
    notifyAbort: (_ws, message) => aborted.push(message),
    getMaxIterations: () => 7,
  });
  return { routes, sent, aborted, controller, run, begin, end, abort };
}

describe('createConversationOperations', () => {
  it('answers short-history topic checks locally without spending a provider call', async () => {
    const h = harness();
    await h.routes.topicAdvice(ws, {
      type: 'topic.advice',
      payload: { requestId: 'topic-1', prompt: 'Plan an unrelated deployment strategy.' },
    });

    expect(h.sent.at(-1)).toMatchObject({
      type: 'topic.advice_result',
      payload: {
        sessionId: 'session-live',
        requestId: 'topic-1',
        suggestNewContext: false,
        source: 'local',
      },
    });
    expect(h.begin).not.toHaveBeenCalled();
  });

  it('applies a fresh boundary before running while preserving the session id', async () => {
    const sent: Array<{ type: string; payload: unknown }> = [];
    const controller = new AbortController();
    const replaceMessages = vi.fn();
    const flushConversationJournal = vi.fn(async () => {});
    const run = vi.fn(async () => {
      expect(replaceMessages).toHaveBeenCalledWith([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('context_boundary'),
        }),
      ]);
      return { status: 'completed', iterations: 1, finalText: 'fresh answer' };
    });
    const context = {
      provider: { id: 'provider', capabilities: { vision: true } },
      model: 'model',
      messages: [{ role: 'user', content: 'old topic' }],
      state: { replaceMessages, replaceTodos: vi.fn() },
      flushConversationJournal,
      clearFileTracking: vi.fn(),
      contextEvidence: {},
      toolAdjacencyDirty: true,
      pendingPostToolContext: {},
      lastRequestTokens: 10_000,
      lastRealInputTokens: 9_000,
      meta: {},
    };
    const routes = createConversationOperations({
      getAgent: () => ({ run, ctx: context, tools: { list: () => [] } }) as never,
      getSessionId: () => 'session-live',
      runControl: { begin: () => controller, end: vi.fn(), abort: vi.fn() },
      pendingConfirms: new Map(),
      send: (_ws, message) => sent.push(message),
      notifyAbort: vi.fn(),
    });

    await routes.userMessage(ws, {
      type: 'user_message',
      payload: { content: 'new goal', freshContext: true },
    });

    expect(flushConversationJournal).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith(
      'new goal',
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(sent.at(-1)).toMatchObject({
      type: 'run.result',
      payload: { sessionId: 'session-live', finalText: 'fresh answer' },
    });
  });

  it('runs through the host controller and projects the live session result', async () => {
    const h = harness();
    await h.routes.userMessage(ws, { type: 'user_message', payload: { content: 'hello' } });

    expect(h.run).toHaveBeenCalledWith('hello', {
      signal: h.controller.signal,
      maxIterations: 7,
    });
    expect(h.end).toHaveBeenCalledWith(ws, h.controller);
    expect(h.sent.at(-1)).toMatchObject({
      type: 'run.result',
      payload: { sessionId: 'session-live', finalText: 'done' },
    });
  });

  it('rejects a stale session before acquiring run control', async () => {
    const h = harness();
    await h.routes.userMessage(ws, {
      type: 'user_message',
      payload: { content: 'hello', sessionId: 'session-stale' },
    });

    expect(h.begin).not.toHaveBeenCalled();
    expect(h.sent.at(-1)).toMatchObject({
      type: 'error',
      payload: { phase: 'user_message', requestedSessionId: 'session-stale' },
    });
  });

  it('delegates abort delivery to the host policy', async () => {
    const h = harness();
    await h.routes.abort(ws, { type: 'abort', payload: {} });

    expect(h.abort).toHaveBeenCalledWith(ws);
    expect(h.aborted.at(-1)).toMatchObject({
      type: 'error',
      payload: { phase: 'abort', sessionId: 'session-live' },
    });
  });

  it('stamps run.result with the origin session id when the session swaps mid-run', async () => {
    // Regression: a run started in session A used to be stamped with the
    // live session id at completion time, so after session.new the previous
    // request's finalText leaked into the freshly-opened session's chat.
    let liveSessionId = 'session-old';
    const sent: Array<{ type: string; payload: unknown }> = [];
    const controller = new AbortController();
    const run = vi.fn(async () => {
      liveSessionId = 'session-new'; // host swaps the session while the run is in flight
      return { status: 'completed', iterations: 1, finalText: 'late answer' };
    });
    const routes = createConversationOperations({
      getAgent: () =>
        ({
          run,
          ctx: {
            provider: { id: 'provider', capabilities: { vision: true } },
            model: 'model',
          },
          tools: { list: () => [] },
        }) as never,
      getSessionId: () => liveSessionId,
      runControl: { begin: () => controller, end: vi.fn(), abort: vi.fn() },
      pendingConfirms: new Map(),
      send: (_ws, message) => sent.push(message),
      notifyAbort: vi.fn(),
    });

    await routes.userMessage(ws, {
      type: 'user_message',
      payload: { content: 'hello', sessionId: 'session-old' },
    });

    expect(sent.at(-1)).toMatchObject({
      type: 'run.result',
      payload: { sessionId: 'session-old', finalText: 'late answer' },
    });
  });
});
