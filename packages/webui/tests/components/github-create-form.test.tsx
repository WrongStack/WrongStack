import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  GitHubCreateContext,
  GitHubItemDetailView,
  GitHubRepositoryView,
} from '@wrongstack/webui-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubView } from '../../src/components/GitHubView';
import { useConfigStore } from '../../src/stores/config-store';
import { useSessionLanes } from '../../src/stores/session-lanes';
import { useUIStore } from '../../src/stores/ui-store';

const view: GitHubRepositoryView = {
  status: 'ok',
  projectRoot: '/project',
  repository: 'octo/repo',
  tokenSource: 'gh',
  pulls: [],
  issues: [],
  truncated: { pulls: false, issues: false },
  fetchedAt: '2026-11-28T00:00:00Z',
};

function context(
  state: NonNullable<GitHubCreateContext['branch']>['state'],
  openPull: NonNullable<GitHubCreateContext['branch']>['openPull'] = null,
): GitHubCreateContext {
  return {
    status: 'ok',
    repository: 'octo/repo',
    tokenSource: 'gh',
    defaultBranch: 'main',
    branch: { name: 'feat/new-view', state, subject: 'Add the new view', openPull },
  };
}

function created(kind: 'pull' | 'issue', number: number): GitHubItemDetailView {
  return {
    status: 'ok',
    repository: 'octo/repo',
    tokenSource: 'gh',
    item: {
      kind,
      number,
      title: kind === 'pull' ? 'Add the new view' : 'Crash on start',
      url: `https://github.com/octo/repo/${kind === 'pull' ? 'pull' : 'issues'}/${number}`,
      author: 'octocat',
      labels: [],
      comments: 0,
      createdAt: '2026-11-28T00:00:00Z',
      updatedAt: '2026-11-28T00:00:00Z',
      state: 'open',
      body: '',
      pull: null,
    },
  };
}

function routed(createContext: GitHubCreateContext, item: GitHubItemDetailView) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const body = url.startsWith('/api/github/create-context')
      ? createContext
      : url.startsWith('/api/github/create')
        ? {
            ok: true,
            status: 'done',
            item: { kind: item.item!.kind, number: item.item!.number, url: item.item!.url },
          }
        : url.startsWith('/api/github/item')
          ? item
          : view;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

const posted = (fetcher: ReturnType<typeof routed>) =>
  fetcher.mock.calls
    .filter(([url]) => String(url).startsWith('/api/github/create?'))
    .map(([url, init]) => [String(url), JSON.parse(String(init?.body))]);

beforeEach(() => {
  useSessionLanes.setState({ activeSessionId: 's1' });
  useConfigStore.setState({ wsConnected: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GitHubView new items', () => {
  it('opens an issue and shows it', async () => {
    const fetcher = routed(context('ready'), created('issue', 31));
    vi.stubGlobal('fetch', fetcher);
    render(<GitHubView />);
    fireEvent.click(await screen.findByRole('tab', { name: /Issues/ }));
    fireEvent.click(screen.getByRole('button', { name: 'New issue' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Crash on start' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Steps' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open issue' }));
    expect(await screen.findByRole('article', { name: 'Details' })).toBeTruthy();
    expect(posted(fetcher)).toEqual([
      [
        '/api/github/create?sessionId=s1',
        { kind: 'issue', title: 'Crash on start', body: 'Steps' },
      ],
    ]);
    // An issue needs no branch, so the context is never read.
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('create-context'))).toBe(false);
  });

  it('opens a pull request from the pushed branch, titled after its last commit', async () => {
    const fetcher = routed(context('ready'), created('pull', 78));
    vi.stubGlobal('fetch', fetcher);
    render(<GitHubView />);
    fireEvent.click(await screen.findByRole('button', { name: 'New pull request' }));
    const title = (await screen.findByRole('textbox', { name: 'Title' })) as HTMLInputElement;
    expect(title.value).toBe('Add the new view');
    expect((screen.getByRole('textbox', { name: 'Base branch' }) as HTMLInputElement).value).toBe(
      'main',
    );
    expect(screen.getByText('feat/new-view')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Open as draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }));
    await waitFor(() => expect(posted(fetcher)).toHaveLength(1));
    expect(posted(fetcher)[0]![1]).toEqual({
      kind: 'pull',
      title: 'Add the new view',
      body: '',
      base: 'main',
      head: 'feat/new-view',
      draft: true,
    });
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url]) => String(url) === '/api/github/item?kind=pull&number=78&sessionId=s1',
        ),
      ).toBe(true),
    );
  });

  it('hands an unpushed branch to the agent instead of offering the form', async () => {
    useUIStore.setState({ promptInsertRequest: null, currentView: 'github' });
    vi.stubGlobal('fetch', routed(context('not-pushed'), created('pull', 1)));
    render(<GitHubView />);
    fireEvent.click(await screen.findByRole('button', { name: 'New pull request' }));
    expect(await screen.findByText(/GitHub does not have this branch yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open pull request' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to push it' }));
    const prompt = useUIStore.getState().promptInsertRequest ?? '';
    expect(prompt).toContain('git push -u origin feat/new-view');
    expect(prompt).toContain('Never force-push');
    expect(useUIStore.getState().currentView).toBe('chat');
  });

  it('points at the pull request already open from the branch', async () => {
    const fetcher = routed(
      context('ready', {
        number: 77,
        title: 'Add the new view',
        url: 'https://github.com/octo/repo/pull/77',
      }),
      created('pull', 77),
    );
    vi.stubGlobal('fetch', fetcher);
    render(<GitHubView />);
    fireEvent.click(await screen.findByRole('button', { name: 'New pull request' }));
    expect(await screen.findByText(/#77 is already open/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open pull request' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show it' }));
    expect(await screen.findByRole('article', { name: 'Details' })).toBeTruthy();
    expect(posted(fetcher)).toEqual([]);
  });

  it('offers nothing to open from the default branch', async () => {
    vi.stubGlobal('fetch', routed(context('default'), created('pull', 1)));
    render(<GitHubView />);
    fireEvent.click(await screen.findByRole('button', { name: 'New pull request' }));
    expect(await screen.findByText(/is the default branch main/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
  });

  it('offers no new items without a token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...view, tokenSource: 'none' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    render(<GitHubView />);
    await screen.findByRole('tablist');
    expect(screen.queryByRole('button', { name: 'New pull request' })).toBeNull();
  });
});
