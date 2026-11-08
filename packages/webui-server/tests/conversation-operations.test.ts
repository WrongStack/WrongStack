import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createConversationOperations } from '../src/server/conversation-operations.js';
import type { PendingConfirm } from '../src/server/pending-confirms.js';

const ws = {} as WebSocket;

function harness(options: { busy?: boolean } = {}) {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const aborted: Array<{ type: string; payload: unknown }> = [];
  const controller = new AbortController();
  const run = vi.fn(async () => ({ status: 'completed', iterations: 2, finalText: 'done' }));
  const begin = vi.fn(() => (options.busy ? undefined : controller));
  const end = vi.fn();
  const abort = vi.fn();
  const pendingConfirms = new Map<string, PendingConfirm>();
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
    pendingConfirms,
    submitUserInput: vi.fn(),
    send: (_ws, message) => sent.push(message),
    notifyAbort: (_ws, message) => aborted.push(message),
    getMaxIterations: () => 7,
  });
  return { routes, pendingConfirms, sent, aborted, controller, run, begin, end, abort };
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

  it('refuses a placeholder-writer session with session_not_ready and echoes the replay material', async () => {
    const sent: Array<{ type: string; payload: unknown }> = [];
    const run = vi.fn(async () => ({ status: 'completed', iterations: 1, finalText: 'nope' }));
    const begin = vi.fn(() => new AbortController());
    const end = vi.fn();
    // A per-tab agent is born with a PLACEHOLDER writer: a session object
    // that exists but cannot append (conversation-operations userMessage).
    const routes = createConversationOperations({
      getAgent: () =>
        ({
          run,
          ctx: {
            provider: { id: 'provider', capabilities: { vision: true } },
            model: 'model',
            messages: [],
            meta: {},
            session: {},
          },
          tools: { list: () => [] },
        }) as never,
      getSessionId: () => 'session-live',
      runControl: { begin, end, abort: vi.fn() },
      pendingConfirms: new Map(),
      submitUserInput: vi.fn(),
      send: (_ws, message) => sent.push(message),
      notifyAbort: vi.fn(),
    });

    const images = [{ kind: 'url', url: 'https://example.invalid/x.png' }];
    await routes.userMessage(ws, {
      type: 'user_message',
      payload: { id: 'm1', content: 'hello again', freshContext: true, images },
    } as never);

    // Refused before any turn started, lock released, and the refusal carries
    // the replay material the client's auto-retry (resume → resend) needs.
    expect(run).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'error',
      payload: {
        sessionId: 'session-live',
        phase: 'user_message',
        code: 'session_not_ready',
        content: 'hello again',
        freshContext: true,
        images,
      },
    });
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
      submitUserInput: vi.fn(),
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
    await h.routes.userMessage(ws, {
      type: 'user_message',
      payload: { id: 'request-42', content: 'hello' },
    });

    expect(h.run).toHaveBeenCalledWith('hello', {
      signal: h.controller.signal,
      maxIterations: 7,
      inputOrigin: 'user',
    });
    expect(h.end).toHaveBeenCalledWith(ws, 'session-live', h.controller);
    expect(h.sent.at(-1)).toMatchObject({
      type: 'run.result',
      payload: { sessionId: 'session-live', requestId: 'request-42', finalText: 'done' },
    });
  });

  it('omits the maxIterations key entirely when getMaxIterations throws, deferring to the agent default, and still fires onRunEnded', async () => {
    const sent: Array<{ type: string; payload: unknown }> = [];
    const controller = new AbortController();
    const run = vi.fn(async () => ({ status: 'completed', iterations: 1, finalText: 'ok' }));
    const end = vi.fn();
    const onRunEnded = vi.fn();
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
      runControl: { begin: () => controller, end, abort: vi.fn() },
      pendingConfirms: new Map(),
      submitUserInput: vi.fn(),
      send: (_ws, message) => sent.push(message),
      notifyAbort: vi.fn(),
      // A hostile host callback must not skip `ran = true`: that would drop
      // the onRunEnded signal the auto-wake scheduler needs to settle the
      // turn — the double-run window from the 5-file chimera report.
      getMaxIterations: () => {
        throw new Error('host preference lookup exploded');
      },
      onRunEnded,
    });

    await routes.userMessage(ws, {
      type: 'user_message',
      payload: { content: 'hello' },
    });

    // The turn ran with NO maxIterations key at all: the preference is
    // dropped (the agent's own default applies), not the turn.
    expect(run).toHaveBeenCalledWith('hello', {
      signal: controller.signal,
      inputOrigin: 'user',
    });
    // The post-run bookkeeping fired, so the scheduler settles the turn
    // instead of re-entering the same prompt.
    expect(onRunEnded).toHaveBeenCalledTimes(1);
    expect(onRunEnded).toHaveBeenCalledWith('session-live', { aborted: false, origin: 'user' });
    expect(end).toHaveBeenCalledWith(ws, 'session-live', controller);
    expect(sent.at(-1)).toMatchObject({
      type: 'run.result',
      payload: { sessionId: 'session-live', finalText: 'ok' },
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

    expect(h.abort).toHaveBeenCalledWith(ws, 'session-live');
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
      submitUserInput: vi.fn(),
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

describe('topic advice session ownership', () => {
  function ownedHarness(hasSession?: (id: string) => boolean) {
    const sent: Array<{ type: string; payload: unknown }> = [];
    const agents = new Map(
      (['sess_front', 'sess_bg'] as const).map((id) => [
        id,
        {
          run: vi.fn(),
          ctx: {
            provider: { id: 'p', capabilities: { vision: true, maxContext: 1000 } },
            model: 'm',
            messages: [{ role: 'user' as const, content: `history ${id}` }],
            meta: {},
            lastRequestTokens: 0,
          },
          tools: { list: () => [] },
        },
      ]),
    );
    const getAgent = vi.fn(
      (id?: string) =>
        (agents.get((id ?? 'sess_front') as 'sess_front' | 'sess_bg') ??
          agents.get('sess_front')) as never,
    );
    const routes = createConversationOperations({
      getAgent,
      getSessionId: () => 'sess_front',
      // A multi-session host: background-tab requests are legitimate. The
      // refusal test below narrows this to exercise the unknown-id gate.
      hasSession: hasSession ?? (() => true),
      runControl: { begin: () => new AbortController(), end: vi.fn(), abort: vi.fn() },
      pendingConfirms: new Map(),
      submitUserInput: vi.fn(),
      send: (_ws, message) => sent.push(message),
      notifyAbort: vi.fn(),
    });
    return { routes, sent, getAgent };
  }

  it('answers a background tab from ITS session and stamps the reply', async () => {
    const h = ownedHarness();
    await h.routes.topicAdvice(ws, {
      type: 'topic.advice',
      payload: {
        requestId: 'topic-9',
        prompt: 'A different deployment strategy',
        sessionId: 'sess_bg',
      },
    });

    // The asking tab's agent, not the foreground's — and the reply names the
    // asking tab so the browser files it under the right lane.
    expect(h.getAgent).toHaveBeenCalledWith('sess_bg');
    expect(h.sent.at(-1)).toMatchObject({
      type: 'topic.advice_result',
      payload: { sessionId: 'sess_bg', requestId: 'topic-9' },
    });
  });

  it('refuses an unknown session without touching any agent', async () => {
    const h = ownedHarness((id) => id === 'sess_bg');
    await h.routes.topicAdvice(ws, {
      type: 'topic.advice',
      payload: { requestId: 'topic-x', prompt: 'ghost', sessionId: 'sess_ghost' },
    });

    // hasSession is the ownership gate: a string nobody opened must not even
    // reach getAgent (which CREATES on read).
    expect(h.getAgent).not.toHaveBeenCalled();
    expect(h.sent.at(-1)).toMatchObject({
      type: 'error',
      payload: { requestedSessionId: 'sess_ghost' },
    });
  });

  it('treats an empty-string session stamp as no session at all', async () => {
    const h = ownedHarness((id) => id === 'sess_bg');
    await h.routes.topicAdvice(ws, {
      type: 'topic.advice',
      payload: { requestId: 'topic-e', prompt: 'empty stamp', sessionId: '' },
    });

    // '' must fall back to the runtime's session, never act as a target id.
    expect(h.getAgent).toHaveBeenCalledWith('sess_front');
    expect(h.sent.at(-1)).toMatchObject({
      type: 'topic.advice_result',
      payload: { sessionId: 'sess_front' },
    });
  });
});

describe('scoped approval transport', () => {
  it.each(['always-exact', 'always-command', 'always-tool'] as const)(
    'delivers %s only to the owning session',
    async (decision) => {
      const h = harness();
      const resolve = vi.fn();
      h.pendingConfirms.set('approval', { sessionId: 'session-live', resolve });
      await h.routes.confirmTool(ws, {
        type: 'tool.confirm_result',
        payload: { id: 'approval', decision, sessionId: 'other' },
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(h.pendingConfirms.has('approval')).toBe(true);
      await h.routes.confirmTool(ws, {
        type: 'tool.confirm_result',
        payload: { id: 'approval', decision, sessionId: 'session-live' },
      });
      expect(resolve).toHaveBeenCalledExactlyOnceWith(decision);
      expect(h.pendingConfirms.has('approval')).toBe(false);
    },
  );
  it('keeps a prompt pending after an unknown decision', async () => {
    const h = harness();
    const resolve = vi.fn();
    h.pendingConfirms.set('approval', { sessionId: 'session-live', resolve });
    await h.routes.confirmTool(ws, {
      type: 'tool.confirm_result',
      payload: { id: 'approval', decision: 'allow-everything' },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(h.pendingConfirms.has('approval')).toBe(true);
  });
});

describe('composer.warm', () => {
  function warmHarness() {
    const warm = vi.fn(async () => undefined);
    let finishRun: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise((resolve) => {
          finishRun = () => resolve({ status: 'completed', iterations: 1, finalText: 'ok' });
        }),
    );
    const agentFor = vi.fn(() => ({
      run,
      ctx: {
        provider: { id: 'provider', capabilities: { vision: true }, warm },
        model: 'glm-5',
        messages: [],
        meta: {},
      },
      tools: { list: () => [] },
    }));
    const sent: Array<{ type: string; payload: unknown }> = [];
    const routes = createConversationOperations({
      getAgent: agentFor as never,
      getSessionId: () => 'session-live',
      hasSession: (id) => id === 'session-tab2',
      runControl: { begin: () => new AbortController(), end: vi.fn(), abort: vi.fn() },
      pendingConfirms: new Map(),
      submitUserInput: vi.fn(),
      send: (_ws, message) => sent.push(message),
      notifyAbort: vi.fn(),
    });
    return { routes, warm, agentFor, run, sent, finish: () => finishRun?.() };
  }

  it("warms the tab's own session provider for its model, silently", async () => {
    const h = warmHarness();
    await h.routes.warmProvider?.(ws, {
      type: 'composer.warm',
      payload: { sessionId: 'session-tab2' },
    });
    expect(h.agentFor).toHaveBeenCalledWith('session-tab2');
    expect(h.warm).toHaveBeenCalledWith('glm-5');
    expect(h.sent).toEqual([]);
  });

  it('skips a session this host does not hold, and one whose turn is running', async () => {
    const h = warmHarness();
    await h.routes.warmProvider?.(ws, {
      type: 'composer.warm',
      payload: { sessionId: 'session-elsewhere' },
    });
    expect(h.warm).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);

    const turn = h.routes.userMessage(ws, { type: 'user_message', payload: { content: 'hi' } });
    // Running means `agent.run` was entered, not just that the agent was looked up.
    await vi.waitFor(() => expect(h.run).toHaveBeenCalled());
    await h.routes.warmProvider?.(ws, { type: 'composer.warm', payload: {} });
    expect(h.warm).not.toHaveBeenCalled();
    h.finish();
    await turn;
    await h.routes.warmProvider?.(ws, { type: 'composer.warm', payload: {} });
    expect(h.warm).toHaveBeenCalledOnce();
  });

  describe('runRuntimeTurn', () => {
    it('runs to the end through the run lock with the loop options and hands back the result', async () => {
      const h = harness();
      const external = new AbortController();
      const outcome = await h.routes.runRuntimeTurn('session-live', 'eternal directive', {
        signal: external.signal,
        autonomousContinue: true,
        maxIterations: 3,
        resultOrigin: 'eternal',
      });
      expect(outcome).toEqual({
        started: true,
        result: { status: 'completed', iterations: 2, finalText: 'done' },
      });
      expect(h.begin).toHaveBeenCalledWith(undefined, 'session-live');
      expect(h.end).toHaveBeenCalledTimes(1);
      expect(h.run).toHaveBeenCalledWith(
        'eternal directive',
        expect.objectContaining({
          signal: h.controller.signal,
          inputOrigin: 'runtime',
          autonomousContinue: true,
          // The loop's cap replaces the session ceiling (7).
          maxIterations: 3,
        }),
      );
    });

    it('reports a busy conversation as not started without an error', async () => {
      const h = harness({ busy: true });
      expect(await h.routes.runRuntimeTurn('session-live', 'directive')).toEqual({
        started: false,
      });
      expect(h.run).not.toHaveBeenCalled();
      expect(h.sent).toEqual([]);
    });

    it('aborts the run lock when the loop stops, and stops listening afterwards', async () => {
      const h = harness();
      const external = new AbortController();
      h.run.mockImplementationOnce(async () => {
        external.abort();
        return { status: 'aborted', iterations: 0, finalText: '' };
      });
      const outcome = await h.routes.runRuntimeTurn('session-live', 'directive', {
        signal: external.signal,
      });
      expect(h.controller.signal.aborted).toBe(true);
      expect(outcome.result?.status).toBe('aborted');
    });
  });
});
