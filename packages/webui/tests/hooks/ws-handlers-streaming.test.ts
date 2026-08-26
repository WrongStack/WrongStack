import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── rAF stub ──────────────────────────────────────────────────────────────
// jsdom ships a real requestAnimationFrame that uses real timers — which
// makes the coalescer's frame-batched flush nondeterministic in tests.
// Route it through queueMicrotask so a single `await Promise.resolve()`
// drains the pending buffer.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    queueMicrotask(cb);
    return 0;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Mocks ─────────────────────────────────────────────────────────────────
// The streaming pipeline under test:
//   handleTextDelta → streamCoalescer.push → (rAF/microtask flush) → chatStore.appendToMessage
// We mock the side-effecty bits (favicon, chime, notify, ws-client) but keep
// the real chat-store and the real stream-coalescer so the flush path is
// exercised end to end.

vi.mock('@/lib/favicon', () => ({ setFaviconStatus: vi.fn() }));
vi.mock('@/lib/chime', () => ({
  playCompletionChime: vi.fn(),
  playPermissionChime: vi.fn(),
}));
vi.mock('@/lib/notify', () => ({
  ensureNotificationPermission: vi.fn(),
  notifyIfHidden: vi.fn(),
}));
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ send: vi.fn() }) }));

// ── SUT (imported after mocks) ────────────────────────────────────────────
import {
  handleRunResult,
  handleTextDelta,
  handleToolExecuted,
  handleToolStarted,
} from '../../src/hooks/ws-handlers/chat-handlers';
import { handleProviderResponse } from '../../src/hooks/ws-handlers/session-handlers';
import { streamCoalescer } from '../../src/lib/stream-coalescer';
import { useChatStore } from '../../src/stores/chat-store';
import { useSessionStore } from '../../src/stores/session-store';
import type { WSServerMessage } from '../../src/types';

/** The session every payload in this suite belongs to. */
const STREAM_SESSION = 'sess_stream';

function delta(messageId: string, text: string): WSServerMessage {
  return {
    type: 'provider.text_delta',
    // Chat events are always session-stamped on the wire (the server routes
    // every one through `sessionPayload`), and the client drops untagged ones
    // so a background tab's stream cannot append to the tab in front.
    payload: { text, messageId, sessionId: STREAM_SESSION },
  } as unknown as WSServerMessage;
}

beforeEach(() => {
  useChatStore.getState().clearMessages();
  useChatStore.getState().setCurrentAssistantMessage(null);
  useChatStore.getState().setLoading(false);
  // Seed an active session so isActiveSessionMessage() returns true.
  useSessionStore.getState().setSession({
    id: 'sess_stream',
    title: 'streaming test',
    cwd: '/tmp',
    projectRoot: '/tmp',
    provider: 'p',
    model: 'm',
    mode: 'balanced',
    contextMode: 'balanced',
    env: {},
  } as never);
  streamCoalescer.dropAll();
});

afterEach(() => {
  streamCoalescer.dropAll();
});

describe('streaming pipeline: text_delta → coalescer → chat-store', () => {
  it('falls back to successful nextsteps tool input when no terminal text arrives', () => {
    handleToolStarted({
      type: 'tool.started',
      payload: {
        id: 'tool_nextsteps',
        name: 'nextsteps',
        input: { steps: [{ text: 'Run the focused tests', auto: true }] },
        sessionId: 'sess_stream',
      },
    } as unknown as WSServerMessage);
    handleToolExecuted({
      type: 'tool.executed',
      payload: { id: 'tool_nextsteps', name: 'nextsteps', ok: true, sessionId: 'sess_stream' },
    } as unknown as WSServerMessage);
    handleRunResult({
      type: 'run.result',
      payload: { status: 'done', iterations: 1, sessionId: 'sess_stream' },
    } as unknown as WSServerMessage);

    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '',
      nextSteps: { steps: [{ index: 1, text: 'Run the focused tests', auto: true }] },
    });
  });

  it('assembles multiple deltas into one assistant message after a flush', async () => {
    const messageId = 'msg_1';
    // Fire three deltas in the same frame (no flush between them).
    handleTextDelta(delta(messageId, 'Hello'));
    handleTextDelta(delta(messageId, ', '));
    handleTextDelta(delta(messageId, 'world!'));

    // The coalescer schedules a flush via microtask (jsdom has no rAF).
    // Let it drain.
    await Promise.resolve();
    await Promise.resolve();

    const messages = useChatStore.getState().messages;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.content).toBe('Hello, world!');
    expect(messages[0]?.streaming).toBe(true);
  });

  it('creates exactly one assistant message for a streamed run (no dupes per delta)', async () => {
    const messageId = 'msg_2';
    for (let i = 0; i < 20; i++) {
      handleTextDelta(delta(messageId, `chunk${i} `));
      // Yield between some deltas so multiple flush cycles run — the test
      // verifies no duplicate messages are created across frames.
      if (i % 5 === 0) {
        await Promise.resolve();
        await Promise.resolve();
      }
    }
    await Promise.resolve();
    await Promise.resolve();

    const messages = useChatStore.getState().messages;
    expect(messages.length).toBe(1);
    // All 20 chunks appended in order.
    expect(messages[0]?.content).toMatch(/^chunk0 chunk1 .* chunk19 $/);
  });

  it('flips streaming=false on run.result and finalizes the message', async () => {
    const messageId = 'msg_3';
    handleTextDelta(delta(messageId, 'finalizing'));
    await Promise.resolve();
    await Promise.resolve();

    expect(useChatStore.getState().messages[0]?.streaming).toBe(true);

    // run.result flushes the coalescer and finalizes.
    handleRunResult({
      type: 'run.result',
      payload: {
        status: 'done',
        iterations: 1,
        sessionId: 'sess_stream',
        messageId,
      },
    } as unknown as WSServerMessage);

    const messages = useChatStore.getState().messages;
    expect(messages.length).toBe(1);
    expect(messages[0]?.content).toBe('finalizing');
    expect(messages[0]?.streaming).toBe(false);
  });

  it('flushes and finalizes pending assistant text before a tool bubble', () => {
    handleTextDelta(delta('msg_tool_intro', 'I will inspect the file first.'));

    handleToolStarted({
      type: 'tool.started',
      payload: {
        sessionId: 'sess_stream',
        id: 'toolu_1',
        name: 'read',
        input: { path: 'src/a.ts' },
        messageId: 'tool_toolu_1',
      },
    } as unknown as WSServerMessage);

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(messages[0]?.content).toBe('I will inspect the file first.');
    expect(messages[0]?.streaming).toBe(false);
    expect(messages[1]).toMatchObject({ role: 'tool', toolName: 'read', toolUseId: 'toolu_1' });
  });

  it('adds non-streamed provider response text before a tool bubble', () => {
    handleProviderResponse({
      type: 'provider.response',
      payload: {
        sessionId: 'sess_stream',
        content: [
          { type: 'text', text: 'I will inspect the file first.' },
          { type: 'tool_use', id: 'toolu_2', name: 'read', input: { path: 'src/b.ts' } },
        ],
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'tool_use',
        messageId: 'current',
      },
    } as unknown as WSServerMessage);

    handleToolStarted({
      type: 'tool.started',
      payload: {
        sessionId: 'sess_stream',
        id: 'toolu_2',
        name: 'read',
        input: { path: 'src/b.ts' },
        messageId: 'tool_toolu_2',
      },
    } as unknown as WSServerMessage);

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(messages[0]?.content).toBe('I will inspect the file first.');
    expect(messages[0]?.usage).toMatchObject({ input: 10, output: 4 });
    expect(messages[1]).toMatchObject({ role: 'tool', toolName: 'read', toolUseId: 'toolu_2' });
  });

  it('does not duplicate streamed text when provider response also carries content', async () => {
    handleTextDelta(delta('msg_dup', 'Already streamed.'));
    await Promise.resolve();
    await Promise.resolve();

    handleProviderResponse({
      type: 'provider.response',
      payload: {
        sessionId: 'sess_stream',
        content: [{ type: 'text', text: 'Already streamed.' }],
        usage: { input: 12, output: 5, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'tool_use',
        messageId: 'current',
      },
    } as unknown as WSServerMessage);

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => m.role)).toEqual(['assistant']);
    expect(messages[0]?.content).toBe('Already streamed.');
    expect(messages[0]?.streaming).toBe(false);
    expect(messages[0]?.usage).toMatchObject({ input: 12, output: 5 });
  });

  it('does not duplicate provider response text when run.result repeats finalText', () => {
    handleProviderResponse({
      type: 'provider.response',
      payload: {
        sessionId: 'sess_stream',
        content: [{ type: 'text', text: 'Final response.' }],
        usage: { input: 8, output: 3, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'end_turn',
        messageId: 'current',
      },
    } as unknown as WSServerMessage);

    handleRunResult({
      type: 'run.result',
      payload: {
        status: 'done',
        iterations: 1,
        sessionId: 'sess_stream',
        finalText: 'Final response.',
      },
    } as unknown as WSServerMessage);

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => m.role)).toEqual(['assistant']);
    expect(messages[0]?.content).toBe('Final response.');
  });

  it('does not append a raw duplicate when run.result repeats finalized next steps', () => {
    const finalText =
      'Final response.\n\n<nextsteps>\n1. Run the focused tests\n2. Review the diff\n</nextsteps>';

    handleProviderResponse({
      type: 'provider.response',
      payload: {
        sessionId: 'sess_stream',
        content: [{ type: 'text', text: finalText }],
        usage: { input: 8, output: 12, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'end_turn',
        messageId: 'current',
      },
    } as unknown as WSServerMessage);

    handleRunResult({
      type: 'run.result',
      payload: {
        status: 'done',
        iterations: 1,
        sessionId: 'sess_stream',
        finalText,
      },
    } as unknown as WSServerMessage);

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Final response.');
    expect(messages[0]?.content).not.toContain('<nextsteps>');
    expect(messages[0]?.nextSteps?.steps.map((step) => step.text)).toEqual([
      'Run the focused tests',
      'Review the diff',
    ]);
  });

  it('does not persist next steps from a mid-turn provider response', () => {
    // stopReason 'tool_use' means the agent loop runs again — the suggestions
    // in this text are prose written on the way to a tool call, not the
    // turn's answer. The block is still stripped from the body.
    handleProviderResponse({
      type: 'provider.response',
      payload: {
        sessionId: 'sess_stream',
        content: [
          {
            type: 'text',
            text: 'Let me check that.\n\n<nextsteps>\n1. Premature suggestion\n</nextsteps>',
          },
          { type: 'tool_use', id: 'toolu_mid', name: 'read', input: { path: 'src/c.ts' } },
        ],
        usage: { input: 9, output: 6, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'tool_use',
        messageId: 'current',
      },
    } as unknown as WSServerMessage);

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.nextSteps).toBeUndefined();
    expect(messages[0]?.content).not.toContain('<nextsteps>');
    expect(messages[0]?.content).not.toContain('Premature suggestion');
    expect(messages[0]?.content).toContain('Let me check that.');
  });

  it('does not persist next steps written just before a tool bubble', async () => {
    handleTextDelta(
      delta('msg_mid_tool', 'On it.\n\n<nextsteps>\n1. Premature suggestion\n</nextsteps>'),
    );
    await Promise.resolve();
    await Promise.resolve();

    handleToolStarted({
      type: 'tool.started',
      payload: {
        sessionId: 'sess_stream',
        id: 'toolu_mid2',
        name: 'read',
        input: { path: 'src/d.ts' },
        messageId: 'tool_toolu_mid2',
      },
    } as unknown as WSServerMessage);

    const messages = useChatStore.getState().messages;
    expect(messages[0]?.nextSteps).toBeUndefined();
    expect(messages[0]?.content).not.toContain('<nextsteps>');
    expect(messages[0]?.content).toContain('On it.');
  });

  it('falls back to run.result finalText when no streamed assistant message exists', () => {
    handleRunResult({
      type: 'run.result',
      payload: {
        status: 'done',
        iterations: 1,
        sessionId: 'sess_stream',
        finalText:
          'Recovered assistant reply\n\n<nextsteps>\n1. Continue investigating\n</nextsteps>',
      },
    } as unknown as WSServerMessage);

    const messages = useChatStore.getState().messages;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.content).toBe('Recovered assistant reply');
    expect(messages[0]?.content).not.toContain('<nextsteps>');
    expect(messages[0]?.nextSteps?.steps[0]?.text).toBe('Continue investigating');
  });

  it('marks the initiating user bubble failed when its provider turn fails', () => {
    useChatStore.getState().addMessage({
      id: 'request-provider-failed',
      role: 'user',
      content: 'please do this',
    });

    handleRunResult({
      type: 'run.result',
      payload: {
        status: 'failed',
        iterations: 1,
        sessionId: 'sess_stream',
        requestId: 'request-provider-failed',
        error: { code: 'provider_error', message: 'provider unavailable', recoverable: true },
      },
    } as unknown as WSServerMessage);

    expect(useChatStore.getState().messages[0]).toMatchObject({
      id: 'request-provider-failed',
      role: 'user',
      status: 'failed',
    });
  });

  it('ignores deltas for a non-active session', async () => {
    // Mark a different session id on the payload; isActiveSessionMessage
    // should drop it.
    handleTextDelta({
      type: 'provider.text_delta',
      payload: { text: 'should be dropped', messageId: 'msg_x', sessionId: 'other' },
    } as unknown as WSServerMessage);
    await Promise.resolve();
    await Promise.resolve();

    expect(useChatStore.getState().messages.length).toBe(0);
  });
});
