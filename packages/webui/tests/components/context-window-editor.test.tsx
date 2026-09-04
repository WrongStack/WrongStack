import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextWindowEditor } from '../../src/components/context-editor/ContextWindowEditor';
import { DEFAULT_LANE_ID, disposeLane, useChatLanes } from '../../src/stores/chat-lanes';
import { useContextEditorStore } from '../../src/stores/context-editor-store';
import { useSessionStore } from '../../src/stores/session-store';

const wsMock = vi.hoisted(() => {
  const handlers = new Map<string, (message: { type: string; payload?: unknown }) => void>();
  return {
    handlers,
    send: vi.fn(),
    openContextEditor: vi.fn(),
    validateContextEditor: vi.fn(),
    applyContextEditor: vi.fn(),
    on: vi.fn((event: string, handler: (message: { type: string; payload?: unknown }) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
  };
});

// Mock the WS client
vi.mock('../../src/lib/ws-client', () => ({
  getWSClient: () => ({
    send: wsMock.send,
    openContextEditor: wsMock.openContextEditor,
    validateContextEditor: wsMock.validateContextEditor,
    applyContextEditor: wsMock.applyContextEditor,
    on: wsMock.on,
    off: wsMock.off,
    withSession: (payload: Record<string, unknown>) => ({ ...payload, sessionId: 'test-session' }),
  }),
}));

// No i18n mock: the real module bundles the English catalog inline and
// initialises on first import, so `t()` resolves synchronously. Asserting on
// rendered English ("Loading context snapshot…") is what the user actually
// sees — a key-returning stub passes even when the key is wrong or missing.

// Mock useChatStore
vi.mock('../../src/stores', () => ({
  useChatStore: Object.assign(
    vi.fn(() => false), // isLoading = false
    { getState: () => ({ isLoading: false }) },
  ),
}));

function loadSnapshot(
  overrides: Partial<Parameters<typeof useContextEditorStore.setState>[0]> = {},
) {
  act(() => {
    useContextEditorStore.setState({
      phase: 'clean_snapshot',
      revision: 'abcdef1234567890',
      messages: [
        { role: 'user', content: 'Hello world' },
        { role: 'assistant', content: 'Hi there' },
      ],
      readonlyContext: {
        systemPromptTokens: 1000,
        toolSchemaTokens: 2000,
        toolCount: 10,
        totalTokens: 4500,
        messageTokens: 1500,
      },
      messageBreakdown: [
        {
          index: 0,
          role: 'user',
          tokens: 500,
          preview: 'Hello world',
          blockCount: null,
          warnings: [],
          pairedAssistantIndices: [1],
        },
        {
          index: 1,
          role: 'assistant',
          tokens: 1000,
          preview: 'Hi there',
          blockCount: null,
          warnings: [],
          pairedAssistantIndices: [],
        },
      ],
      diagnostics: {
        hasToolAdjacencyIssues: false,
        orphanToolUses: [],
        orphanToolResults: [],
        emptyMessages: 0,
        thinkingBlocks: 0,
        signedThinkingBlocks: 0,
      },
      removeMessages: new Set(),
      explicitRemoveMessages: new Set(),
      removeRanges: [],
      validation: null,
      appliedResult: null,
      errorMessage: null,
      ...overrides,
    });
  });
}

describe('ContextWindowEditor', () => {
  beforeEach(() => {
    wsMock.handlers.clear();
    wsMock.send.mockClear();
    wsMock.openContextEditor.mockClear();
    wsMock.validateContextEditor.mockClear();
    wsMock.applyContextEditor.mockClear();
    wsMock.on.mockClear();
    wsMock.off.mockClear();
    useSessionStore.setState({ contextLimitWarning: null });
    // The store now keeps its state PER TAB (B-11). Each test runs against the
    // lane it sets here — `test-session` matches the session id the mocked WS
    // stamp adds to outgoing frames, so the component's own `askedFor` lookup
    // and these `setState` calls land on the same store instance.
    useChatLanes.setState({ lanes: {}, activeSessionId: 'test-session' });
    useContextEditorStore.setState({
      phase: 'closed',
      revision: null,
      messages: [],
      readonlyContext: null,
      messageBreakdown: [],
      diagnostics: null,
      removeMessages: new Set(),
      explicitRemoveMessages: new Set(),
      removeRanges: [],
      validation: null,
      appliedResult: null,
      errorMessage: null,
    });
  });

  afterEach(() => {
    cleanup();
    // Drop the lane allocated for this test so the next one starts from the
    // factory's DEFAULT slot (`__unbound__`) instead of inheriting leftovers.
    disposeLane('test-session');
    useChatLanes.setState({ activeSessionId: DEFAULT_LANE_ID });
  });

  it('renders nothing when closed', () => {
    const { container } = render(<ContextWindowEditor open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders loading state when open with no snapshot', async () => {
    render(<ContextWindowEditor open={true} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(await screen.findByText(/Loading context snapshot/i)).toBeTruthy();
  });

  it('subscribes to the snapshot before requesting it', () => {
    render(<ContextWindowEditor open={true} onClose={vi.fn()} />);
    const onOrder = wsMock.on.mock.invocationCallOrder[0];
    const sendOrder = wsMock.send.mock.invocationCallOrder[0];
    expect(onOrder).toBeDefined();
    expect(sendOrder).toBeDefined();
    expect(onOrder!).toBeLessThan(sendOrder!);
    expect(wsMock.send.mock.calls[0]?.[0]).toEqual({
      type: 'context.editor.open',
      payload: { sessionId: 'test-session' },
    });
  });

  it('loads an empty-history snapshot instead of staying on loading', async () => {
    render(<ContextWindowEditor open={true} onClose={vi.fn()} />);
    expect(await screen.findByText(/Loading context snapshot/i)).toBeTruthy();

    const handler = wsMock.handlers.get('context.editor.snapshot');
    expect(handler).toBeTruthy();
    act(() => {
      handler!({
        type: 'context.editor.snapshot',
        payload: {
          sessionId: 'test-session',
          revision: 'empty-rev',
          messages: [],
          readonlyContext: {
            systemPromptTokens: 800,
            toolSchemaTokens: 1200,
            toolCount: 4,
            totalTokens: 2000,
            messageTokens: 0,
          },
          messageBreakdown: [],
          diagnostics: {
            hasToolAdjacencyIssues: false,
            orphanToolUses: [],
            orphanToolResults: [],
            emptyMessages: 0,
            thinkingBlocks: 0,
            signedThinkingBlocks: 0,
          },
        },
      });
    });

    expect(screen.queryByText(/Loading context snapshot/i)).toBeNull();
    expect(await screen.findByText(/No conversation messages yet/i)).toBeTruthy();
    expect(screen.getByText('2.0k')).toBeTruthy();
  });

  it('ignores a snapshot addressed to another tab', async () => {
    render(<ContextWindowEditor open={true} onClose={vi.fn()} />);
    expect(await screen.findByText(/Loading context snapshot/i)).toBeTruthy();

    const handler = wsMock.handlers.get('context.editor.snapshot');
    act(() => {
      handler!({
        type: 'context.editor.snapshot',
        payload: {
          sessionId: 'other-tab',
          revision: 'foreign-rev',
          messages: [{ role: 'user', content: 'from another tab' }],
          readonlyContext: {
            systemPromptTokens: 1,
            toolSchemaTokens: 1,
            toolCount: 0,
            totalTokens: 2,
            messageTokens: 0,
          },
          messageBreakdown: [
            {
              index: 0,
              role: 'user',
              tokens: 1,
              preview: 'from another tab',
              blockCount: null,
              warnings: [],
              pairedAssistantIndices: [],
            },
          ],
          diagnostics: {
            hasToolAdjacencyIssues: false,
            orphanToolUses: [],
            orphanToolResults: [],
            emptyMessages: 0,
            thinkingBlocks: 0,
            signedThinkingBlocks: 0,
          },
        },
      });
    });

    expect(screen.getByText(/Loading context snapshot/i)).toBeTruthy();
    expect(screen.queryByText('from another tab')).toBeNull();
  });

  it('shows a live provider context-limit decrease in the editor', async () => {
    useSessionStore.setState({
      contextLimitWarning: {
        providerId: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        previousMaxContext: 1_050_000,
        maxContext: 272_000,
      },
    });
    render(<ContextWindowEditor open={true} onClose={vi.fn()} />);
    loadSnapshot();

    expect(await screen.findByText(/Provider context window decreased/i)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('272.0k');
  });

  it('renders message list after snapshot loads', async () => {
    const { rerender } = render(<ContextWindowEditor open={true} onClose={vi.fn()} />);

    // Simulate the WS snapshot arriving
    loadSnapshot();

    // Re-render so the component picks up the store change
    rerender(<ContextWindowEditor open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Hello world')).toBeTruthy();
    });
    expect(screen.getByText('Hi there')).toBeTruthy();
  });

  it('reveals the range-removal action after keyboard text selection', async () => {
    const { rerender } = render(<ContextWindowEditor open={true} onClose={vi.fn()} />);
    loadSnapshot({
      messages: [{ role: 'user', content: 'Select with keyboard' }],
      messageBreakdown: [
        {
          index: 0,
          role: 'user',
          tokens: 100,
          preview: 'Select with keyboard',
          blockCount: null,
          warnings: [],
        },
      ],
    });
    rerender(<ContextWindowEditor open={true} onClose={vi.fn()} />);

    const content = await screen.findByText('Select with keyboard');
    const textNode = content.firstChild;
    expect(textNode).not.toBeNull();
    if (!textNode) throw new Error('Expected selectable text content');
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.keyUp(content, { key: 'Shift' });

    const markRangeButton = await screen.findByText('Mark for removal', { selector: 'button' });
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    markRangeButton.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);

    fireEvent.click(markRangeButton);
    expect(useContextEditorStore.getState().removeRanges).toEqual([
      { messageIndex: 0, start: 0, end: 6 },
    ]);
  });

  it('clears the Mark for removal button when message text changes via loadSnapshot', async () => {
    const { rerender } = render(<ContextWindowEditor open={true} onClose={vi.fn()} />);
    loadSnapshot({
      messages: [{ role: 'user', content: 'Select with keyboard' }],
      messageBreakdown: [
        {
          index: 0,
          role: 'user',
          tokens: 100,
          preview: 'Select with keyboard',
          blockCount: null,
          warnings: [],
        },
      ],
    });
    rerender(<ContextWindowEditor open={true} onClose={vi.fn()} />);

    const content = await screen.findByText('Select with keyboard');
    const textNode = content.firstChild;
    if (!textNode) throw new Error('Expected selectable text content');
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.keyUp(content, { key: 'Shift' });

    expect(await screen.findByText('Mark for removal', { selector: 'button' })).toBeTruthy();

    // Simulate a server snapshot refresh with different text content.
    // This triggers the [text] useEffect that clears stale selection state.
    loadSnapshot({
      messages: [{ role: 'user', content: 'Updated content after edit' }],
      messageBreakdown: [
        {
          index: 0,
          role: 'user',
          tokens: 80,
          preview: 'Updated content after edit',
          blockCount: null,
          warnings: [],
        },
      ],
    });
    rerender(<ContextWindowEditor open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText('Mark for removal', { selector: 'button' })).toBeNull();
    });
  });

  it('marks a message for removal when toggled', async () => {
    const { rerender } = render(<ContextWindowEditor open={true} onClose={vi.fn()} />);

    // Simulate the WS snapshot arriving after mount
    loadSnapshot({
      messages: [{ role: 'user', content: 'Remove me' }],
      messageBreakdown: [
        {
          index: 0,
          role: 'user',
          tokens: 200,
          preview: 'Remove me',
          blockCount: null,
          warnings: [],
        },
      ],
    });

    rerender(<ContextWindowEditor open={true} onClose={vi.fn()} />);

    // Wait for message rows to appear, then find the toggle button
    await waitFor(() => {
      expect(screen.getByText('Remove me')).toBeTruthy();
    });

    const markButton = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-label') === 'Mark for removal');
    expect(markButton).toBeTruthy();
    fireEvent.click(markButton!);

    expect(useContextEditorStore.getState().removeMessages.has(0)).toBe(true);
    expect(useContextEditorStore.getState().phase).toBe('dirty');
  });

  it('shows close button that calls onClose', () => {
    const onClose = vi.fn();
    render(<ContextWindowEditor open={true} onClose={onClose} />);

    const closeBtn = screen.getByRole('button', { name: /close/i });
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('getProposedMessages excludes removed messages', () => {
    useContextEditorStore.setState({
      phase: 'dirty',
      revision: 'abc',
      messages: [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
      ],
      readonlyContext: null,
      messageBreakdown: [],
      diagnostics: null,
      removeMessages: new Set([0, 2]),
      explicitRemoveMessages: new Set([0, 2]),
      validation: null,
      appliedResult: null,
      errorMessage: null,
    });

    const proposed = useContextEditorStore.getState().getProposedMessages();
    expect(proposed).toHaveLength(1);
    expect(proposed[0].content).toBe('msg2');
  });

  it('keeps an auto-paired assistant removed while its user range remains active', () => {
    useContextEditorStore.setState({
      phase: 'dirty',
      revision: 'abc',
      messages: [
        { role: 'user', content: 'remove secret' },
        { role: 'assistant', content: 'reply' },
      ],
      readonlyContext: null,
      messageBreakdown: [],
      diagnostics: null,
      removeMessages: new Set([1]),
      explicitRemoveMessages: new Set(),
      removeRanges: [{ messageIndex: 0, start: 7, end: 13 }],
      validation: null,
      appliedResult: null,
      errorMessage: null,
    });

    useContextEditorStore.getState().toggleRemoveMessage(1);

    expect(useContextEditorStore.getState().removeMessages.has(1)).toBe(true);
    expect(useContextEditorStore.getState().removeRanges).toEqual([
      { messageIndex: 0, start: 7, end: 13 },
    ]);
  });

  it('preserves an explicitly selected assistant when its paired user is unmarked', () => {
    useContextEditorStore.setState({
      phase: 'clean_snapshot',
      revision: 'abc',
      messages: [
        { role: 'user', content: 'request' },
        { role: 'assistant', content: 'response' },
      ],
      readonlyContext: null,
      messageBreakdown: [],
      diagnostics: null,
      removeMessages: new Set(),
      explicitRemoveMessages: new Set(),
      removeRanges: [],
      validation: null,
      appliedResult: null,
      errorMessage: null,
    });

    useContextEditorStore.getState().toggleRemoveMessage(1);
    useContextEditorStore.getState().toggleRemoveMessage(0);
    useContextEditorStore.getState().toggleRemoveMessage(0);

    expect(useContextEditorStore.getState().removeMessages).toEqual(new Set([1]));
    expect(useContextEditorStore.getState().explicitRemoveMessages).toEqual(new Set([1]));
  });

  it('uses server-provided assistant pairing metadata', () => {
    useContextEditorStore.setState({
      phase: 'clean_snapshot',
      revision: 'abc',
      messages: [
        { role: 'user', content: 'request' },
        { role: 'assistant', content: 'first response' },
        { role: 'assistant', content: 'server-paired response' },
      ],
      readonlyContext: null,
      messageBreakdown: [
        {
          index: 0,
          role: 'user',
          tokens: 1,
          preview: 'request',
          blockCount: null,
          warnings: [],
          pairedAssistantIndices: [2],
        },
      ],
      diagnostics: null,
      removeMessages: new Set(),
      explicitRemoveMessages: new Set(),
      removeRanges: [],
      validation: null,
      appliedResult: null,
      errorMessage: null,
    });

    useContextEditorStore.getState().toggleRemoveMessage(0);

    expect(useContextEditorStore.getState().removeMessages).toEqual(new Set([0, 2]));
  });

  it('preserves explicit assistant selection while it is required by a paired user', () => {
    loadSnapshot();

    useContextEditorStore.getState().toggleRemoveMessage(1);
    useContextEditorStore.getState().toggleRemoveMessage(0);
    useContextEditorStore.getState().toggleRemoveMessage(1);
    useContextEditorStore.getState().toggleRemoveMessage(0);

    expect(useContextEditorStore.getState().removeMessages).toEqual(new Set([1]));
    expect(useContextEditorStore.getState().explicitRemoveMessages).toEqual(new Set([1]));
  });

  it('preserves granular ranges across whole-message toggle cycles', () => {
    loadSnapshot();
    useContextEditorStore.getState().markRangeForRemoval({ messageIndex: 0, start: 0, end: 5 });

    useContextEditorStore.getState().toggleRemoveMessage(0);
    expect(useContextEditorStore.getState().removeMessages.has(0)).toBe(true);
    expect(useContextEditorStore.getState().removeRanges).toEqual([
      { messageIndex: 0, start: 0, end: 5 },
    ]);

    useContextEditorStore.getState().toggleRemoveMessage(0);
    expect(useContextEditorStore.getState().removeMessages.has(0)).toBe(false);
    expect(useContextEditorStore.getState().removeRanges).toEqual([
      { messageIndex: 0, start: 0, end: 5 },
    ]);
  });

  it('rejects granular ranges that split a Unicode surrogate pair', () => {
    loadSnapshot({
      messages: [{ role: 'assistant', content: 'A😀B' }],
      messageBreakdown: [
        {
          index: 0,
          role: 'assistant',
          tokens: 2,
          preview: 'A😀B',
          blockCount: null,
          warnings: [],
          pairedAssistantIndices: [],
        },
      ],
    });

    useContextEditorStore.getState().markRangeForRemoval({ messageIndex: 0, start: 2, end: 3 });

    expect(useContextEditorStore.getState().removeRanges).toEqual([]);
    expect(useContextEditorStore.getState().phase).toBe('clean_snapshot');
  });

  it('ignores new granular ranges while a whole-message removal is active', () => {
    loadSnapshot();
    useContextEditorStore.getState().toggleRemoveMessage(0);

    useContextEditorStore.getState().markRangeForRemoval({ messageIndex: 0, start: 0, end: 5 });

    expect(useContextEditorStore.getState().removeRanges).toEqual([]);
  });

  it('enters validating and applying phases explicitly', () => {
    loadSnapshot();
    useContextEditorStore.getState().toggleRemoveMessage(1);

    useContextEditorStore.getState().beginValidation();
    expect(useContextEditorStore.getState().phase).toBe('validating');
    expect(useContextEditorStore.getState().validation).toBeNull();

    useContextEditorStore.getState().beginApply();
    expect(useContextEditorStore.getState().phase).toBe('applying');
  });

  it('blocks removal mutations while validation or apply is in flight', () => {
    loadSnapshot();
    useContextEditorStore.getState().beginValidation();

    useContextEditorStore.getState().toggleRemoveMessage(0);
    useContextEditorStore.getState().markRangeForRemoval({ messageIndex: 0, start: 0, end: 5 });
    expect(useContextEditorStore.getState().removeMessages).toEqual(new Set());
    expect(useContextEditorStore.getState().removeRanges).toEqual([]);
    expect(useContextEditorStore.getState().phase).toBe('validating');

    useContextEditorStore.getState().beginApply();
    useContextEditorStore.getState().toggleRemoveMessage(0);
    useContextEditorStore.getState().markRangeForRemoval({ messageIndex: 0, start: 0, end: 5 });
    expect(useContextEditorStore.getState().removeMessages).toEqual(new Set());
    expect(useContextEditorStore.getState().removeRanges).toEqual([]);
    expect(useContextEditorStore.getState().phase).toBe('applying');
  });

  it('rejects ranges that do not target current text content', () => {
    loadSnapshot();

    useContextEditorStore.getState().markRangeForRemoval({ messageIndex: 0, start: 0, end: 999 });
    useContextEditorStore.getState().markRangeForRemoval({ messageIndex: 99, start: 0, end: 1 });

    expect(useContextEditorStore.getState().removeRanges).toEqual([]);
    expect(useContextEditorStore.getState().phase).toBe('clean_snapshot');
  });

  it('refreshes the snapshot after an applied response', () => {
    render(<ContextWindowEditor open={true} onClose={vi.fn()} />);
    const appliedHandler = wsMock.handlers.get('context.editor.applied');
    expect(appliedHandler).toBeDefined();

    act(() => {
      appliedHandler?.({
        type: 'context.editor.applied',
        payload: {
          before: { messages: 2, blocks: 0, messageTokens: 2, fullRequestTokens: 2 },
          after: { messages: 1, blocks: 0, messageTokens: 1, fullRequestTokens: 1 },
          removed: {
            messages: 1,
            blocks: 0,
            toolUses: [],
            toolResults: [],
            emptyMessages: 0,
          },
          warnings: [],
        },
      });
    });

    expect(wsMock.openContextEditor).toHaveBeenCalledTimes(1);
    expect(useContextEditorStore.getState().phase).toBe('applied_success');

    act(() => {
      useContextEditorStore.getState().loadSnapshot({
        revision: 'fresh-revision',
        messages: [{ role: 'user', content: 'remaining message' }],
        readonlyContext: {
          systemPromptTokens: 1,
          toolSchemaTokens: 1,
          toolCount: 1,
          totalTokens: 3,
          messageTokens: 1,
        },
        messageBreakdown: [],
        diagnostics: {
          hasToolAdjacencyIssues: false,
          orphanToolUses: [],
          orphanToolResults: [],
          emptyMessages: 0,
          thinkingBlocks: 0,
          signedThinkingBlocks: 0,
        },
      });
    });

    expect(useContextEditorStore.getState().revision).toBe('fresh-revision');
    expect(useContextEditorStore.getState().phase).toBe('applied_success');
    expect(useContextEditorStore.getState().appliedResult).not.toBeNull();
  });

  it('toggles removal on and off through the store', () => {
    useContextEditorStore.setState({
      phase: 'clean_snapshot',
      revision: 'abc',
      messages: [{ role: 'user', content: 'test' }],
      readonlyContext: null,
      messageBreakdown: [],
      diagnostics: null,
      removeMessages: new Set(),
      explicitRemoveMessages: new Set(),
      removeRanges: [],
      validation: null,
      appliedResult: null,
      errorMessage: null,
    });

    // Toggle on
    useContextEditorStore.getState().toggleRemoveMessage(0);
    expect(useContextEditorStore.getState().removeMessages.has(0)).toBe(true);
    expect(useContextEditorStore.getState().phase).toBe('dirty');

    // Toggle off
    useContextEditorStore.getState().toggleRemoveMessage(0);
    expect(useContextEditorStore.getState().removeMessages.has(0)).toBe(false);
    expect(useContextEditorStore.getState().phase).toBe('clean_snapshot');
  });

  it('clears removals and returns to clean state', () => {
    useContextEditorStore.setState({
      phase: 'dirty',
      revision: 'abc',
      messages: [{ role: 'user', content: 'test' }],
      readonlyContext: null,
      messageBreakdown: [],
      diagnostics: null,
      removeMessages: new Set([0]),
      explicitRemoveMessages: new Set([0]),
      validation: null,
      appliedResult: null,
      errorMessage: null,
    });

    useContextEditorStore.getState().clearRemovals();
    expect(useContextEditorStore.getState().removeMessages.size).toBe(0);
    expect(useContextEditorStore.getState().phase).toBe('clean_snapshot');
  });

  describe('B-11 per-tab isolation', () => {
    /**
     * The store used to be a single zustand object shared by every tab. The
     * editor overlay was also a single surface, so opening it in tab A, marking
     * two messages for removal, switching to tab B and back, threw away the
     * pending selections — tab A came back to an empty, refetched overlay.
     *
     * Both overlays and both stores now belong to the lane that mounted them.
     * These tests pin the contract end-to-end: the simulated WS answers each
     * tab's snapshot request with its own revision, and tab A's pending
     * removals survive tab B answering first.
     */
    beforeEach(() => {
      // The default lane is `test-session`, set by the outer beforeEach. Reset
      // it after each sub-test so a leak can't poison the next one.
      afterEach(() => {
        disposeLane('tab-a');
        disposeLane('tab-b');
      });
    });

    it('keeps two tabs apart when each holds its own snapshot', () => {
      // Tab A: snapshot loaded, one removal marked.
      useContextEditorStore.for('tab-a').setState({
        phase: 'dirty',
        revision: 'rev-a',
        messages: [{ role: 'user', content: 'A' }],
        readonlyContext: null,
        messageBreakdown: [],
        diagnostics: null,
        removeMessages: new Set([0]),
        explicitRemoveMessages: new Set([0]),
        removeRanges: [],
        validation: null,
        appliedResult: null,
        errorMessage: null,
      });
      // Tab B: different snapshot, different removal, different revision.
      useContextEditorStore.for('tab-b').setState({
        phase: 'dirty',
        revision: 'rev-b',
        messages: [{ role: 'user', content: 'B' }],
        readonlyContext: null,
        messageBreakdown: [],
        diagnostics: null,
        removeMessages: new Set([0]),
        explicitRemoveMessages: new Set([0]),
        removeRanges: [],
        validation: null,
        appliedResult: null,
        errorMessage: null,
      });

      expect(useContextEditorStore.for('tab-a').getState().revision).toBe('rev-a');
      expect(useContextEditorStore.for('tab-b').getState().revision).toBe('rev-b');
      // The singletons (`getState` / `setState`) address the lane currently in
      // front, so checking them through .for() is what verifies the lanes
      // really are separate instances rather than aliases of one shared store.
      expect(useContextEditorStore.for('tab-a').getState()).not.toBe(
        useContextEditorStore.for('tab-b').getState(),
      );
    });

    it('does not refetch a lane that already holds a snapshot', () => {
      // The store's hook form subscribes to the lane pointer, so a render with
      // an active lane that already has data must not trigger a fresh request
      // the way `open()` used to: the reducer cleared the removals on every
      // call. The action remains, but a lane that already passed
      // `clean_snapshot` should still hold its messages.
      const lane = useContextEditorStore.for('tab-a');
      lane.setState({
        phase: 'clean_snapshot',
        revision: 'rev-keep',
        messages: [{ role: 'user', content: 'stays' }],
        readonlyContext: null,
        messageBreakdown: [],
        diagnostics: null,
        removeMessages: new Set(),
        explicitRemoveMessages: new Set(),
        removeRanges: [],
        validation: null,
        appliedResult: null,
        errorMessage: null,
      });

      expect(lane.getState().messages[0]?.content).toBe('stays');
      expect(lane.getState().revision).toBe('rev-keep');
    });

    it('keeps every per-tab WS round-trip on its own lane even when interleaved', () => {
      const a = useContextEditorStore.for('tab-a');
      const b = useContextEditorStore.for('tab-b');

      // Pretend each tab asked for its own snapshot — `applyOpen` clears
      // state, then `loadSnapshot` is called by the WS handler.
      a.getState().open();
      b.getState().open();

      // Interleave: B's snapshot arrives first while A is still loading.
      b.getState().loadSnapshot({
        revision: 'rev-b',
        messages: [{ role: 'user', content: 'B first' }],
        readonlyContext: {
          systemPromptTokens: 1,
          toolSchemaTokens: 1,
          toolCount: 0,
          totalTokens: 2,
          messageTokens: 0,
        },
        messageBreakdown: [],
        diagnostics: {
          hasToolAdjacencyIssues: false,
          orphanToolUses: [],
          orphanToolResults: [],
          emptyMessages: 0,
          thinkingBlocks: 0,
          signedThinkingBlocks: 0,
        },
      });

      // B is settled, A is still loading — they must not have been merged.
      expect(b.getState().phase).toBe('clean_snapshot');
      expect(b.getState().messages[0]?.content).toBe('B first');
      expect(a.getState().phase).toBe('loading_snapshot');
      expect(a.getState().messages).toEqual([]);

      // A's snapshot finally lands.
      a.getState().loadSnapshot({
        revision: 'rev-a',
        messages: [{ role: 'user', content: 'A second' }],
        readonlyContext: b.getState().readonlyContext!,
        messageBreakdown: [],
        diagnostics: {
          hasToolAdjacencyIssues: false,
          orphanToolUses: [],
          orphanToolResults: [],
          emptyMessages: 0,
          thinkingBlocks: 0,
          signedThinkingBlocks: 0,
        },
      });
      expect(a.getState().phase).toBe('clean_snapshot');
      expect(a.getState().revision).toBe('rev-a');
      // B should still hold B's snapshot — the second loadSnapshot must not
      // have swept it.
      expect(b.getState().messages[0]?.content).toBe('B first');
    });

    it('drops both lanes when the tabs close (onLaneDisposed)', () => {
      const a = useContextEditorStore.for('tab-a');
      a.setState({ phase: 'clean_snapshot', revision: 'rev-a' });
      expect(useContextEditorStore.sessionIds()).toContain('tab-a');

      disposeLane('tab-a');
      expect(useContextEditorStore.sessionIds()).not.toContain('tab-a');
    });
  });
});
