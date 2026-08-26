import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the external seams the component touches ──────────────────────────
// `sendRosterMessage` is the single WS round-trip helper. `loadConsolidated`
// (the unit under test) is an internal useCallback whose only observable effect
// is a `sendRosterMessage('agent-roster.read-consolidated', { role })` call, so
// we assert against this mock. `vi.hoisted` makes the spy available inside the
// hoisted `vi.mock` factory.
const { sendRosterMessage } = vi.hoisted(() => ({ sendRosterMessage: vi.fn() }));

vi.mock('@/lib/roster-ws', () => ({
  sendRosterMessage: (...args: unknown[]) => sendRosterMessage(...args),
}));

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    on: () => () => {},
    sendMessage: () => {},
  }),
}));

vi.mock('@/components/Toaster', () => ({
  toast: { success: () => {}, error: () => {}, info: () => {} },
}));

// Stores are used as selector hooks and via `.getState()`; provide inert stubs.
// The factory is self-contained (no top-level references) to satisfy hoisting.
vi.mock('@/stores', () => {
  const makeStore = (state: Record<string, unknown>) => {
    const fn = (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(state) : state;
    (fn as unknown as { getState: () => Record<string, unknown> }).getState = () => state;
    return fn;
  };
  return {
    useFleetStore: makeStore({ agents: [], leaderId: null, clearFinishedAgents: () => {} }),
    useUIStore: makeStore({ setSidebarOpen: () => {}, setCurrentView: () => {} }),
    useChatStore: makeStore({ addMessage: () => {}, setLoading: () => {} }),
    useSessionStore: makeStore({ session: { id: 'test-session' } }),
    // Leader is now resolved per session; the roster reads it through
    // this hook instead of the process-wide `leaderId`.
    useSessionLeaderId: () => undefined,
  };
});

import { AgentRosterView } from '@/components/AgentRosterView';

const ROLE = 'executor';

function makeStat(role: string) {
  return {
    role,
    exists: true,
    entryCount: 40,
    totalBytes: 9000,
    lastCapture: null,
    cooldownRemainingMs: 0,
    sessionCaptureCount: 0,
    needsSummarization: true, // gates the "Optimize All" bulk button
    hasIdentity: false,
    hasConfig: false,
    hasKnowledge: true,
    learningEnabled: true,
    lifetimeCaptureCount: 40,
    lastCaptureSource: 'automatic' as const,
    isConsolidated: false,
  };
}

describe('AgentRosterView — bulk optimize refreshes the selected consolidated doc', () => {
  beforeEach(() => {
    sendRosterMessage.mockReset();
    sendRosterMessage.mockImplementation(async (type: string) => {
      switch (type) {
        case 'agent-roster.list':
          return { roles: [ROLE], stats: [makeStat(ROLE)], catalog: [] };
        case 'agent-roster.consolidate':
          // Server synthesized + persisted this role headlessly.
          return { consolidated: true, model: 'test-model', rawEntryCount: 40 };
        case 'agent-roster.read-consolidated':
          return { content: '## Consolidated', isConsolidated: true };
        default:
          return {};
      }
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
  });

  it('calls loadConsolidated(selectedRole) exactly once after a bulk optimize that includes it', async () => {
    render(<AgentRosterView />);

    // Wait for the initial roster load (agent-roster.list) to seed stats.
    await waitFor(() => {
      expect(sendRosterMessage).toHaveBeenCalledWith('agent-roster.list', {});
    });

    // Navigate to the Self-Learning tab.
    fireEvent.click(screen.getByText('Self-Learning'));

    // The "needs optimization" banner + "review →" appear once stats with
    // needsSummarization are present. Click "review →" to set selectedRole.
    const reviewBtn = await screen.findByText('review →');
    fireEvent.click(reviewBtn);

    // Click "Optimize All (1)" to run the bulk consolidation.
    const bulkBtn = await screen.findByText(/Optimize All/);
    fireEvent.click(bulkBtn);

    // After the bulk run, the selected role's consolidated document must be
    // reloaded exactly once via agent-roster.read-consolidated.
    await waitFor(() => {
      const readConsolidatedCalls = sendRosterMessage.mock.calls.filter(
        (c) => c[0] === 'agent-roster.read-consolidated',
      );
      expect(readConsolidatedCalls.length).toBe(1);
      expect(readConsolidatedCalls[0][1]).toEqual({ role: ROLE });
    });
  });
});
