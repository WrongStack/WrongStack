import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDetailSection } from '../../src/components/agents/AgentDetailSection.js';
import {
  AgentTabs,
  shouldAutoClearSubagentFocus,
} from '../../src/components/ChatView/AgentTabs.js';
import { SubagentTranscriptView } from '../../src/components/ChatView/SubagentTranscriptView.js';
import { taskBriefPreview } from '../../src/lib/task-brief-preview.js';
import type { AgentTranscriptEntry, SubagentView } from '../../src/stores/index.js';
import { useChatStore, useFleetStore, useUIStore } from '../../src/stores/index.js';
import { SESSION_DEFAULT_LANE_ID, useSessionLanes } from '../../src/stores/session-lanes.js';

const mockSendAbort = vi.fn();
vi.mock('../../src/lib/ws-client.js', () => ({
  getWSClient: () => ({
    sendAbort: mockSendAbort,
  }),
}));

function makeAgent(id: string, overrides: Partial<{ name: string; status: string }> = {}) {
  return {
    id,
    name: overrides.name ?? id,
    status: overrides.status ?? 'running',
    iteration: 0,
    toolCalls: 0,
    costUsd: 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
    extensions: 0,
    startedAt: Date.now(),
    toolLog: [],
    sparklineBins: Array(12).fill(0),
  } as SubagentView;
}

function entry(
  partial: Partial<AgentTranscriptEntry> & { kind: AgentTranscriptEntry['kind'] },
): AgentTranscriptEntry {
  return {
    id: `e_${Math.random().toString(36).slice(2, 8)}`,
    subagentId: 's1',
    agentName: 'Alpha',
    content: partial.content ?? '',
    kind: partial.kind,
    iteration: partial.iteration ?? 1,
    ts: new Date().toISOString(),
    toolName: partial.toolName,
    toolOk: partial.toolOk,
  };
}

/**
 * AgentTabs ↔ ui-store focus wiring and the read-only subagent transcript.
 *
 * Acceptance anchors:
 * - Tab strip lists the leader once plus each subagent; clicking moves
 *   `subagentChatFocusId` (null = leader).
 * - The strip disappears when there is nothing to switch between.
 * - SubagentTranscriptView renders every entry kind and contains NO form
 *   controls — subagent history is strictly read-only (ChatView hides the
 *   input area entirely in this mode).
 */
describe('subagent chat tabs', () => {
  beforeEach(async () => {
    // Pre-warm the lazy markdown chunk (LazyMarkdown = React.lazy(() =>
    // import('react-markdown'))). Without this any text entry renders empty
    // until the chunk loads, and under full-suite worker contention that can
    // exceed waitFor's 1s default. Keep this — the component is otherwise
    // correct; pre-warming makes the render deterministic.
    await import('react-markdown');
    useFleetStore.setState({
      agents: new Map(),
      agentTranscripts: new Map(),
      leaderId: undefined,
      eventTimeline: [],
      agentTimeline: [],
    });
    useSessionLanes.setState({ activeSessionId: SESSION_DEFAULT_LANE_ID, lanes: {} });
    useUIStore.setState({ subagentChatFocusId: null });
  });

  afterEach(() => cleanup());

  it('lists leader + subagents and routes clicks through subagentChatFocusId', () => {
    const agents = new Map([
      ['ldr', makeAgent('ldr', { name: 'Main' })],
      ['s1', makeAgent('s1', { name: 'Alpha' })],
      ['s2', makeAgent('s2', { name: 'Beta' })],
    ]);
    useFleetStore.setState({ agents, leaderId: 'ldr' });

    render(<AgentTabs />);

    // Leader appears exactly once even though it is also in the roster.
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(3);

    fireEvent.click(screen.getByRole('tab', { name: /Beta/ }));
    expect(useUIStore.getState().subagentChatFocusId).toBe('s2');
    expect(useUIStore.getState().currentView).toBe('chat');

    // First tab is the leader — selecting it returns to the normal chat.
    fireEvent.click(screen.getAllByRole('tab')[0]!);
    expect(useUIStore.getState().subagentChatFocusId).toBeNull();

    // Active state follows the focus field.
    act(() => {
      useUIStore.setState({ subagentChatFocusId: 's1' });
    });
    expect(screen.getByRole('tab', { name: /Alpha/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('renders Stop button in summary pill when isLoading is true and clicks sendAbort', () => {
    mockSendAbort.mockClear();
    const agents = new Map([
      ['ldr', makeAgent('ldr', { name: 'Main' })],
      ['s1', makeAgent('s1', { name: 'Alpha' })],
    ]);
    useFleetStore.setState({ agents, leaderId: 'ldr' });
    useChatStore.setState({ isLoading: true });

    render(<AgentTabs />);

    const stopBtn = screen.getByRole('button', { name: /abort|stop/i });
    expect(stopBtn).toBeDefined();

    fireEvent.click(stopBtn);
    expect(mockSendAbort).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().isLoading).toBe(false);
  });

  it('does not throw when a subagent has a non-canonical status', () => {
    const agents = new Map([
      ['ldr', makeAgent('ldr', { name: 'Main' })],
      ['s1', makeAgent('s1', { name: 'Alpha', status: 'cancelled' })],
    ]);
    useFleetStore.setState({ agents, leaderId: 'ldr' });
    expect(() => render(<AgentTabs />)).not.toThrow();
    expect(screen.getByRole('tab', { name: /Alpha/ })).toBeTruthy();
  });

  it('clips a long subagent description on the tab tooltip', () => {
    const longTask = 'Review the session.\n'.repeat(80);
    const agents = new Map([
      ['ldr', makeAgent('ldr', { name: 'Main' })],
      ['s1', { ...makeAgent('s1', { name: 'Alpha' }), description: longTask }],
    ]);
    useFleetStore.setState({ agents, leaderId: 'ldr' });

    render(<AgentTabs />);
    const tab = screen.getByRole('tab', { name: /Alpha/ });
    expect(tab.getAttribute('title')).toBe(taskBriefPreview(longTask, 180));
    expect((tab.getAttribute('title') ?? '').length).toBeLessThan(200);
  });

  it('keeps the AGENTS strip visible when only the leader exists', () => {
    const agents = new Map([['ldr', makeAgent('ldr', { name: 'Solo' })]]);
    useFleetStore.setState({ agents, leaderId: 'ldr' });

    render(<AgentTabs />);
    expect(screen.getByRole('tablist', { name: /Switch agent view/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Solo/ })).toBeTruthy();
    expect(screen.getByText('AGENTS')).toBeTruthy();
  });

  it('renders the full transcript chat-style with no input controls', async () => {
    const agents = new Map([['s1', makeAgent('s1', { name: 'Alpha' })]]);
    const entries = [
      entry({ kind: 'text', content: 'Final answer with **markdown**' }),
      entry({ kind: 'thinking', content: 'pondering the task deeply' }),
      entry({ kind: 'tool_use', content: '{"path":"a.ts"}', toolName: 'read_file' }),
      entry({
        kind: 'tool_result',
        content: 'file body',
        toolName: 'read_file',
        toolOk: true,
      }),
      entry({ kind: 'error', content: 'provider exploded' }),
      entry({ kind: 'status', content: 'iteration 3 complete' }),
    ];
    useFleetStore.setState({
      agents,
      agentTranscripts: new Map([['s1', entries]]),
    });

    render(<SubagentTranscriptView agentId="s1" />);
    const root = screen.getByTestId('subagent-transcript-view');

    // Read-only contract: the subagent pane must never contain an editor.
    expect(root.querySelector('textarea')).toBeNull();
    expect(root.querySelector('input')).toBeNull();

    // Every entry kind made it into the log.
    await waitFor(() => expect(root.textContent).toContain('Final answer'));
    expect(root.textContent).toContain('pondering the task deeply');
    expect(root.textContent).toContain('"path":"a.ts"}');
    expect(root.textContent).toContain('file body');
    expect(root.textContent).toContain('provider exploded');
    expect(root.textContent).toContain('iteration 3 complete');
  });

  it('shows the empty state for an agent without history', () => {
    const agents = new Map([['s1', makeAgent('s1', { name: 'Alpha' })]]);
    useFleetStore.setState({ agents });

    render(<SubagentTranscriptView agentId="s1" />);
    const root = screen.getByTestId('subagent-transcript-view');
    expect(root.querySelector('textarea')).toBeNull();
    expect(root.querySelector('input')).toBeNull();
  });

  it('collapses a long task brief to one line and expands it in a modal', async () => {
    const longTask = `Review the session diff.\nScope: everything.\nOut of scope: nothing.`.repeat(
      40,
    );
    const agents = new Map([
      ['s1', { ...makeAgent('s1', { name: 'Alpha' }), description: longTask }],
    ]);
    useFleetStore.setState({ agents });

    render(<SubagentTranscriptView agentId="s1" />);
    const root = screen.getByTestId('subagent-transcript-view');
    const preview = screen.getByTestId('subagent-task-preview');

    // Compact contract: the pin holds a short one-line preview, never the
    // full multi-KB brief. The complete text lives behind the modal.
    expect(preview.textContent).toBe(taskBriefPreview(longTask));
    expect(preview.textContent!.length).toBeLessThan(160);
    expect(root.textContent).not.toContain(longTask);
    expect(root.querySelector('[data-testid="subagent-task-strip"]')?.className).toContain(
      'max-h-8',
    );

    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show full task brief/i }));
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByTestId('subagent-task-full').textContent).toBe(longTask);
    expect(dialog.textContent).toContain('Review the session diff.');
  });

  it('taskBriefPreview collapses whitespace and clips long briefs', () => {
    expect(taskBriefPreview('short')).toBe('short');
    expect(taskBriefPreview('line one\n\nline two', 20)).toBe('line one line two');
    const clipped = taskBriefPreview('alpha beta gamma delta', 12);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped.length).toBeLessThanOrEqual(13);
    expect(clipped.startsWith('alpha')).toBe(true);
  });

  it('renders no task preview when the agent has no description', () => {
    const agents = new Map([['s1', makeAgent('s1', { name: 'Alpha' })]]);
    useFleetStore.setState({ agents });

    render(<SubagentTranscriptView agentId="s1" />);
    expect(screen.queryByTestId('subagent-task-preview')).toBeNull();
    expect(screen.queryByRole('button', { name: /show full task brief/i })).toBeNull();
  });

  it('returns focus to the leader chat from the compact header', () => {
    const agents = new Map([['s1', makeAgent('s1', { name: 'Alpha' })]]);
    useFleetStore.setState({ agents });
    useUIStore.setState({ subagentChatFocusId: 's1' });

    render(<SubagentTranscriptView agentId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /return to chat/i }));
    expect(useUIStore.getState().subagentChatFocusId).toBeNull();
  });
});

/**
 * ChatView consumes this predicate in its stale-focus effect: a focused
 * subagent id may only survive while the agent still exists in the fleet
 * roster (removed / clear-finished / session stop must fall back to the
 * leader chat instead of rendering a dead pane).
 */
describe('shouldAutoClearSubagentFocus', () => {
  it('clears only when a focused id no longer exists in the roster', () => {
    expect(shouldAutoClearSubagentFocus('s1', true)).toBe(false);
    expect(shouldAutoClearSubagentFocus('s1', false)).toBe(true);
    expect(shouldAutoClearSubagentFocus(null, false)).toBe(false);
    expect(shouldAutoClearSubagentFocus(null, true)).toBe(false);
  });
});

/**
 * The leader lives INSIDE the roster map, so its own detail card also
 * renders an "Open chat" action — but focusing the leader id would swap
 * the main pane for the leader's fleet-event transcript and hide the
 * input. The guard must ignore the leader and focus only real subagents.
 */
describe('AgentDetailSection quick-open', () => {
  beforeEach(() => {
    useFleetStore.setState({ agents: new Map(), leaderId: undefined });
    useUIStore.setState({ subagentChatFocusId: null });
  });

  it('ignores open-chat on the leader card', () => {
    const agents = new Map([['ldr', makeAgent('ldr', { name: 'Main' })]]);
    useFleetStore.setState({ agents, leaderId: 'ldr' });

    render(<AgentDetailSection agent={makeAgent('ldr', { name: 'Main' })} isExpanded />);
    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));

    expect(useUIStore.getState().subagentChatFocusId).toBeNull();
  });

  it('focuses a real subagent and jumps to the chat view', () => {
    const agents = new Map([['s1', makeAgent('s1', { name: 'Alpha' })]]);
    useFleetStore.setState({ agents });

    render(<AgentDetailSection agent={makeAgent('s1', { name: 'Alpha' })} isExpanded />);
    fireEvent.click(screen.getByRole('button', { name: /open chat/i }));

    expect(useUIStore.getState().subagentChatFocusId).toBe('s1');
    expect(useUIStore.getState().currentView).toBe('chat');
  });
});
