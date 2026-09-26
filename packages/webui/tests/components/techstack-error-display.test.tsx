import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemediationTab } from '../../src/components/TechStackView/RemediationTab';
import { TrendsTab } from '../../src/components/TechStackView/TrendsTab';
import { type TechStackUpgradePlan, useTechStackStore } from '../../src/stores/techstack-store';

const fakeKey = `sk-${'a'.repeat(24)}`;
const plan: TechStackUpgradePlan = {
  snapshotId: 'snap-1',
  generatedAt: '2026-09-25T00:00:00.000Z',
  warning: '',
  summary: { total: 1, patch: 1, minor: 0, major: 0, replace: 0, remove: 0, investigate: 0 },
  items: [
    {
      dependencyName: 'example',
      ecosystem: 'npm',
      workspaceId: 'ws-1',
      action: 'upgrade_patch',
      severity: 'info',
      rationale: 'Patch update',
      executable: true,
    },
  ],
};

function failureResponse(reason: string): Response {
  return new Response(JSON.stringify({ error: `${reason}: ${fakeKey}` }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  useTechStackStore.getState().clear();
});

afterEach(() => {
  cleanup();
  useTechStackStore.getState().clear();
  vi.unstubAllGlobals();
});

describe('TechStack fetch-error display', () => {
  it('redacts a remediation plan fetch error in the visible alert', async () => {
    useTechStackStore.setState({ snapshot: { id: 'snap-1' } as never });
    let respond!: (response: Response) => void;
    let respondRetry!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            respondRetry = resolve;
          }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<RemediationTab />);
    await act(async () => {
      respond(failureResponse('Plan unavailable'));
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Plan unavailable: [REDACTED:openai_key]');
    expect(alert.textContent).not.toContain(fakeKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/techstack/remediation', { method: 'GET' });

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await act(async () => {
      respondRetry(
        new Response(JSON.stringify({ plan, preview: { dryRun: true, items: [] } }), {
          status: 200,
        }),
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('redacts a remediation apply fetch error in the visible alert', async () => {
    useTechStackStore.setState({ snapshot: { id: 'snap-1' } as never, remediationPlan: plan });
    const fetchMock = vi.fn().mockResolvedValue(failureResponse('Apply unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    render(<RemediationTab />);
    const apply = screen.getByRole('button', { name: /apply selected/i });
    await waitFor(() => expect(apply.hasAttribute('disabled')).toBe(false));
    fireEvent.click(apply);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Apply unavailable: [REDACTED:openai_key]');
    expect(alert.textContent).not.toContain(fakeKey);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/techstack/remediation/apply',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('redacts a trends fetch error in the visible alert', async () => {
    const fetchMock = vi.fn().mockResolvedValue(failureResponse('Trends unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    render(<TrendsTab />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Trends unavailable: [REDACTED:openai_key]');
    expect(alert.textContent).not.toContain(fakeKey);
    expect(fetchMock).toHaveBeenCalledWith('/api/techstack/trends', { method: 'GET' });
  });
});
