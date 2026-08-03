import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequirementIntakeView } from '@/components/RequirementIntakeView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const INTAKES = [
  {
    id: 'reqi_list1',
    title: 'Add email-based password reset',
    requestType: 'feature',
    status: 'submitted',
    priority: 'high',
    updatedAt: Date.now() - 5 * 60_000,
    createdAt: Date.now() - 60_000,
  },
  {
    id: 'reqi_list2',
    title: 'Fix flaky CI retry',
    requestType: 'bug_fix',
    status: 'draft',
    priority: 'unspecified',
    updatedAt: Date.now() - 3 * 60_000,
    createdAt: Date.now() - 3 * 60_000,
  },
];

describe('RequirementIntakeView', () => {
  it('lists intake records from the server-resolved endpoint', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ projectId: 'proj_alpha', intakes: INTAKES }));

    render(<RequirementIntakeView />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/requirement-intakes');
    });
    expect(await screen.findByText('Add email-based password reset')).toBeTruthy();
    expect(screen.getByText('Fix flaky CI retry')).toBeTruthy();
    expect(screen.getByText('reqi_list1')).toBeTruthy();
    expect(screen.getAllByText('submitted').length).toBeGreaterThan(0);
  });

  it('shows an empty state when no records exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ projectId: 'proj_alpha', intakes: [] }),
    );

    render(<RequirementIntakeView />);

    expect(await screen.findByText(/No intake records yet/)).toBeTruthy();
  });

  it('surfaces a load error with a retry action', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: 'List failed (HTTP 500)' } }, 500),
    );

    render(<RequirementIntakeView />);

    expect(await screen.findByText(/List failed/)).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('creates and submits a record through the REST endpoints', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ projectId: 'proj_alpha', intakes: [] }))
      .mockResolvedValueOnce(jsonResponse({ record: { ...INTAKES[0], id: 'reqi_new' } }, 201))
      .mockResolvedValueOnce(
        jsonResponse({ record: { ...INTAKES[0], id: 'reqi_new', status: 'submitted' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          projectId: 'proj_alpha',
          intakes: [{ ...INTAKES[0], id: 'reqi_new', title: 'Ship the dashboard' }],
        }),
      );

    render(<RequirementIntakeView />);
    await screen.findByText(/No intake records yet/);

    fireEvent.change(screen.getByLabelText(/Request text/), {
      target: { value: 'Ship the dashboard' },
    });
    fireEvent.click(screen.getByRole('button', { name: /File \+ submit/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/proj_alpha/requirement-intakes',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/requirement-intakes/reqi_new/submit',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await screen.findByText(/Intake recorded and submitted/)).toBeTruthy();
    expect(await screen.findByText('Ship the dashboard')).toBeTruthy();

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/projects/') &&
        String(url).endsWith('/requirement-intakes') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse(String((createCall?.[1] as RequestInit | undefined)?.body)) as {
      originalRequest: string;
    };
    expect(body.originalRequest).toBe('Ship the dashboard');
  });

  it('blocks submission when the request text is blank', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ projectId: 'proj_alpha', intakes: [] }),
    );

    render(<RequirementIntakeView />);
    await screen.findByText(/No intake records yet/);

    const submitButton = screen.getByRole('button', { name: /File \+ submit/ });
    expect(submitButton).toHaveProperty('disabled', true);
  });
});
