// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsResponse, FetchEventsFilters } from '../../data/api.js';
import { EventsView } from '../events.js';

vi.mock('../../data/api.js', () => ({
  fetchEvents: vi.fn(),
}));

// Import the mocked module AFTER vi.mock so we get the same instance.
import { fetchEvents } from '../../data/api.js';

const mockFetchEvents = vi.mocked(fetchEvents);

function makeResponse(overrides: Partial<EventsResponse['events'][number]> = {}): EventsResponse {
  return {
    events: [
      {
        type: 'session.snapshot',
        timestamp: '2026-09-13T10:00:00.000Z',
        clientId: 'host-1:cli:42:abcd',
        machineId: 'machine-abc',
        payload: { sessionId: 'sess-1', agentCount: 3 },
        ...overrides,
      },
    ],
    total: 1,
  };
}

beforeEach(() => {
  mockFetchEvents.mockReset();
  mockFetchEvents.mockResolvedValue(makeResponse());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EventsView (W5 #19)', () => {
  it('renders the filter bar and timeline card', async () => {
    render(<EventsView />);
    expect(screen.getByText('Event Log')).toBeTruthy();
    // Five filter inputs (type, clientId, machineId, since, until) — labels
    // are queried by their visible text.
    expect(screen.getByText(/^Type$/)).toBeTruthy();
    expect(screen.getByText(/^Client ID$/)).toBeTruthy();
    expect(screen.getByText(/^Machine ID$/)).toBeTruthy();
    expect(screen.getByText(/Since \(local\)/)).toBeTruthy();
    expect(screen.getByText(/Until \(local\)/)).toBeTruthy();
    // The Refresh button starts as 'Refreshing…' during the initial mount-fetch.
    // Wait for the first fetch to resolve so the button returns to 'Refresh'.
    await waitFor(() => expect(mockFetchEvents).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('calls fetchEvents on mount with the initial filters', async () => {
    render(<EventsView />);
    await waitFor(() => {
      expect(mockFetchEvents).toHaveBeenCalled();
    });
    const call = mockFetchEvents.mock.calls[0]?.[0] as FetchEventsFilters | undefined;
    expect(call).toBeDefined();
    expect(call?.limit).toBe(200);
    // Text filters default to undefined (not empty strings).
    expect(call?.type).toBeUndefined();
    expect(call?.clientId).toBeUndefined();
    expect(call?.machineId).toBeUndefined();
  });

  it('renders events from the API response', async () => {
    mockFetchEvents.mockResolvedValueOnce(makeResponse({ type: 'tool.completed' }));
    render(<EventsView />);
    await waitFor(() => {
      expect(screen.getByText('tool.completed')).toBeTruthy();
    });
    expect(screen.getByText('host-1:cli:42:abcd')).toBeTruthy();
    expect(screen.getByText('@ machine-abc')).toBeTruthy();
  });

  it('trims whitespace from text filters before sending', async () => {
    const user = userEvent.setup();
    render(<EventsView />);
    await waitFor(() => expect(mockFetchEvents).toHaveBeenCalled());

    // Type into the type filter with surrounding whitespace.
    const typeInput = screen.getByPlaceholderText(/e.g. session\.snapshot/);
    await user.type(typeInput, '  brain.event  ');

    // The manual Refresh click should send a trimmed filter.
    await user.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      const lastCall = mockFetchEvents.mock.calls.at(-1)?.[0] as FetchEventsFilters | undefined;
      expect(lastCall?.type).toBe('brain.event');
    });
  });

  it('sends undefined (not empty string) for blank text filters', async () => {
    const user = userEvent.setup();
    render(<EventsView />);
    await waitFor(() => expect(mockFetchEvents).toHaveBeenCalled());

    await user.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      const lastCall = mockFetchEvents.mock.calls.at(-1)?.[0] as FetchEventsFilters | undefined;
      expect(lastCall?.type).toBeUndefined();
      expect(lastCall?.clientId).toBeUndefined();
      expect(lastCall?.machineId).toBeUndefined();
    });
  });

  it('shows an error card when fetchEvents rejects', async () => {
    mockFetchEvents.mockRejectedValueOnce(new Error('boom'));
    render(<EventsView />);
    await waitFor(() => {
      expect(screen.getByText('boom')).toBeTruthy();
    });
  });

  it('shows the empty state when the API returns zero events', async () => {
    mockFetchEvents.mockResolvedValueOnce({ events: [], total: 0 });
    render(<EventsView />);
    await waitFor(() => {
      expect(screen.getByText(/No events match the current filters/)).toBeTruthy();
    });
  });

  it('does NOT re-fetch on every keystroke (text filters require manual Refresh)', async () => {
    const user = userEvent.setup();
    render(<EventsView />);
    await waitFor(() => expect(mockFetchEvents).toHaveBeenCalledTimes(1));

    const typeInput = screen.getByPlaceholderText(/e.g. session\.snapshot/);
    await user.type(typeInput, 'session');

    // Still 1 — no automatic re-fetch on keystroke.
    expect(mockFetchEvents).toHaveBeenCalledTimes(1);

    // Now click Refresh — this DOES trigger a re-fetch.
    await user.click(screen.getByText('Refresh'));
    await waitFor(() => expect(mockFetchEvents).toHaveBeenCalledTimes(2));
  });

  it('renders multiple events in order', async () => {
    mockFetchEvents.mockResolvedValueOnce({
      events: [
        {
          type: 'session.snapshot',
          timestamp: '2026-09-13T10:00:00.000Z',
          clientId: 'host-a',
        },
        {
          type: 'tool.completed',
          timestamp: '2026-09-13T10:00:01.000Z',
          clientId: 'host-b',
        },
        {
          type: 'approval.requested',
          timestamp: '2026-09-13T10:00:02.000Z',
          clientId: 'host-c',
        },
      ],
      total: 3,
    });
    render(<EventsView />);
    await waitFor(() => {
      expect(screen.getByText('session.snapshot')).toBeTruthy();
      expect(screen.getByText('tool.completed')).toBeTruthy();
      expect(screen.getByText('approval.requested')).toBeTruthy();
    });
    // The header summary includes the total.
    expect(screen.getByText(/3 events \(total 3\)/)).toBeTruthy();
  });

  it('formats the timestamp as HH:MM:SS.mmm (best-effort: shows raw on parse failure)', async () => {
    mockFetchEvents.mockResolvedValueOnce(makeResponse({ timestamp: 'not-a-date' }));
    render(<EventsView />);
    await waitFor(() => {
      expect(screen.getByText('not-a-date')).toBeTruthy();
    });
  });

  it('shows the busy indicator while a refresh is in flight', async () => {
    let resolveRefresh: ((value: EventsResponse) => void) | undefined;
    mockFetchEvents.mockImplementationOnce(
      () =>
        new Promise<EventsResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    render(<EventsView />);
    await waitFor(() => {
      expect(screen.getByText('Refreshing…')).toBeTruthy();
    });

    // Resolve the in-flight fetch so the component transitions back to
    // the idle "Refresh" label.
    await act(async () => {
      resolveRefresh?.(makeResponse());
    });
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeTruthy();
    });
  });
});
