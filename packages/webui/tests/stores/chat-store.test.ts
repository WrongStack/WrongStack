import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BTW_DISPATCH_GRACE_MS,
  boundChatField,
  retainWebChatMessages,
  useChatLanes,
  useChatStore,
} from '../../src/stores/chat-store';
import type { ChatMessage } from '../../src/stores/types.js';

// ── crypto mock ───────────────────────────────────────────────────────
// Must be set before the store module loads (vi.mock is hoisted).
let uuidCounter = 0;
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: () => `uuid-${String(uuidCounter++).padStart(4, '0')}`,
  };
});

// ── helpers ──────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<ChatMessage> = {}): Omit<ChatMessage, 'id' | 'timestamp'> {
  return {
    content: 'hello',
    role: 'user',
    ...overrides,
  };
}

function addMsg(overrides: Partial<ChatMessage> = {}): string {
  return useChatStore.getState().addMessage(makeMsg(overrides));
}

beforeEach(() => {
  uuidCounter = 0;
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  // Reset to initial state.
  useChatStore.setState({
    messages: [],
    currentAssistantMessageId: null,
    currentToolId: null,
    isLoading: false,
    abortController: null,
    executions: new Map(),
    toolMessageIdsByUseId: new Map(),
    queue: [],
    runStart: null,
    thinkingBuffer: '',
    thinkingStartedAt: null,
    thinkingLogBuffer: '',
    thinkingLogStartedAt: null,
    boundSessionId: null,
  });
  // Clear any persisted chat blob so each test starts from the
  // default state rather than whatever the previous test left in
  // localStorage.
  localStorage.removeItem('wrongstack-chat-lanes');
  // Four tabs means four lanes; a test that leaves one behind would hand its
  // transcript to the next test.
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── dedupeRepeatedBlocks ──────────────────────────────────────────────

describe('dedupeRepeatedBlocks (finalizeMessage)', () => {
  it('returns empty string unchanged', () => {
    addMsg({ role: 'assistant', content: '' });
    useChatStore.getState().finalizeMessage(useChatStore.getState().messages[0].id);
    expect(useChatStore.getState().messages[0].content).toBe('');
  });

  it('keeps a single paragraph', () => {
    addMsg({ role: 'assistant', content: 'unique content' });
    useChatStore.getState().finalizeMessage(useChatStore.getState().messages[0].id);
    expect(useChatStore.getState().messages[0].content).toBe('unique content');
  });

  it('removes consecutive duplicate paragraphs', () => {
    addMsg({ role: 'assistant', content: 'intro\n\nsame\n\nsame\n\noutro' });
    useChatStore.getState().finalizeMessage(useChatStore.getState().messages[0].id);
    expect(useChatStore.getState().messages[0].content).toBe('intro\n\nsame\n\noutro');
  });

  it('removes consecutive duplicate lines within a paragraph', () => {
    addMsg({ role: 'assistant', content: 'line\nline\nother' });
    useChatStore.getState().finalizeMessage(useChatStore.getState().messages[0].id);
    expect(useChatStore.getState().messages[0].content).toBe('line\nother');
  });

  it('preserves non-consecutive duplicates', () => {
    // 'a' appears in paragraphs 1 and 3 — separated by 'b', so both survive.
    addMsg({ role: 'assistant', content: 'a\n\nb\n\na' });
    useChatStore.getState().finalizeMessage(useChatStore.getState().messages[0].id);
    expect(useChatStore.getState().messages[0].content).toBe('a\n\nb\n\na');
  });

  it('sets streaming to false', () => {
    addMsg({ role: 'assistant', content: 'hello', streaming: true });
    const id = useChatStore.getState().messages[0].id;
    useChatStore.getState().finalizeMessage(id);
    expect(useChatStore.getState().messages[0].streaming).toBe(false);
  });
});

// ── addMessage ────────────────────────────────────────────────────────

describe('addMessage', () => {
  it('returns a message id', () => {
    const id = addMsg();
    expect(typeof id).toBe('string');
  });

  it('adds the message to the messages array', () => {
    addMsg();
    expect(useChatStore.getState().messages).toHaveLength(1);
  });

  it('uses provided timestamp when given', () => {
    addMsg({ timestamp: 999 });
    expect(useChatStore.getState().messages[0].timestamp).toBe(999);
  });

  it('uses Date.now() when no timestamp given', () => {
    addMsg();
    expect(useChatStore.getState().messages[0].timestamp).toBe(1_700_000_000_000);
  });

  it('sets currentAssistantMessageId when role is assistant', () => {
    addMsg({ role: 'assistant' });
    const id = useChatStore.getState().messages[0].id;
    expect(useChatStore.getState().currentAssistantMessageId).toBe(id);
  });

  it('does not change currentAssistantMessageId for user role', () => {
    const initial = useChatStore.getState().currentAssistantMessageId;
    addMsg({ role: 'user' });
    expect(useChatStore.getState().currentAssistantMessageId).toBe(initial);
  });

  it('does not change currentAssistantMessageId for tool role', () => {
    addMsg({ role: 'assistant' });
    const firstId = useChatStore.getState().currentAssistantMessageId;
    addMsg({ role: 'tool' });
    expect(useChatStore.getState().currentAssistantMessageId).toBe(firstId);
  });

  it('carries through extra fields', () => {
    addMsg({ role: 'assistant', toolName: 'Bash', toolInput: { command: 'ls' } });
    const msg = useChatStore.getState().messages[0];
    expect(msg.toolName).toBe('Bash');
    expect((msg as ChatMessage).toolInput).toEqual({ command: 'ls' });
  });

  it('indexes tool messages by toolUseId', () => {
    const id = addMsg({ role: 'tool', toolUseId: 'toolu_1' });
    expect(useChatStore.getState().getToolMessageId('toolu_1')).toBe(id);
  });
});

// ── setMessages ───────────────────────────────────────────────────────

describe('setMessages', () => {
  it('retains newest messages within an aggregate byte budget', () => {
    const retained = retainWebChatMessages(
      [
        { id: 'old', role: 'user', content: '1111', timestamp: 1 },
        { id: 'middle', role: 'assistant', content: '2222', timestamp: 2 },
        { id: 'new', role: 'assistant', content: '3333', timestamp: 3 },
      ],
      { maxMessages: 2, maxBytes: 10_000, maxFieldChars: 100 },
    );
    expect(retained.map((message) => message.id)).toEqual(['middle', 'new']);
  });

  it('bounds runaway stream fields while preserving their beginning and tail', () => {
    const bounded = boundChatField('abcdefghij', 8);
    expect(bounded).toHaveLength(8);
    expect(bounded.startsWith('abcd')).toBe(true);
    expect(bounded.endsWith('ghij')).toBe(true);
  });

  it('strips oversized attachment data from the live transcript', () => {
    const retained = retainWebChatMessages(
      [
        {
          id: 'vision',
          role: 'user',
          content: 'inspect',
          timestamp: 1,
          attachments: [
            {
              id: 'image-1',
              kind: 'image',
              dataUrl: 'x'.repeat(1_000),
              mediaType: 'image/png',
              bytes: 750,
            },
          ],
        },
      ],
      { maxMessages: 10, maxBytes: 600, maxFieldChars: 100 },
    );
    expect(retained).toHaveLength(1);
    expect(retained[0]?.attachments?.[0]?.dataUrl).toBeUndefined();
  });

  it('replaces messages in one store update and clears active stream/tool state', () => {
    const assistantId = addMsg({ role: 'assistant', content: 'streaming', streaming: true });
    const toolId = addMsg({ role: 'tool', content: '', toolUseId: 'toolu_1' });
    useChatStore.setState({ currentAssistantMessageId: assistantId, currentToolId: toolId });
    useChatStore.getState().appendThinking('old reasoning');

    useChatStore
      .getState()
      .setMessages([{ id: 'replay_0', role: 'user', content: 'resumed', timestamp: 123 }]);

    const state = useChatStore.getState();
    expect(state.messages).toEqual([
      { id: 'replay_0', role: 'user', content: 'resumed', timestamp: 123 },
    ]);
    expect(state.currentAssistantMessageId).toBeNull();
    expect(state.currentToolId).toBeNull();
    expect(state.executions.size).toBe(0);
    expect(state.getToolMessageId('toolu_1')).toBeUndefined();
    expect(state.thinkingBuffer).toBe('');
    expect(state.thinkingStartedAt).toBeNull();
    expect(state.thinkingLogBuffer).toBe('');
    expect(state.thinkingLogStartedAt).toBeNull();
  });

  it('rebuilds the toolUseId index for replayed tool messages', () => {
    useChatStore
      .getState()
      .setMessages([
        { id: 'replay_tool', role: 'tool', content: '', timestamp: 123, toolUseId: 'toolu_replay' },
      ]);

    expect(useChatStore.getState().getToolMessageId('toolu_replay')).toBe('replay_tool');
  });
});

// ── updateMessage ─────────────────────────────────────────────────────

describe('updateMessage', () => {
  it('updates a message field', () => {
    const id = addMsg({ content: 'original' });
    useChatStore.getState().updateMessage(id, { content: 'updated' });
    expect(useChatStore.getState().messages[0].content).toBe('updated');
  });

  it('merges multiple fields', () => {
    const id = addMsg({ content: 'orig' });
    useChatStore.getState().updateMessage(id, { content: 'new', isError: true });
    expect(useChatStore.getState().messages[0].content).toBe('new');
    expect(useChatStore.getState().messages[0].isError).toBe(true);
  });

  it('does not affect other messages', () => {
    const id1 = addMsg({ content: 'msg1' });
    addMsg({ content: 'msg2' });
    useChatStore.getState().updateMessage(id1, { content: 'changed' });
    expect(useChatStore.getState().messages[1].content).toBe('msg2');
  });

  it('ignores unknown id', () => {
    addMsg();
    expect(() =>
      useChatStore.getState().updateMessage('not-found', { content: 'x' }),
    ).not.toThrow();
  });

  it('does not modify other messages when updating one', () => {
    const id1 = addMsg({ content: 'msg1' });
    addMsg({ content: 'msg2' });
    useChatStore.getState().updateMessage(id1, { content: 'changed' });
    expect(useChatStore.getState().messages[1].content).toBe('msg2');
  });
});

// ── appendToMessage ───────────────────────────────────────────────────

describe('appendToMessage', () => {
  it('appends text to existing message', () => {
    const id = addMsg({ content: 'hello' });
    useChatStore.getState().appendToMessage(id, ' world');
    expect(useChatStore.getState().messages[0].content).toBe('hello world');
  });

  it('accumulates multiple appends', () => {
    const id = addMsg({ content: 'a' });
    useChatStore.getState().appendToMessage(id, 'b');
    useChatStore.getState().appendToMessage(id, 'c');
    expect(useChatStore.getState().messages[0].content).toBe('abc');
  });

  it('ignores unknown id without throwing', () => {
    expect(() => useChatStore.getState().appendToMessage('not-found', 'x')).not.toThrow();
  });
});

// ── finalizeMessage ───────────────────────────────────────────────────

describe('finalizeMessage', () => {
  it('sets streaming to false', () => {
    const id = addMsg({ role: 'assistant', content: 'hi', streaming: true });
    useChatStore.getState().finalizeMessage(id);
    expect(useChatStore.getState().messages[0].streaming).toBe(false);
  });

  it('runs dedupe on content', () => {
    // Duplicate paragraphs get collapsed.
    const id = addMsg({ role: 'assistant', content: 'intro\n\nintro\n\noutro' });
    useChatStore.getState().finalizeMessage(id);
    expect(useChatStore.getState().messages[0].content).toBe('intro\n\noutro');
  });

  it('ignores unknown id', () => {
    expect(() => useChatStore.getState().finalizeMessage('not-found')).not.toThrow();
  });
});

// ── finalizeMessage: <nextsteps> strip + persist ─────────────────────
// These tests pin the fix for the bug where the <nextsteps> block reappeared
// in the rendered body after the user selected a suggestion. The block must
// be stripped from content at finalization time and the parsed steps persisted
// on message.nextSteps so the bar can read a stable field immune to
// loading-state transitions.

describe('finalizeMessage: nextsteps strip + persist', () => {
  it('strips the <nextsteps> block from content and persists parsed steps', () => {
    const id = addMsg({
      role: 'assistant',
      content:
        'Here is my work.\n\n<nextsteps>\n1. Run the tests\n2. Commit the changes\n</nextsteps>',
      streaming: true,
    });
    useChatStore.getState().finalizeMessage(id);
    const msg = useChatStore.getState().messages[0];

    // The block is gone from content — no raw XML leaks into the body.
    expect(msg.content).not.toContain('<nextsteps>');
    expect(msg.content).not.toContain('</nextsteps>');
    expect(msg.content).not.toContain('Run the tests');
    // The preceding prose survives.
    expect(msg.content).toContain('Here is my work.');
    // Parsed steps are stored on the message.
    expect(msg.nextSteps).toEqual({
      steps: [
        { index: 1, text: 'Run the tests' },
        { index: 2, text: 'Commit the changes' },
      ],
    });
  });

  it('preserves auto="true" flag on the first step', () => {
    const id = addMsg({
      role: 'assistant',
      content: '<nextsteps>\n1. Continue automatically auto="true"\n2. Review\n</nextsteps>',
    });
    useChatStore.getState().finalizeMessage(id);
    const msg = useChatStore.getState().messages[0];

    expect(msg.nextSteps?.steps[0]).toEqual({
      index: 1,
      text: 'Continue automatically',
      auto: true,
    });
    expect(msg.nextSteps?.steps[1]).toEqual({ index: 2, text: 'Review' });
  });

  it('strips the block but does not persist steps for a mid-turn finalize', () => {
    // handleToolStarted finalizes the assistant bubble because a tool call
    // follows. The turn is still in flight, so the suggestions the model wrote
    // on its way to the tool must not reach the bar or /next — but the raw XML
    // still has to disappear from the body.
    const id = addMsg({
      role: 'assistant',
      content: 'Let me check that.\n\n<nextsteps>\n1. Run the tests\n</nextsteps>',
      streaming: true,
    });
    useChatStore.getState().finalizeMessage(id, { final: false });
    const msg = useChatStore.getState().messages[0];

    expect(msg.nextSteps).toBeUndefined();
    expect(msg.content).not.toContain('<nextsteps>');
    expect(msg.content).not.toContain('Run the tests');
    expect(msg.content).toContain('Let me check that.');
    // Still finalized — the bubble stops showing a typing indicator.
    expect(msg.streaming).toBe(false);
  });

  it('does not set nextSteps when there is no block', () => {
    const id = addMsg({
      role: 'assistant',
      content: 'Just a normal reply with no suggestions.',
    });
    useChatStore.getState().finalizeMessage(id);
    const msg = useChatStore.getState().messages[0];

    expect(msg.nextSteps).toBeUndefined();
    expect(msg.content).toBe('Just a normal reply with no suggestions.');
  });

  it('does not set nextSteps for non-assistant messages', () => {
    // Tool messages pass through finalizeMessage too (tool.started handler).
    // They must not get parsed or stripped.
    const id = addMsg({
      role: 'tool',
      toolName: 'bash',
      content: '<nextsteps>\n1. Should not be parsed\n</nextsteps>',
    });
    useChatStore.getState().finalizeMessage(id);
    const msg = useChatStore.getState().messages[0];

    expect(msg.nextSteps).toBeUndefined();
    // Content is untouched for non-assistant roles.
    expect(msg.content).toContain('<nextsteps>');
  });

  it('leaves content without the block fully intact', () => {
    const id = addMsg({
      role: 'assistant',
      content: 'Line one.\n\nLine two.\n\nLine three.',
    });
    useChatStore.getState().finalizeMessage(id);
    expect(useChatStore.getState().messages[0].content).toBe(
      'Line one.\n\nLine two.\n\nLine three.',
    );
  });
});

// ── setToolResult ─────────────────────────────────────────────────────

describe('setToolResult', () => {
  it('sets toolResult and isError on the message', () => {
    const id = addMsg({ role: 'tool' });
    useChatStore.getState().setToolResult(id, 'result data', true);
    expect(useChatStore.getState().messages[0].toolResult).toBe('result data');
    expect(useChatStore.getState().messages[0].isError).toBe(false);
  });

  it('sets isError true when ok is false', () => {
    const id = addMsg({ role: 'tool' });
    useChatStore.getState().setToolResult(id, 'error msg', false);
    expect(useChatStore.getState().messages[0].isError).toBe(true);
  });

  it('clears progressLines', () => {
    const id = addMsg({ role: 'tool', progressLines: ['line1', 'line2'] });
    useChatStore.getState().setToolResult(id, 'done', true);
    expect(useChatStore.getState().messages[0].progressLines).toBeUndefined();
  });

  it('ignores unknown id', () => {
    expect(() => useChatStore.getState().setToolResult('not-found', 'x', true)).not.toThrow();
  });

  it('sets tool results by toolUseId via the index', () => {
    addMsg({ role: 'tool', toolUseId: 'toolu_1' });
    useChatStore.getState().setToolResultByUseId('toolu_1', 'indexed result', true);
    expect(useChatStore.getState().messages[0].toolResult).toBe('indexed result');
  });
});

// ── appendToolProgressLines ───────────────────────────────────────────

describe('appendToolProgressLines', () => {
  it('adds lines to progressLines', () => {
    const id = addMsg({ role: 'tool' });
    useChatStore.getState().appendToolProgressLines(id, ['building...', 'done']);
    expect(useChatStore.getState().messages[0].progressLines).toEqual(['building...', 'done']);
  });

  it('appends to existing progressLines', () => {
    const id = addMsg({ role: 'tool', progressLines: ['step1'] });
    useChatStore.getState().appendToolProgressLines(id, ['step2']);
    expect(useChatStore.getState().messages[0].progressLines).toEqual(['step1', 'step2']);
  });

  it('caps progressLines at 30 lines', () => {
    const id = addMsg({ role: 'tool' });
    const lines = Array.from({ length: 35 }, (_, i) => `line${i}`);
    useChatStore.getState().appendToolProgressLines(id, lines);
    const kept = useChatStore.getState().messages[0].progressLines!;
    expect(kept).toHaveLength(30);
    expect(kept[0]).toBe('line5'); // last 30 = indices 5..34
  });

  it('ignores empty array', () => {
    const id = addMsg({ role: 'tool' });
    useChatStore.getState().appendToolProgressLines(id, []);
    expect(useChatStore.getState().messages[0].progressLines).toBeUndefined();
  });

  it('ignores unknown message id', () => {
    expect(() => useChatStore.getState().appendToolProgressLines('not-found', ['x'])).not.toThrow();
  });

  it('appends progress by toolUseId via the index', () => {
    addMsg({ role: 'tool', toolUseId: 'toolu_1' });
    useChatStore.getState().appendToolProgressLinesByUseId('toolu_1', ['indexed']);
    expect(useChatStore.getState().messages[0].progressLines).toEqual(['indexed']);
  });
});

// ── appendToolProgress (delegates to appendToolProgressLines) ─────────

describe('appendToolProgress', () => {
  it('appends a single line', () => {
    const id = addMsg({ role: 'tool' });
    useChatStore.getState().appendToolProgress(id, 'single line');
    expect(useChatStore.getState().messages[0].progressLines).toEqual(['single line']);
  });
});

// ── setLoading ────────────────────────────────────────────────────────

describe('setLoading', () => {
  it('sets isLoading to true', () => {
    useChatStore.getState().setLoading(true);
    expect(useChatStore.getState().isLoading).toBe(true);
  });

  it('sets isLoading to false', () => {
    useChatStore.getState().setLoading(true);
    useChatStore.getState().setLoading(false);
    expect(useChatStore.getState().isLoading).toBe(false);
  });
});

// ── setAbortController ────────────────────────────────────────────────

describe('setAbortController', () => {
  it('sets the abort controller', () => {
    const ctrl = new AbortController();
    useChatStore.getState().setAbortController(ctrl);
    expect(useChatStore.getState().abortController).toBe(ctrl);
  });

  it('can be set to null', () => {
    const ctrl = new AbortController();
    useChatStore.getState().setAbortController(ctrl);
    useChatStore.getState().setAbortController(null);
    expect(useChatStore.getState().abortController).toBeNull();
  });
});

// ── clearMessages ─────────────────────────────────────────────────────

describe('clearMessages', () => {
  it('clears all messages', () => {
    addMsg();
    addMsg();
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('resets currentAssistantMessageId to null', () => {
    addMsg({ role: 'assistant' });
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().currentAssistantMessageId).toBeNull();
  });

  it('resets currentToolId to null', () => {
    const id = addMsg();
    useChatStore.getState().setCurrentToolId(id);
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().currentToolId).toBeNull();
  });

  it('clears the executions map', () => {
    useChatStore.getState().addExecution({ id: 'exec1', name: 'test', ok: true, startedAt: 0 });
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().executions.size).toBe(0);
  });

  it('clears the toolUseId index', () => {
    addMsg({ role: 'tool', toolUseId: 'toolu_1' });
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().getToolMessageId('toolu_1')).toBeUndefined();
  });

  it('clears live and archived thinking buffers', () => {
    useChatStore.getState().appendThinking('thinking...');
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().thinkingBuffer).toBe('');
    expect(useChatStore.getState().thinkingStartedAt).toBeNull();
    expect(useChatStore.getState().thinkingLogBuffer).toBe('');
    expect(useChatStore.getState().thinkingLogStartedAt).toBeNull();
  });
});

// ── setCurrentAssistantMessage ────────────────────────────────────────

describe('setCurrentAssistantMessage', () => {
  it('sets currentAssistantMessageId', () => {
    const id = addMsg();
    useChatStore.getState().setCurrentAssistantMessage(id);
    expect(useChatStore.getState().currentAssistantMessageId).toBe(id);
  });

  it('can be set to null', () => {
    addMsg();
    useChatStore.getState().setCurrentAssistantMessage(null);
    expect(useChatStore.getState().currentAssistantMessageId).toBeNull();
  });
});

// ── setCurrentToolId ─────────────────────────────────────────────────

describe('setCurrentToolId', () => {
  it('sets currentToolId', () => {
    const id = addMsg();
    useChatStore.getState().setCurrentToolId(id);
    expect(useChatStore.getState().currentToolId).toBe(id);
  });

  it('can be set to null', () => {
    const id = addMsg();
    useChatStore.getState().setCurrentToolId(id);
    useChatStore.getState().setCurrentToolId(null);
    expect(useChatStore.getState().currentToolId).toBeNull();
  });
});

// ── truncateAfter ─────────────────────────────────────────────────────

describe('truncateAfter', () => {
  it('keeps messages up to and including the given id', () => {
    const id1 = addMsg({ content: 'msg1' });
    addMsg({ content: 'msg2' });
    addMsg({ content: 'msg3' });
    useChatStore.getState().truncateAfter(id1);
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['msg1']);
  });

  it('rebuilds the toolUseId index after truncation', () => {
    const kept = addMsg({ role: 'tool', content: '', toolUseId: 'toolu_kept' });
    addMsg({ role: 'tool', content: '', toolUseId: 'toolu_removed' });
    useChatStore.getState().truncateAfter(kept);
    expect(useChatStore.getState().getToolMessageId('toolu_kept')).toBe(kept);
    expect(useChatStore.getState().getToolMessageId('toolu_removed')).toBeUndefined();
  });

  it('keeps all messages when truncating after the last message', () => {
    addMsg({ content: 'msg1' });
    addMsg({ content: 'msg2' });
    const id3 = addMsg({ content: 'msg3' });
    useChatStore.getState().truncateAfter(id3);
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual([
      'msg1',
      'msg2',
      'msg3',
    ]);
  });

  it('resets currentAssistantMessageId to null', () => {
    addMsg({ role: 'assistant' });
    const id2 = addMsg({ role: 'assistant', content: 'msg2' });
    useChatStore.getState().truncateAfter(id2);
    expect(useChatStore.getState().currentAssistantMessageId).toBeNull();
  });

  it('resets currentToolId to null', () => {
    const id = addMsg();
    useChatStore.getState().setCurrentToolId(id);
    useChatStore.getState().truncateAfter(id);
    expect(useChatStore.getState().currentToolId).toBeNull();
  });

  it('returns state unchanged when id not found', () => {
    addMsg({ content: 'msg1' });
    useChatStore.getState().truncateAfter('not-found');
    expect(useChatStore.getState().messages).toHaveLength(1);
  });
});

// ── executions ────────────────────────────────────────────────────────

describe('addExecution', () => {
  it('adds an execution to the map', () => {
    const exec = { id: 'exec-1', name: 'Bash', ok: true, startedAt: 100 };
    useChatStore.getState().addExecution(exec);
    expect(useChatStore.getState().executions.get('exec-1')).toEqual(exec);
  });

  it('can add multiple executions', () => {
    useChatStore.getState().addExecution({ id: 'e1', name: 'x', ok: true, startedAt: 0 });
    useChatStore.getState().addExecution({ id: 'e2', name: 'y', ok: false, startedAt: 1 });
    expect(useChatStore.getState().executions.size).toBe(2);
  });
});

describe('updateExecution', () => {
  it('updates an existing execution', () => {
    useChatStore.getState().addExecution({ id: 'e1', name: 'Bash', ok: true, startedAt: 0 });
    useChatStore.getState().updateExecution('e1', { ok: false, completedAt: 50 });
    expect(useChatStore.getState().executions.get('e1')).toMatchObject({
      name: 'Bash',
      ok: false,
      completedAt: 50,
    });
  });

  it('ignores unknown execution id', () => {
    expect(() => useChatStore.getState().updateExecution('not-found', { ok: false })).not.toThrow();
  });
});

// ── queue ─────────────────────────────────────────────────────────────

describe('enqueue', () => {
  it('adds a message to the queue', () => {
    useChatStore.getState().enqueue('hello');
    const queue = useChatStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0]?.text).toBe('hello');
    // Default mode is 'queue' so the next-run drain picks it up.
    expect(queue[0]?.mode).toBe('queue');
  });

  it('appends to existing queue in arrival order', () => {
    useChatStore.getState().enqueue('a');
    useChatStore.getState().enqueue('b');
    expect(useChatStore.getState().queue.map((q) => q.text)).toEqual(['a', 'b']);
  });

  it('stores the mode passed in (btw / steer / queue)', () => {
    useChatStore.getState().enqueue('one', 'btw');
    useChatStore.getState().enqueue('two', 'steer');
    useChatStore.getState().enqueue('three', 'queue');
    const modes = useChatStore.getState().queue.map((q) => q.mode);
    expect(modes).toEqual(['btw', 'steer', 'queue']);
  });

  it('records a wall-clock timestamp on each enqueue', () => {
    useChatStore.getState().enqueue('a');
    useChatStore.getState().enqueue('b');
    const [first, second] = useChatStore.getState().queue;
    expect(typeof first?.addedAt).toBe('number');
    expect(typeof second?.addedAt).toBe('number');
    expect(second!.addedAt).toBeGreaterThanOrEqual(first!.addedAt);
  });
});

describe('dequeue', () => {
  it('removes and returns the first item', () => {
    useChatStore.getState().enqueue('first');
    useChatStore.getState().enqueue('second');
    const popped = useChatStore.getState().dequeue();
    expect(popped?.text).toBe('first');
    expect(useChatStore.getState().queue.map((q) => q.text)).toEqual(['second']);
  });

  it('returns null when queue is empty', () => {
    expect(useChatStore.getState().dequeue()).toBeNull();
  });
});

describe('removeQueued', () => {
  it('removes item at the given index', () => {
    useChatStore.getState().enqueue('a');
    useChatStore.getState().enqueue('b');
    useChatStore.getState().enqueue('c');
    useChatStore.getState().removeQueued(1);
    expect(useChatStore.getState().queue.map((q) => q.text)).toEqual(['a', 'c']);
  });
});

describe('clearQueue', () => {
  it('empties the queue', () => {
    useChatStore.getState().enqueue('a');
    useChatStore.getState().enqueue('b');
    useChatStore.getState().clearQueue();
    expect(useChatStore.getState().queue).toEqual([]);
  });
});

// ── BTW queue → SENT → leave-screen lifecycle ───────────────────────────
// Regression: a `btw` chip that was wire-sent at submit time (the
// "SENT" stage) stays visible until the next `run.result` lands, and
// the run.result drain must skip re-sending it via the mailbox. The
// chip carries `alreadyDispatched` plus an internal monotonic `itemId`
// used to own its grace timer without `Date.now()` collisions.
describe('BTW dispatched chip lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChatStore.setState({ queue: [], messages: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    useChatStore.setState({ queue: [], messages: [] });
  });

  it('stamps alreadyDispatched when enqueue fires with the flag', () => {
    useChatStore.getState().enqueue('btw note', 'btw', undefined, true);
    const item = useChatStore.getState().queue[0]!;
    expect(item.alreadyDispatched).toBe(true);
    // No wall-clock dispatch timestamp or bubble state is stamped at enqueue.
    // `itemId` is the internal monotonic key for the grace timer.
    expect(item).not.toHaveProperty('dispatchedAt');
    expect(typeof item.itemId).toBe('number');
    expect(item.bubbleAdded).toBeUndefined();
  });

  it('treats a non-dispatched chip as the regular queue path', () => {
    useChatStore.getState().enqueue('btw note', 'btw', undefined, false);
    const item = useChatStore.getState().queue[0]!;
    expect(item.alreadyDispatched).toBeFalsy();
  });

  it('assigns a unique itemId to each enqueue even within the same millisecond', () => {
    const before = Date.now();
    useChatStore.getState().enqueue('a', 'btw', undefined, true);
    useChatStore.getState().enqueue('b', 'btw', undefined, true);
    const ids = useChatStore.getState().queue.map((q) => q.itemId);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
    // Both addedAt are identical (same-ms) — the itemId counter is what
    // keeps the grace timers from cross-cancelling.
    expect(useChatStore.getState().queue[0]!.addedAt).toBe(before);
    expect(useChatStore.getState().queue[1]!.addedAt).toBe(before);
  });

  it('removes the chip from the queue after BTW_DISPATCH_GRACE_MS', () => {
    useChatStore.getState().enqueue('btw note', 'btw', undefined, true);
    vi.advanceTimersByTime(BTW_DISPATCH_GRACE_MS + 1);
    expect(useChatStore.getState().queue).toEqual([]);
  });

  it('does NOT auto-remove non-dispatched items (no grace timer scheduled)', () => {
    useChatStore.getState().enqueue('btw note', 'btw', undefined, false);
    vi.advanceTimersByTime(60_000);
    expect(useChatStore.getState().queue).toHaveLength(1);
  });

  it('cancels the grace timer when the user removes the chip manually', () => {
    useChatStore.getState().enqueue('btw note', 'btw', undefined, true);
    useChatStore.getState().removeQueued(0);
    expect(useChatStore.getState().queue).toEqual([]);
    // Advance past the grace window — even if a stale timer remained,
    // the queue is empty so nothing happens.
    vi.advanceTimersByTime(BTW_DISPATCH_GRACE_MS + 1);
    expect(useChatStore.getState().queue).toEqual([]);
  });

  it('cancels all pending grace timers when clearQueue is called', () => {
    useChatStore.getState().enqueue('a', 'btw', undefined, true);
    useChatStore.getState().enqueue('b', 'btw', undefined, true);
    useChatStore.getState().clearQueue();
    vi.advanceTimersByTime(BTW_DISPATCH_GRACE_MS + 1);
    expect(useChatStore.getState().queue).toEqual([]);
  });
});

// ── runStart ─────────────────────────────────────────────────────────

describe('setRunStart', () => {
  it('sets runStart', () => {
    const val = { at: 1000, cost: 0.05 };
    useChatStore.getState().setRunStart(val);
    expect(useChatStore.getState().runStart).toEqual(val);
  });

  it('can be set to null', () => {
    useChatStore.getState().setRunStart({ at: 1, cost: 0 });
    useChatStore.getState().setRunStart(null);
    expect(useChatStore.getState().runStart).toBeNull();
  });
});

// ── thinkingBuffer ────────────────────────────────────────────────────

describe('appendThinking', () => {
  it('appends text to thinkingBuffer', () => {
    useChatStore.getState().appendThinking('thinking...');
    expect(useChatStore.getState().thinkingBuffer).toBe('thinking...');
  });

  it('accumulates across calls', () => {
    useChatStore.getState().appendThinking('part1');
    useChatStore.getState().appendThinking('part2');
    expect(useChatStore.getState().thinkingBuffer).toBe('part1part2');
  });

  it('sets thinkingStartedAt on first call', () => {
    expect(useChatStore.getState().thinkingStartedAt).toBeNull();
    useChatStore.getState().appendThinking('x');
    expect(useChatStore.getState().thinkingStartedAt).toBe(1_700_000_000_000);
  });

  it('also appends to the persistent thinking log buffer', () => {
    useChatStore.getState().appendThinking('part1');
    useChatStore.getState().appendThinking('part2');
    expect(useChatStore.getState().thinkingLogBuffer).toBe('part1part2');
    expect(useChatStore.getState().thinkingLogStartedAt).toBe(1_700_000_000_000);
  });

  it('does not reset thinkingStartedAt on subsequent calls', () => {
    useChatStore.getState().appendThinking('first');
    const firstAt = useChatStore.getState().thinkingStartedAt!;
    useChatStore.getState().appendThinking('second');
    expect(useChatStore.getState().thinkingStartedAt).toBe(firstAt);
  });
});

describe('clearThinking', () => {
  it('clears thinkingBuffer', () => {
    useChatStore.getState().appendThinking('thinking...');
    useChatStore.getState().clearThinking();
    expect(useChatStore.getState().thinkingBuffer).toBe('');
  });

  it('sets thinkingStartedAt to null', () => {
    useChatStore.getState().appendThinking('x');
    useChatStore.getState().clearThinking();
    expect(useChatStore.getState().thinkingStartedAt).toBeNull();
  });

  it('does not clear the persistent thinking log buffer', () => {
    useChatStore.getState().appendThinking('thinking...');
    useChatStore.getState().clearThinking();
    expect(useChatStore.getState().thinkingLogBuffer).toBe('thinking...');
    expect(useChatStore.getState().thinkingLogStartedAt).toBe(1_700_000_000_000);
  });
});

describe('flushThinkingLog', () => {
  it('archives the thinking log as a system chat message', () => {
    useChatStore.getState().appendThinking('line 1\nline 2\n');
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_001_250);

    useChatStore.getState().flushThinkingLog(3);

    const msg = useChatStore.getState().messages[0];
    expect(msg.role).toBe('system');
    expect(msg.content).toBe('');
    expect(msg.thinkingLog).toEqual({
      iteration: 3,
      text: 'line 1\nline 2',
      startedAt: 1_700_000_000_000,
      durationMs: 1_250,
    });
    expect(useChatStore.getState().thinkingLogBuffer).toBe('');
    expect(useChatStore.getState().thinkingLogStartedAt).toBeNull();
  });

  it('does not create a message for an empty thinking log', () => {
    useChatStore.setState({ thinkingLogBuffer: '   \n', thinkingLogStartedAt: 1_700_000_000_000 });

    useChatStore.getState().flushThinkingLog(1);

    expect(useChatStore.getState().messages).toEqual([]);
  });
});

// ── F5 resilience: chat transcript persistence ──────────────────────
//
// After F5 the chat transcript + queued messages must round-trip through
// localStorage so a page refresh doesn't lose work-in-progress.
//
// What we persist (from partialize):
//   • messages
//   • queue
//   • boundSessionId
//   • thinkingLogBuffer
//
// What we deliberately do NOT persist:
//   • isLoading, abortController (non-serializable)
//   • executions Map (runtime-only, rebuilt from messages)
//   • currentAssistantMessageId, currentToolId (rebuilt by render)
//   • thinkingBuffer, thinkingStartedAt (live ephemeral bubble)
//   • runStart (resets per turn)
//   • toolMessageIdsByUseId (rebuilt from messages via indexToolMessages)
describe('F5 resilience — chat transcript persistence', () => {
  const laneOptions = useChatStore.persist.getOptions();
  const activeLane = (blob: {
    state: { activeSessionId: string; lanes: Record<string, Record<string, unknown>> };
  }) => blob.state.lanes[blob.state.activeSessionId]!;

  function readBlob() {
    const raw = localStorage.getItem('wrongstack-chat-lanes');
    expect(raw).toBeTruthy();
    return JSON.parse(raw!) as {
      state: { activeSessionId: string; lanes: Record<string, Record<string, unknown>> };
    };
  }

  it('persists messages + queue + the active tab under the lane key', () => {
    useChatStore.getState().setBoundSessionId('sess-LIVE');
    addMsg({ role: 'user', content: 'pre-refresh message' });
    useChatStore.getState().enqueue('typed but not sent', 'queue');

    useChatStore.persist.flush?.();

    const blob = readBlob();
    expect(blob.state.activeSessionId).toBe('sess-LIVE');
    const lane = activeLane(blob);
    expect(Array.isArray(lane.messages)).toBe(true);
    expect((lane.messages as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(lane.queue)).toBe(true);
  });

  it('persists a background tab too, so a reload restores all four', () => {
    // The whole point of lanes: a refresh must not empty the three tabs that
    // were not in front.
    useChatStore.getState().setBoundSessionId('sess-A');
    addMsg({ role: 'user', content: 'tab A' });
    useChatStore.getState().setBoundSessionId('sess-B');
    addMsg({ role: 'user', content: 'tab B' });

    useChatStore.persist.flush?.();
    const blob = readBlob();
    expect(blob.state.activeSessionId).toBe('sess-B');
    expect(blob.state.lanes['sess-A']?.messages).toHaveLength(1);
    expect(blob.state.lanes['sess-B']?.messages).toHaveLength(1);
  });

  it('does NOT persist non-serializable runtime fields', () => {
    useChatStore.getState().setBoundSessionId('sess-LIVE');
    const ac = new AbortController();
    useChatStore.setState({
      isLoading: true,
      abortController: ac,
      runStart: { at: 1, cost: 0.5 },
      currentAssistantMessageId: 'pending-bubble',
      currentToolId: 'tool-pending',
      executions: new Map([['e1', { id: 'e1', name: 'bash', startedAt: 1, ok: false }]]),
      toolMessageIdsByUseId: new Map([['u1', 'm1']]),
      thinkingBuffer: 'live ephemeral',
      thinkingStartedAt: 999,
    });
    useChatStore.getState().enqueue('keep this');
    useChatStore.persist.flush?.();
    const lane = activeLane(readBlob());
    for (const field of [
      'isLoading',
      'abortController',
      'runStart',
      'currentAssistantMessageId',
      'currentToolId',
      'executions',
      'toolMessageIdsByUseId',
      'thinkingBuffer',
      'thinkingStartedAt',
    ]) {
      expect(lane[field], field).toBeUndefined();
    }
    expect(Array.isArray(lane.queue)).toBe(true);
  });

  it('merge() tolerates a lane whose messages/queue are not arrays', () => {
    const merged = laneOptions.merge?.(
      { activeSessionId: 'X', lanes: { X: { messages: 'not-an-array', queue: null } } },
      { lanes: {}, activeSessionId: '__unbound__' } as never,
    ) as {
      activeSessionId: string;
      lanes: Record<string, { messages: unknown[]; queue: unknown[] }>;
    };
    expect(merged.activeSessionId).toBe('X');
    expect(merged.lanes.X?.messages).toEqual([]);
    expect(merged.lanes.X?.queue).toEqual([]);
  });

  it('merge() falls back to the pre-session lane when the blob names none', () => {
    const merged = laneOptions.merge?.({}, {
      lanes: {},
      activeSessionId: 'ignored',
    } as never) as { activeSessionId: string; lanes: Record<string, unknown> };
    expect(merged.activeSessionId).toBe('__unbound__');
    expect(merged.lanes).toEqual({});
  });

  it('merge() stamps `itemId` on legacy queue items that lack one (CHIMERA fix)', () => {
    // Legacy blobs had no `itemId` on persisted pending items, but the current
    // schema declares it required — `removeQueued`/`dequeue` would otherwise
    // see `undefined` and cancel the wrong grace timer.
    const merged = laneOptions.merge?.(
      {
        activeSessionId: 'X',
        lanes: {
          X: { messages: [], queue: [{ text: 'legacy pending', mode: 'queue', addedAt: 1 }] },
        },
      },
      { lanes: {}, activeSessionId: '__unbound__' } as never,
    ) as { lanes: Record<string, { queue: Array<{ itemId: number }> }> };
    expect(merged.lanes.X?.queue).toHaveLength(1);
    expect(typeof merged.lanes.X?.queue[0]?.itemId).toBe('number');
    expect(merged.lanes.X?.queue[0]?.itemId).toBeGreaterThan(0);
  });

  it('merge() seeds enqueueSequence from the max persisted itemId (no collision after F5)', () => {
    laneOptions.merge?.(
      {
        activeSessionId: 'X',
        lanes: {
          X: {
            messages: [],
            queue: [{ text: 'rehydrated', mode: 'queue', addedAt: 1, itemId: 42 }],
          },
        },
      },
      { lanes: {}, activeSessionId: '__unbound__' } as never,
    );
    useChatStore.getState().enqueue('fresh', 'queue');
    const fresh = useChatStore.getState().queue.at(-1)!;
    expect(fresh.itemId).toBeGreaterThan(42);
  });

  it('merge() keeps at most MAX_LANES lanes', () => {
    const lanes: Record<string, unknown> = {};
    for (let i = 0; i < 9; i++) lanes[`s${i}`] = { messages: [], queue: [] };
    const merged = laneOptions.merge?.({ activeSessionId: 's0', lanes }, {
      lanes: {},
      activeSessionId: '__unbound__',
    } as never) as { lanes: Record<string, unknown> };
    expect(Object.keys(merged.lanes)).toHaveLength(4);
  });

  it('clearMessages() empties the lane but leaves the tab bound', () => {
    // Under lanes the binding IS the tab, not a marker for bleed detection:
    // clearing a transcript must not orphan the tab that is still on screen.
    useChatStore.getState().setBoundSessionId('sess-A');
    useChatStore.getState().addMessage({ role: 'user', content: 'session A msg' });
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().boundSessionId).toBe('sess-A');
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('setBoundSessionId() switches which lane the surface renders', () => {
    useChatStore.getState().setBoundSessionId('sess-A');
    useChatStore.getState().addMessage({ role: 'user', content: 'A only' });
    useChatStore.getState().setBoundSessionId('sess-B');
    expect(useChatStore.getState().boundSessionId).toBe('sess-B');
    expect(useChatStore.getState().messages).toEqual([]);

    // ...and switching back finds tab A exactly as it was left.
    useChatStore.getState().setBoundSessionId('sess-A');
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['A only']);
  });

  it('addMessage caps messages at MAX_CHAT_MESSAGES (1000) and drops oldest', () => {
    // Seed 1500 messages to exceed the cap.
    for (let i = 0; i < 1500; i++) {
      useChatStore.getState().addMessage(makeMsg({ role: 'user', content: `m${i}` }));
    }
    const { messages } = useChatStore.getState();
    expect(messages).toHaveLength(1000);
    // The 501st message (m500) is the oldest survivor; the first 500 were dropped.
    expect(messages[0]?.content).toBe('m500');
    expect(messages[999]?.content).toBe('m1499');
  });

  it('addMessage prunes executions Map entries for tool_ids no longer in messages', () => {
    useChatStore
      .getState()
      .addMessage(makeMsg({ role: 'tool', content: 'old tool result', toolUseId: 'tool-old' }));
    expect(useChatStore.getState().toolMessageIdsByUseId.has('tool-old')).toBe(true);

    // Fill past MAX_CHAT_MESSAGES so 'tool-old' is rolled out of the window.
    for (let i = 0; i < 1005; i++) {
      useChatStore.getState().addMessage(makeMsg({ role: 'user', content: `fill ${i}` }));
    }
    expect(useChatStore.getState().toolMessageIdsByUseId.has('tool-old')).toBe(false);
  });
});

function setChatPersisted(value: Record<string, unknown> | null): void {
  if (value === null) {
    localStorage.removeItem('wrongstack-chat-lanes');
    return;
  }
  localStorage.setItem('wrongstack-chat-lanes', JSON.stringify(value));
}
