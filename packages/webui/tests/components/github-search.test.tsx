import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GitHubListPage, GitHubRepositoryView } from '@wrongstack/webui-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubView } from '../../src/components/GitHubView';
import { useConfigStore } from '../../src/stores/config-store';
import { useSessionLanes } from '../../src/stores/session-lanes';

const base = {
  comments: 0,
  createdAt: '2026-11-20T10:00:00Z',
  updatedAt: '2026-11-26T10:00:00Z',
  labels: [],
  author: 'octocat',
  state: 'open' as const,
};
const view: GitHubRepositoryView = {
  status: 'ok',
  projectRoot: '/project',
  repository: 'octo/repo',
  tokenSource: 'gh',
  pulls: [
    {
      ...base,
      number: 12,
      title: 'Add the GitHub view',
      url: 'https://github.com/octo/repo/pull/12',
      draft: false,
      merged: false,
      headRef: 'feat/github',
      baseRef: 'main',
    },
  ],
  issues: [
    { ...base, number: 7, title: 'Crash on start', url: 'https://github.com/octo/repo/issues/7' },
  ],
  truncated: { pulls: false, issues: false },
  fetchedAt: '2026-11-28T00:00:00Z',
};

function reply(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function routed(search: GitHubListPage) {
  return vi.fn(async (url: string) => {
    if (url.startsWith('/api/github/list?')) return reply(search);
    if (url.startsWith('/api/github/labels'))
      return reply({
        status: 'ok',
        labels: [
          { name: 'bug', color: 'd73a4a' },
          { name: 'good first issue', color: '7057ff' },
        ],
      });
    return reply(view);
  });
}

const urls = (fetcher: ReturnType<typeof routed>) => fetcher.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  useSessionLanes.setState({ activeSessionId: 's1' });
  useConfigStore.setState({ wsConnected: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GitHubView search', () => {
  it('searches GitHub only when asked, and shows matches the title does not contain', async () => {
    const fetcher = routed({
      status: 'ok',
      kind: 'pulls',
      total: 3,
      nextPage: null,
      items: [
        {
          ...view.pulls[0]!,
          number: 40,
          title: 'Harden boot',
          url: 'https://github.com/octo/repo/pull/40',
          state: 'closed',
          merged: true,
          headRef: '',
          baseRef: '',
        },
      ],
    });
    vi.stubGlobal('fetch', fetcher);
    render(<GitHubView />);
    await screen.findByRole('button', { name: /Add the GitHub view/ });
    fireEvent.change(screen.getByRole('textbox', { name: /Filter by title/ }), {
      target: { value: 'crash' },
    });
    // Typing alone filters the loaded items and never calls GitHub's search.
    expect(screen.getByText('Nothing matches this filter.')).toBeTruthy();
    expect(urls(fetcher).some((url) => url.includes('q='))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Search GitHub' }));
    const row = await screen.findByRole('button', { name: /Harden boot/ });
    expect(urls(fetcher)).toContain(
      '/api/github/list?kind=pulls&state=open&page=1&q=crash&sessionId=s1',
    );
    // A search result has no branches to show.
    expect(row.textContent).not.toContain('→');
    expect(screen.getByText('3 results on GitHub for “crash”')).toBeTruthy();
    expect(screen.queryByText(/searches only the items loaded so far/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByRole('button', { name: /Add the GitHub view/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Harden boot/ })).toBeNull();
  });

  it('searches on Enter in the filter field', async () => {
    const fetcher = routed({ status: 'ok', kind: 'issues', total: 0, nextPage: null, items: [] });
    vi.stubGlobal('fetch', fetcher);
    render(<GitHubView />);
    fireEvent.click(await screen.findByRole('tab', { name: /Issues/ }));
    const input = screen.getByRole('textbox', { name: /Filter by title/ });
    fireEvent.change(input, { target: { value: 'boot loop' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText('0 results on GitHub for “boot loop”')).toBeTruthy();
    expect(urls(fetcher)).toContain(
      '/api/github/list?kind=issues&state=open&page=1&q=boot+loop&sessionId=s1',
    );
  });

  it('explains a search GitHub refused for its rate limit', async () => {
    vi.stubGlobal(
      'fetch',
      routed({ status: 'rate-limited', kind: 'pulls', nextPage: null, items: [] }),
    );
    render(<GitHubView />);
    await screen.findByRole('button', { name: /Add the GitHub view/ });
    fireEvent.change(screen.getByRole('textbox', { name: /Filter by title/ }), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search GitHub' }));
    expect((await screen.findByRole('alert')).textContent).toContain('rate limit');
  });
});

describe('GitHubView label picker', () => {
  it("adds the repository's labels to the comma-separated filter", async () => {
    const fetcher = routed({ status: 'ok', kind: 'issues', nextPage: null, items: [] });
    vi.stubGlobal('fetch', fetcher);
    render(<GitHubView />);
    fireEvent.click(await screen.findByRole('tab', { name: /Issues/ }));
    const picker = await screen.findByRole('combobox', { name: 'Add label' });
    expect(urls(fetcher)).toContain('/api/github/labels?sessionId=s1');
    const field = screen.getByRole('textbox', { name: /Labels/ }) as HTMLInputElement;
    fireEvent.change(picker, { target: { value: 'good first issue' } });
    expect(field.value).toBe('good first issue');
    fireEvent.change(screen.getByRole('combobox', { name: 'Add label' }), {
      target: { value: 'bug' },
    });
    expect(field.value).toBe('good first issue, bug');
    // Every label is in the field now, so nothing is left to offer.
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Add label' })).toBeNull());
  });
});

describe('GitHubView mine filter', () => {
  it("lists pull requests awaiting the token owner's review", async () => {
    const fetcher = routed({ status: 'ok', kind: 'pulls', total: 0, nextPage: null, items: [] });
    vi.stubGlobal('fetch', fetcher);
    render(<GitHubView />);
    await screen.findByRole('button', { name: /Add the GitHub view/ });
    const show = screen.getByRole('combobox', { name: 'Show' });
    expect([...show.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      "Everyone's",
      'Created by me',
      'Awaiting my review',
    ]);
    fireEvent.change(show, { target: { value: 'review-requested' } });
    await waitFor(() =>
      expect(urls(fetcher)).toContain(
        '/api/github/list?kind=pulls&state=open&page=1&mine=review-requested&sessionId=s1',
      ),
    );
    expect(screen.queryByRole('button', { name: /Add the GitHub view/ })).toBeNull();
  });

  it('takes the assignee field out of play for issues assigned to me', async () => {
    const fetcher = routed({ status: 'ok', kind: 'issues', nextPage: null, items: [] });
    vi.stubGlobal('fetch', fetcher);
    render(<GitHubView />);
    fireEvent.click(await screen.findByRole('tab', { name: /Issues/ }));
    const show = screen.getByRole('combobox', { name: 'Show' });
    expect([...show.querySelectorAll('option')].map((option) => option.value)).toEqual([
      '',
      'assigned',
      'authored',
    ]);
    fireEvent.change(show, { target: { value: 'assigned' } });
    expect((screen.getByRole('textbox', { name: /Assignee/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    await waitFor(() =>
      expect(urls(fetcher)).toContain(
        '/api/github/list?kind=issues&state=open&page=1&mine=assigned&sessionId=s1',
      ),
    );
  });

  it('offers no mine filter without a token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ ...view, tokenSource: 'none' })),
    );
    render(<GitHubView />);
    await screen.findByRole('button', { name: /Add the GitHub view/ });
    expect(screen.queryByRole('combobox', { name: 'Show' })).toBeNull();
  });
});
