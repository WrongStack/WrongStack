/**
 * jsdom component tests for PromptJournalView — the WebUI page over the
 * project's hierarchical prompt journal. Only the WebSocket transport is
 * stubbed (same pattern as chronicle-dashboard.test.tsx / kanban-view.test.tsx):
 * the real component tree renders, and tests deliver `prompts.journal`
 * payloads on demand to assert the empty / grouped / filtered states.
 *
 * The stubbed client MUST be a single stable object: PromptJournalView calls
 * `getWSClient()` in its render body, so a fresh object per call would change
 * the `client` identity every render, re-run the mount effect (which calls
 * `setLoading(true)`), and leave the page stuck on the loading state.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptJournalView } from '../../src/components/PromptJournalView';
import type { WSPromptJournalEntry, WSPromptsJournalPayload } from '../../src/types/server-message';

const { sendMock, deliver, getClient } = vi.hoisted(() => {
  const handlers = new Map<string, (msg: unknown) => void>();
  const sendMock = vi.fn();
  const client = {
    isConnected: true,
    send: sendMock,
    on: (type: string, cb: (msg: unknown) => void) => {
      handlers.set(type, cb);
      return () => {};
    },
    off: (type: string) => {
      handlers.delete(type);
    },
  };
  return {
    sendMock,
    deliver: (payload: WSPromptsJournalPayload) => {
      handlers.get('prompts.journal')?.({ payload });
    },
    getClient: () => client,
  };
});

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => getClient(),
}));

/** Deliver a `prompts.journal` response through the stubbed transport. */
function deliverJournal(payload: WSPromptsJournalPayload): void {
  act(() => {
    deliver(payload);
  });
}

function entry(
  over: { metadata?: Partial<WSPromptJournalEntry['metadata']> } & Partial<
    Omit<WSPromptJournalEntry, 'metadata'>
  > = {},
): WSPromptJournalEntry {
  const { metadata, ...rest } = over;
  return {
    id: 'e1',
    timestamp: '2026-08-14T10:00:00.000Z',
    sessionId: 'sess_auth',
    projectRoot: '/tmp/proj',
    role: 'user',
    category: 'raw_user',
    content: 'Add phone number to the user table',
    metadata: { tokenEstimate: 12, characterCount: 40, lineCount: 1, ...metadata },
    ...rest,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PromptJournalView', () => {
  it('requests the journal on mount and renders the loading state', () => {
    render(<PromptJournalView />);

    expect(sendMock).toHaveBeenCalledWith({
      type: 'prompts.journal',
      payload: { filter: { limit: 200 } },
    });
    expect(screen.getByText('Loading prompt journal…')).toBeTruthy();
  });

  it('renders the empty state when the journal has no entries', () => {
    render(<PromptJournalView />);
    deliverJournal({ enabled: true, entries: [] });

    expect(screen.getByText('No prompts recorded yet')).toBeTruthy();
    expect(
      screen.getByText('Prompts you send will appear here once the journal has entries.'),
    ).toBeTruthy();
  });

  it('renders the disabled state when the backend reports enabled: false', () => {
    render(<PromptJournalView />);
    deliverJournal({ enabled: false, entries: [] });

    expect(screen.getByText('The prompt journal is not available for this project.')).toBeTruthy();
  });

  it('groups entries by day, newest day first, with a per-day count', () => {
    render(<PromptJournalView />);
    deliverJournal({
      enabled: true,
      entries: [
        entry({ id: 'old', timestamp: '2026-08-14T09:00:00.000Z', content: 'older prompt' }),
        entry({
          id: 'new-a',
          timestamp: '2026-08-15T10:00:00.000Z',
          sessionId: 'sess_billing',
          content: 'newest prompt A',
        }),
        entry({
          id: 'new-b',
          timestamp: '2026-08-15T11:00:00.000Z',
          sessionId: 'sess_billing',
          content: 'newest prompt B',
        }),
      ],
    });

    const headings = screen.getAllByRole('heading', { level: 2 });
    // The day heading renders `${day}${count}` in one text node.
    expect(headings.map((h) => h.textContent)).toEqual(['2026-08-152', '2026-08-141']);
    expect(screen.getByText('newest prompt A')).toBeTruthy();
    expect(screen.getByText('newest prompt B')).toBeTruthy();
    expect(screen.getByText('older prompt')).toBeTruthy();
  });

  it('re-requests with the selected category and renders the filtered result', () => {
    render(<PromptJournalView />);
    deliverJournal({
      enabled: true,
      entries: [
        entry({ id: 'raw', category: 'raw_user', content: 'raw prompt' }),
        entry({ id: 'refined', category: 'refined_user', content: 'refined prompt' }),
      ],
    });
    expect(screen.getByText('raw prompt')).toBeTruthy();
    expect(screen.getByText('refined prompt')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'refined_user' },
    });
    expect(sendMock).toHaveBeenLastCalledWith({
      type: 'prompts.journal',
      payload: { filter: { category: 'refined_user', limit: 200 } },
    });

    deliverJournal({
      enabled: true,
      entries: [entry({ id: 'refined', category: 'refined_user', content: 'refined prompt' })],
    });
    expect(screen.getByText('refined prompt')).toBeTruthy();
    expect(screen.queryByText('raw prompt')).toBeNull();
  });

  it('filters entries client-side by a session substring', () => {
    render(<PromptJournalView />);
    deliverJournal({
      enabled: true,
      entries: [
        entry({ id: 'auth', sessionId: 'sess_auth', content: 'auth prompt' }),
        entry({ id: 'billing', sessionId: 'sess_billing', content: 'billing prompt' }),
      ],
    });
    expect(screen.getByText('auth prompt')).toBeTruthy();
    expect(screen.getByText('billing prompt')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Session'), {
      target: { value: 'billing' },
    });

    expect(screen.queryByText('auth prompt')).toBeNull();
    expect(screen.getByText('billing prompt')).toBeTruthy();
  });

  it('drops recorder-side categories and only surfaces manually-entered user prompts', () => {
    render(<PromptJournalView />);
    deliverJournal({
      enabled: true,
      // Mix every category the recorder may write — only raw_user and
      // refined_user should survive the WebUI filter.
      entries: [
        entry({
          id: 'system',
          category: 'system_prompt',
          timestamp: '2026-08-14T08:00:00.000Z',
          content: 'system prompt body',
        }),
        entry({
          id: 'raw',
          category: 'raw_user',
          timestamp: '2026-08-14T09:00:00.000Z',
          content: 'Add phone number to the user table',
        }),
        entry({
          id: 'auto',
          category: 'autonomous_next_step',
          timestamp: '2026-08-14T10:00:00.000Z',
          content: 'Continue to the next iteration',
        }),
        entry({
          id: 'heal',
          category: 'self_healing_retry',
          timestamp: '2026-08-15T10:00:00.000Z',
          content: 'Recovered provider error via retry',
          metadata: { decisionReason: 'simulated provider recovery' },
        }),
        entry({
          id: 'refined',
          category: 'refined_user',
          timestamp: '2026-08-15T11:00:00.000Z',
          content: 'Add a phone-number column to the users table',
          rawContent: 'Add phone number to the user table',
        }),
      ],
    });

    // The two tracked categories render; everything else is filtered out
    // before reaching the page, so its content should NOT appear in the DOM.
    expect(screen.getByText('Add phone number to the user table')).toBeTruthy();
    expect(screen.getByText('Add a phone-number column to the users table')).toBeTruthy();
    expect(screen.queryByText('system prompt body')).toBeNull();
    expect(screen.queryByText('Continue to the next iteration')).toBeNull();
    expect(screen.queryByText('Recovered provider error via retry')).toBeNull();

    // Expanding the refined entry reveals both the refined body and the raw
    // counterpart — the page treats the raw content as the English version
    // for cross-language tracking.
    fireEvent.click(screen.getByText('Add a phone-number column to the users table'));
    expect(screen.getByText('Refined copy')).toBeTruthy();
    expect(screen.getByText('Raw input')).toBeTruthy();

    // The category filter dropdown is populated only from the entries that
    // survived the filter, so it offers Raw user and Refined user — nothing
    // else. (The page also has a Limit dropdown, so scope the assertion to
    // the category select.)
    const categorySelect = screen.getByLabelText('Category') as HTMLSelectElement;
    const categoryOptions = Array.from(categorySelect.options).map((o) => o.textContent);
    expect(categoryOptions).toEqual(['All', 'Raw user', 'Refined user']);
  });
});
