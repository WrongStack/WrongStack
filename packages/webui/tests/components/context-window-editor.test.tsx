import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { ContextWindowEditor } from '../../src/components/context-editor/ContextWindowEditor';
import { useContextEditorStore } from '../../src/stores/context-editor-store';

// Mock the WS client
vi.mock('../../src/lib/ws-client', () => ({
  getWSClient: () => ({
    send: vi.fn(),
    on: vi.fn(() => vi.fn()), // returns unsubscribe
    off: vi.fn(),
    withSession: (payload: Record<string, unknown>) => ({ ...payload, sessionId: 'test-session' }),
  }),
}));

// Mock i18n
vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
  i18n: { t: (key: string) => key },
}));

// Mock useChatStore
vi.mock('../../src/stores', () => ({
  useChatStore: Object.assign(
    vi.fn(() => false), // isLoading = false
    { getState: () => ({ isLoading: false }) },
  ),
}));

function loadSnapshot(overrides: Partial<Parameters<typeof useContextEditorStore.setState>[0]> = {}) {
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
        { index: 0, role: 'user', tokens: 500, preview: 'Hello world', blockCount: null, warnings: [] },
        { index: 1, role: 'assistant', tokens: 1000, preview: 'Hi there', blockCount: null, warnings: [] },
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
      validation: null,
      appliedResult: null,
      errorMessage: null,
      ...overrides,
    });
  });
}

describe('ContextWindowEditor', () => {
  beforeEach(() => {
    useContextEditorStore.setState({
      phase: 'closed',
      revision: null,
      messages: [],
      readonlyContext: null,
      messageBreakdown: [],
      diagnostics: null,
      removeMessages: new Set(),
      validation: null,
      appliedResult: null,
      errorMessage: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <ContextWindowEditor open={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders loading state when open with no snapshot', () => {
    render(<ContextWindowEditor open={true} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/Loading context snapshot/i)).toBeTruthy();
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

  it('marks a message for removal when toggled', async () => {
    const { rerender } = render(<ContextWindowEditor open={true} onClose={vi.fn()} />);

    // Simulate the WS snapshot arriving after mount
    loadSnapshot({
      messages: [{ role: 'user', content: 'Remove me' }],
      messageBreakdown: [
        { index: 0, role: 'user', tokens: 200, preview: 'Remove me', blockCount: null, warnings: [] },
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
      validation: null,
      appliedResult: null,
      errorMessage: null,
    });

    const proposed = useContextEditorStore.getState().getProposedMessages();
    expect(proposed).toHaveLength(1);
    expect(proposed[0].content).toBe('msg2');
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
      validation: null,
      appliedResult: null,
      errorMessage: null,
    });

    useContextEditorStore.getState().clearRemovals();
    expect(useContextEditorStore.getState().removeMessages.size).toBe(0);
    expect(useContextEditorStore.getState().phase).toBe('clean_snapshot');
  });
});
