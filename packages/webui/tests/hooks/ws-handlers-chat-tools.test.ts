import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
vi.mock('@/components/Toaster', () => ({ toast }));

const setFaviconStatus = vi.fn();
vi.mock('@/lib/favicon', () => ({ setFaviconStatus }));

const wsClient = { sendConfirm: vi.fn(), sendMessage: vi.fn(), send: vi.fn() };
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => wsClient }));

const playPermissionChime = vi.fn();
const playCompletionChime = vi.fn();
vi.mock('@/lib/chime', () => ({ playPermissionChime, playCompletionChime }));

const notifyIfHidden = vi.fn();
const ensureNotificationPermission = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notify', () => ({ notifyIfHidden, ensureNotificationPermission }));

const { useChatStore, useSessionStore, useUIStore } = await import('../../src/stores');
const { useLocalPrefs } = await import('../../src/stores/local-prefs');
const { streamCoalescer } = await import('../../src/lib/stream-coalescer');
const {
  handleIterationStarted,
  handleThinkingDelta,
  handleToolConfirmNeeded,
  handleToolExecuted,
  handleToolProgress,
  handleToolStarted,
  chatHandlerMap,
} = await import('../../src/hooks/ws-handlers/chat-handlers');

function msg(type: string, payload: unknown) {
  return { type, payload } as never;
}

const chat = () => useChatStore.getState();

function messages() {
  return chat().messages as unknown as Array<Record<string, unknown>>;
}

/** Push every coalesced buffer through so assertions see final text. */
function flush() {
  streamCoalescer.flushAll();
}

describe('chat ws-handlers — iteration / deltas / tool lifecycle', () => {
  beforeEach(() => {
    for (const fn of Object.values(toast)) fn.mockReset();
    setFaviconStatus.mockReset();
    playPermissionChime.mockReset();
    notifyIfHidden.mockReset();
    wsClient.sendConfirm.mockReset();
    streamCoalescer.flushAll();
    useChatStore.setState({
      messages: [],
      isLoading: false,
      currentAssistantMessageId: null,
      currentToolId: null,
      runStart: null,
      thinkingBuffer: '',
      thinkingLogBuffer: '',
      // `executions` and `toolMessageIdsByUseId` are Maps, not arrays — the
      // store does `new Map(state.executions)` on every write.
      executions: new Map(),
      toolMessageIdsByUseId: new Map(),
      queue: [],
    } as never);
    useSessionStore.setState({ session: null, iteration: null, cost: 0 } as never);
    useUIStore.setState({ confirmInfo: null } as never);
    useLocalPrefs.setState({ yolo: false } as never);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('registers each handler under its wire type', () => {
    expect(chatHandlerMap['tool.started']).toBe(handleToolStarted);
    expect(chatHandlerMap['tool.progress']).toBe(handleToolProgress);
    expect(chatHandlerMap['tool.executed']).toBe(handleToolExecuted);
    expect(chatHandlerMap['tool.confirm_needed']).toBe(handleToolConfirmNeeded);
  });

  // ── iteration.started ─────────────────────────────────────────────────────

  describe('iteration.started', () => {
    it('records the iteration and enters the loading state', () => {
      handleIterationStarted(msg('iteration.started', { index: 2, maxIterations: 50 }));
      expect(useSessionStore.getState().iteration).toEqual({ index: 2, max: 50 });
      expect(chat().isLoading).toBe(true);
    });

    it('defaults a missing maxIterations to 0', () => {
      handleIterationStarted(msg('iteration.started', { index: 1 }));
      expect(useSessionStore.getState().iteration).toEqual({ index: 1, max: 0 });
    });

    it('stamps runStart once and keeps it across iterations', () => {
      useSessionStore.setState({ cost: 1.5 } as never);
      handleIterationStarted(msg('iteration.started', { index: 1 }));
      const first = chat().runStart;
      expect(first).toMatchObject({ cost: 1.5 });

      handleIterationStarted(msg('iteration.started', { index: 2 }));
      expect(chat().runStart).toBe(first);
    });

    it('clears any in-progress assistant bubble', () => {
      useChatStore.setState({ currentAssistantMessageId: 'm1' } as never);
      handleIterationStarted(msg('iteration.started', { index: 1 }));
      expect(chat().currentAssistantMessageId).toBeNull();
    });

    it('flags the favicon only when the tab is hidden', () => {
      handleIterationStarted(msg('iteration.started', { index: 1 }));
      expect(setFaviconStatus).not.toHaveBeenCalled();

      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      handleIterationStarted(msg('iteration.started', { index: 2 }));
      expect(setFaviconStatus).toHaveBeenCalledWith('running');
    });

    it('is dropped for a non-active session', () => {
      useSessionStore.setState({ session: { id: 's1' } } as never);
      handleIterationStarted(msg('iteration.started', { sessionId: 'other', index: 9 }));
      expect(useSessionStore.getState().iteration).toBeNull();
    });
  });

  // ── deltas ────────────────────────────────────────────────────────────────

  describe('provider.text_delta', () => {
    it('opens a streaming assistant bubble on the first token', () => {
      const { handleTextDelta } = chatHandlerMapModule();
      handleTextDelta(msg('provider.text_delta', { text: 'Hel', messageId: 'x' }));
      flush();
      expect(messages()).toHaveLength(1);
      expect(messages()[0]).toMatchObject({ role: 'assistant', streaming: true });
      expect(chat().currentAssistantMessageId).not.toBeNull();
    });

    it('appends later tokens to the same bubble', () => {
      const { handleTextDelta } = chatHandlerMapModule();
      handleTextDelta(msg('provider.text_delta', { text: 'Hel', messageId: 'x' }));
      handleTextDelta(msg('provider.text_delta', { text: 'lo', messageId: 'x' }));
      flush();
      expect(messages()).toHaveLength(1);
      expect(messages()[0]?.content).toBe('Hello');
    });

    it('ignores an empty delta', () => {
      const { handleTextDelta } = chatHandlerMapModule();
      handleTextDelta(msg('provider.text_delta', { text: '', messageId: 'x' }));
      flush();
      expect(messages()).toHaveLength(0);
    });

    it('is dropped for a non-active session', () => {
      useSessionStore.setState({ session: { id: 's1' } } as never);
      const { handleTextDelta } = chatHandlerMapModule();
      handleTextDelta(
        msg('provider.text_delta', { sessionId: 'other', text: 'x', messageId: 'y' }),
      );
      flush();
      expect(messages()).toHaveLength(0);
    });
  });

  describe('provider.thinking_delta', () => {
    it('accumulates into the thinking buffer, not the transcript', () => {
      handleThinkingDelta(msg('provider.thinking_delta', { text: 'pondering…' }));
      flush();
      expect(messages()).toHaveLength(0);
      expect(chat().thinkingBuffer).toContain('pondering…');
    });

    it('ignores an empty delta', () => {
      handleThinkingDelta(msg('provider.thinking_delta', { text: '' }));
      flush();
      expect(chat().thinkingBuffer).toBe('');
    });
  });

  // ── tool lifecycle ────────────────────────────────────────────────────────

  describe('tool.started', () => {
    it('opens a tool bubble and records an execution', () => {
      handleToolStarted(
        msg('tool.started', {
          id: 'tu1',
          name: 'read_file',
          input: { path: 'a.ts' },
          messageId: 'm',
        }),
      );
      const bubble = messages().find((m) => m.role === 'tool');
      expect(bubble).toMatchObject({
        toolName: 'read_file',
        toolUseId: 'tu1',
        toolInput: { path: 'a.ts' },
      });
      expect(chat().currentToolId).toBe(bubble?.id);
      expect(chat().executions.size).toBe(1);
      expect(chat().executions.get('tu1')).toMatchObject({
        id: 'tu1',
        name: 'read_file',
        ok: true,
      });
    });

    it('reuses the existing bubble when the same tool_use id repeats', () => {
      const frame = msg('tool.started', {
        id: 'tu1',
        name: 'read_file',
        input: {},
        messageId: 'm',
      });
      handleToolStarted(frame);
      const count = messages().length;
      handleToolStarted(frame);
      expect(messages()).toHaveLength(count);
      expect(chat().executions.size).toBe(1);
    });

    it('finalizes a streaming assistant bubble before the tool bubble', () => {
      const { handleTextDelta } = chatHandlerMapModule();
      handleTextDelta(msg('provider.text_delta', { text: 'thinking out loud', messageId: 'x' }));
      const assistantId = chat().currentAssistantMessageId;
      expect(assistantId).not.toBeNull();

      handleToolStarted(
        msg('tool.started', { id: 'tu1', name: 'bash', input: {}, messageId: 'm' }),
      );
      const assistant = messages().find((m) => m.id === assistantId);
      expect(assistant?.streaming).toBeFalsy();
      expect(chat().currentAssistantMessageId).toBeNull();
    });

    it('falls back to the tool name when no id is sent', () => {
      handleToolStarted(msg('tool.started', { name: 'bash', input: {}, messageId: 'm' }));
      expect(messages().find((m) => m.role === 'tool')).toMatchObject({ toolUseId: 'bash' });
    });
  });

  describe('tool.progress', () => {
    function startTool() {
      handleToolStarted(
        msg('tool.started', { id: 'tu1', name: 'bash', input: {}, messageId: 'm' }),
      );
    }

    it('appends progress lines to the owning tool bubble', () => {
      startTool();
      handleToolProgress(
        msg('tool.progress', {
          id: 'tu1',
          name: 'bash',
          event: { type: 'stdout', text: 'line 1' },
        }),
      );
      flush();
      const bubble = messages().find((m) => m.toolUseId === 'tu1');
      expect(JSON.stringify(bubble?.progressLines ?? [])).toContain('line 1');
    });

    it('marks a warning event with a sigil', () => {
      startTool();
      handleToolProgress(
        msg('tool.progress', {
          id: 'tu1',
          name: 'bash',
          event: { type: 'warning', text: 'slow' },
        }),
      );
      flush();
      const bubble = messages().find((m) => m.toolUseId === 'tu1');
      expect(JSON.stringify(bubble?.progressLines ?? [])).toContain('⚠ slow');
    });

    it('ignores an empty progress line', () => {
      startTool();
      const before = JSON.stringify(messages());
      handleToolProgress(
        msg('tool.progress', { id: 'tu1', name: 'bash', event: { type: 'stdout', text: '  ' } }),
      );
      flush();
      expect(JSON.stringify(messages())).toBe(before);
    });

    it('ignores progress for a tool with no bubble', () => {
      handleToolProgress(
        msg('tool.progress', { id: 'ghost', name: 'bash', event: { type: 'stdout', text: 'x' } }),
      );
      flush();
      expect(messages()).toHaveLength(0);
    });
  });

  describe('tool.executed', () => {
    function startTool(id = 'tu1') {
      handleToolStarted(msg('tool.started', { id, name: 'bash', input: {}, messageId: 'm' }));
    }

    it('records the result, duration and clears the current tool', () => {
      startTool();
      handleToolExecuted(
        msg('tool.executed', { id: 'tu1', name: 'bash', ok: true, output: 'done', durationMs: 42 }),
      );
      const bubble = messages().find((m) => m.toolUseId === 'tu1');
      expect(bubble).toMatchObject({ toolDurationMs: 42 });
      expect(chat().currentToolId).toBeNull();
    });

    it('completes the execution record', () => {
      startTool();
      handleToolExecuted(
        msg('tool.executed', { id: 'tu1', name: 'bash', ok: false, output: 'boom', durationMs: 7 }),
      );
      expect(chat().executions.get('tu1')).toMatchObject({
        id: 'tu1',
        ok: false,
        output: 'boom',
        durationMs: 7,
      });
      expect(chat().executions.get('tu1')?.completedAt).toBeGreaterThan(0);
    });

    it('completes a tool bubble restored after F5', () => {
      chat().setMessages([
        {
          id: 'msg-tool',
          role: 'tool',
          content: '',
          toolName: 'bash',
          toolInput: {},
          toolUseId: 'tu1',
          timestamp: 123,
        },
      ] as never);

      handleToolExecuted(
        msg('tool.executed', { id: 'tu1', name: 'bash', ok: true, output: 'done', durationMs: 9 }),
      );

      expect(messages()[0]).toMatchObject({ toolResult: 'done', toolDurationMs: 9 });
      expect(chat().executions.get('tu1')).toMatchObject({
        ok: true,
        output: 'done',
        durationMs: 9,
      });
    });

    it('treats a missing ok flag as success', () => {
      startTool();
      handleToolExecuted(msg('tool.executed', { id: 'tu1', name: 'bash', durationMs: 1 }));
      expect(chat().executions.get('tu1')?.ok).toBe(true);
    });

    it('defaults a missing output to an empty string', () => {
      startTool();
      handleToolExecuted(
        msg('tool.executed', { id: 'tu1', name: 'bash', ok: true, durationMs: 1 }),
      );
      const bubble = messages().find((m) => m.toolUseId === 'tu1');
      expect(bubble?.toolResult ?? '').toBe('');
    });

    it('is inert for a tool that was never started', () => {
      expect(() =>
        handleToolExecuted(
          msg('tool.executed', { id: 'ghost', name: 'bash', ok: true, durationMs: 1 }),
        ),
      ).not.toThrow();
    });

    it('leaves an unrelated current tool selected', () => {
      startTool('tu1');
      startTool('tu2');
      const current = chat().currentToolId;
      handleToolExecuted(
        msg('tool.executed', { id: 'tu1', name: 'bash', ok: true, durationMs: 1 }),
      );
      expect(chat().currentToolId).toBe(current);
    });
  });

  // ── tool.confirm_needed ───────────────────────────────────────────────────

  describe('tool.confirm_needed', () => {
    const base = {
      id: 'c1',
      toolName: 'bash',
      input: { cmd: 'rm -rf /' },
      suggestedPattern: 'rm *',
    };

    it('opens the confirm dialog and chimes', () => {
      handleToolConfirmNeeded(msg('tool.confirm_needed', base));
      expect(useUIStore.getState().confirmInfo).toMatchObject({ id: 'c1', toolName: 'bash' });
      expect(playPermissionChime).toHaveBeenCalled();
      expect(wsClient.sendConfirm).not.toHaveBeenCalled();
    });

    it('carries the risk tier and decision source through', () => {
      handleToolConfirmNeeded(
        msg('tool.confirm_needed', {
          ...base,
          riskTier: 'destructive',
          decisionSource: 'policy',
        }),
      );
      expect(useUIStore.getState().confirmInfo).toMatchObject({
        riskTier: 'destructive',
        decisionSource: 'policy',
      });
    });

    it('auto-approves in YOLO mode without opening a dialog', () => {
      useLocalPrefs.setState({ yolo: true } as never);
      handleToolConfirmNeeded(msg('tool.confirm_needed', base));
      expect(wsClient.sendConfirm).toHaveBeenCalledWith('c1', 'yes');
      expect(useUIStore.getState().confirmInfo).toBeNull();
    });

    it('still asks in YOLO mode when a boundary was crossed', () => {
      useLocalPrefs.setState({ yolo: true } as never);
      handleToolConfirmNeeded(
        msg('tool.confirm_needed', { ...base, boundaryReason: 'outside project root' }),
      );
      expect(wsClient.sendConfirm).not.toHaveBeenCalled();
      expect(useUIStore.getState().confirmInfo).toMatchObject({
        boundaryReason: 'outside project root',
      });
    });

    it('survives a blocked audio policy', () => {
      playPermissionChime.mockImplementation(() => {
        throw new Error('NotAllowedError');
      });
      expect(() => handleToolConfirmNeeded(msg('tool.confirm_needed', base))).not.toThrow();
      expect(useUIStore.getState().confirmInfo).not.toBeNull();
    });

    it('notifies with the project name when the tab is hidden', () => {
      useSessionStore.setState({ projectName: 'WrongStack' } as never);
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      handleToolConfirmNeeded(msg('tool.confirm_needed', base));
      expect(notifyIfHidden).toHaveBeenCalledWith(
        'WrongStack needs approval',
        'Tool "bash" is waiting for your decision.',
        'agent-confirm',
      );
      expect(setFaviconStatus).toHaveBeenCalledWith('attention');
    });

    it('falls back to a generic label with no project name', () => {
      useSessionStore.setState({ projectName: '' } as never);
      handleToolConfirmNeeded(msg('tool.confirm_needed', base));
      expect(notifyIfHidden).toHaveBeenCalledWith(
        'Agent needs approval',
        expect.any(String),
        'agent-confirm',
      );
    });

    it('is dropped for a non-active session', () => {
      useSessionStore.setState({ session: { id: 's1' } } as never);
      handleToolConfirmNeeded(msg('tool.confirm_needed', { ...base, sessionId: 'other' }));
      expect(useUIStore.getState().confirmInfo).toBeNull();
    });
  });
});

/** Late import so the mocked modules above are already installed. */
function chatHandlerMapModule() {
  return {
    handleTextDelta: chatHandlerMap['provider.text_delta'] as (m: never) => void,
  };
}
