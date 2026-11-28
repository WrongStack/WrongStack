import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitHubListPage, GitHubRepositoryView } from '@wrongstack/webui-protocol';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubSeams } from '../src/server/github-client.js';
import { handleGitHubRoutes } from '../src/server/github-handlers.js';

const API = 'https://api.github.com/repos/octo/repo';

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const next = (page: number) => ({
  link: `<https://api.github.com/repositories/7/issues?state=closed&page=${page}>; rel="next", <https://api.github.com/repositories/7/issues?page=9>; rel="last"`,
});

function seams(route: (url: string) => Response | undefined) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const reply = route(String(input));
    if (!reply) throw new Error(`unexpected GET ${String(input)}`);
    return reply;
  });
  return {
    readRemote: vi.fn(async () => 'https://github.com/octo/repo.git'),
    readBranch: vi.fn(async () => ({ name: 'main', head: 'c'.repeat(40), subject: '' })),
    resolveToken: vi.fn(async () => ({ token: 'tkn', source: 'env' as const })),
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => 0,
  } satisfies GitHubSeams;
}

async function get(path: string, github: GitHubSeams) {
  const req = { method: 'GET', headers: {} } as unknown as IncomingMessage;
  let status = 0;
  let body: unknown = null;
  const res = {
    headersSent: false,
    writeHead: (code: number) => {
      status = code;
    },
    end: (text: string) => {
      body = JSON.parse(text);
    },
  } as unknown as ServerResponse;
  await handleGitHubRoutes(
    req,
    res,
    new URL(`http://localhost${path}`),
    { projectRoot: '/project', github },
    { requireAccessToken: false, accessTokenOk: false },
  );
  return { status, body };
}

const urls = (github: GitHubSeams) =>
  (github.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));

const user = { login: 'octocat' };
const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Pull ${number}`,
  user,
  labels: [],
  comments: 0,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-02T00:00:00Z',
  state: 'closed',
  draft: false,
  merged_at: null,
  head: { ref: 'feature' },
  base: { ref: 'main' },
  ...extra,
});
const issue = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  user,
  labels: [],
  comments: 1,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-02T00:00:00Z',
  state: 'closed',
  ...extra,
});
const pullAsIssue = (number: number) => ({ ...issue(number), pull_request: {} });

describe('GET /api/github/list', () => {
  it('reads one page of closed pull requests and reports merges and the next page', async () => {
    const github = seams((url) =>
      url.startsWith(`${API}/pulls?`)
        ? json([pull(9, { merged_at: '2026-11-03T00:00:00Z' }), pull(8)], next(3))
        : undefined,
    );
    const { status, body } = await get('/api/github/list?kind=pulls&state=closed&page=2', github);
    expect(status).toBe(200);
    expect(urls(github)).toEqual([
      `${API}/pulls?state=closed&sort=updated&direction=desc&per_page=50&page=2`,
    ]);
    const page = body as GitHubListPage;
    expect(page).toMatchObject({ status: 'ok', kind: 'pulls', nextPage: 3 });
    expect(
      page.items.map((item) => [item.number, item.state, 'merged' in item && item.merged]),
    ).toEqual([
      [9, 'closed', true],
      [8, 'closed', false],
    ]);
  });

  it('ends the list when GitHub names no next page', async () => {
    const github = seams(() => json([pull(1, { state: 'open' })]));
    const { body } = await get('/api/github/list?kind=pulls&state=all', github);
    expect(urls(github)).toEqual([
      `${API}/pulls?state=all&sort=updated&direction=desc&per_page=50&page=1`,
    ]);
    expect(body).toMatchObject({ kind: 'pulls', nextPage: null, items: [{ state: 'open' }] });
  });

  it('reads on past issue pages that held only pull requests', async () => {
    const github = seams((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) return json([pullAsIssue(30), pullAsIssue(29)], next(2));
      if (page === 2) return json([pullAsIssue(28)], next(3));
      if (page === 3) return json([issue(27), pullAsIssue(26)], next(4));
      return undefined;
    });
    const { body } = await get('/api/github/list?kind=issues&state=closed', github);
    expect(urls(github)).toHaveLength(3);
    expect(body).toMatchObject({ status: 'ok', kind: 'issues', nextPage: 4 });
    expect((body as GitHubListPage).items.map((item) => item.number)).toEqual([27]);
  });

  it('stops reading on after three pages and still names the next one', async () => {
    const github = seams((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return json([pullAsIssue(100 - page)], next(page + 1));
    });
    const { body } = await get('/api/github/list?kind=issues&state=closed&page=5', github);
    expect(urls(github).map((url) => new URL(url).searchParams.get('page'))).toEqual([
      '5',
      '6',
      '7',
    ]);
    expect(body).toMatchObject({ items: [], nextPage: 8 });
  });

  it('filters issues by labels and assignee', async () => {
    const github = seams(() => json([issue(4, { state: 'open' })]));
    await get(
      `/api/github/list?kind=issues&state=open&labels=${encodeURIComponent('bug,good first issue')}&assignee=octo-cat`,
      github,
    );
    expect(urls(github)).toEqual([
      `${API}/issues?state=open&sort=updated&direction=desc&per_page=50&page=1&labels=bug%2Cgood%20first%20issue&assignee=octo-cat`,
    ]);
  });

  it('answers an empty last page for a repository with issues turned off', async () => {
    const github = seams(() => new Response(null, { status: 410 }));
    const { body } = await get('/api/github/list?kind=issues', github);
    expect(body).toEqual({ status: 'ok', kind: 'issues', items: [], nextPage: null });
  });

  it('reports why GitHub gave no page', async () => {
    const github = seams(() => new Response('{}', { status: 429 }));
    const { body } = await get('/api/github/list?kind=pulls', github);
    expect(body).toEqual({ status: 'rate-limited', kind: 'pulls', items: [], nextPage: null });
  });

  it.each([
    'kind=commits',
    'kind=pulls&state=merged',
    'kind=pulls&page=0',
    'kind=pulls&page=abc',
    'kind=pulls&page=401',
    'kind=pulls&labels=bug',
    'kind=pulls&assignee=octocat',
    'kind=issues&assignee=octo%20cat',
    'kind=issues&assignee=-octo',
    'kind=issues&labels=bad%0Alabel',
    `kind=issues&labels=${Array.from({ length: 11 }, (_, i) => `l${i}`).join(',')}`,
    `kind=issues&labels=${'x'.repeat(101)}`,
  ])('refuses %s without calling GitHub', async (query) => {
    const github = seams(() => json([]));
    const { status } = await get(`/api/github/list?${query}`, github);
    expect(status).toBe(400);
    expect(github.fetch).not.toHaveBeenCalled();
  });

  it('accepts none and * as assignee filters', async () => {
    for (const assignee of ['none', '*']) {
      const github = seams(() => json([]));
      const { status } = await get(
        `/api/github/list?kind=issues&assignee=${encodeURIComponent(assignee)}`,
        github,
      );
      expect(status).toBe(200);
      expect(urls(github)[0]).toContain(`&assignee=${encodeURIComponent(assignee)}`);
    }
  });
});

describe('GET /api/github/list with q (GitHub search)', () => {
  const SEARCH = 'https://api.github.com/search/issues?q=';
  const found = (number: number, extra: Record<string, unknown> = {}) => ({
    ...issue(number),
    repository_url: 'https://api.github.com/repos/Octo/Repo',
    ...extra,
  });
  const asPull = (number: number, extra: Record<string, unknown> = {}) =>
    found(number, { pull_request: { merged_at: null }, draft: false, ...extra });

  it('searches this repository with the tab and state as qualifiers', async () => {
    const github = seams(() => json({ total_count: 0, items: [] }));
    await get('/api/github/list?kind=pulls&state=closed&page=2&q=fix%20crash', github);
    expect(urls(github)).toEqual([
      `${SEARCH}${encodeURIComponent('repo:octo/repo is:pr is:closed fix crash')}&sort=updated&order=desc&per_page=50&page=2`,
    ]);
  });

  it('turns issue filters into qualifiers', async () => {
    const github = seams(() => json({ total_count: 0, items: [] }));
    await get(
      `/api/github/list?kind=issues&state=all&q=boot&labels=${encodeURIComponent('bug,good first issue')}&assignee=none`,
      github,
    );
    expect(decodeURIComponent(urls(github)[0]!.slice(SEARCH.length).split('&')[0]!)).toBe(
      'repo:octo/repo is:issue label:"bug" label:"good first issue" no:assignee boot',
    );
  });

  it('keeps only this repository and the tab kind, whatever the text asked for', async () => {
    const github = seams(() =>
      json(
        {
          total_count: 4,
          items: [
            asPull(9, {
              draft: true,
              state: 'closed',
              pull_request: { merged_at: '2026-11-03T00:00:00Z' },
            }),
            found(8),
            asPull(7, { repository_url: 'https://api.github.com/repos/other/repo' }),
            asPull(6, { repository_url: 'https://api.github.com/repos/octo/repo-fork' }),
          ],
        },
        next(2),
      ),
    );
    const { body } = await get(
      `/api/github/list?kind=pulls&q=${encodeURIComponent('repo:other/repo OR is:issue')}`,
      github,
    );
    expect(urls(github)).toHaveLength(1);
    expect(body).toMatchObject({ status: 'ok', kind: 'pulls', nextPage: 2, total: 4 });
    expect((body as GitHubListPage).items).toEqual([
      expect.objectContaining({
        number: 9,
        url: 'https://github.com/octo/repo/pull/9',
        state: 'closed',
        draft: true,
        merged: true,
        headRef: '',
        baseRef: '',
      }),
    ]);
  });

  it('ends at the thousandth result GitHub search can return', async () => {
    const github = seams(() => json({ total_count: 5000, items: [] }, next(21)));
    const { body } = await get('/api/github/list?kind=issues&q=x&page=20', github);
    expect(body).toMatchObject({ nextPage: null, total: 5000 });
  });

  it('reports a secondary rate limit as a rate limit, not a missing token', async () => {
    const github = seams(
      () =>
        new Response(
          JSON.stringify({ message: 'You have exceeded a secondary rate limit. Please wait.' }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    );
    const { body } = await get('/api/github/list?kind=issues&q=x', github);
    expect(body).toMatchObject({ status: 'rate-limited', items: [] });
  });

  it.each([
    `q=${'x'.repeat(257)}`,
    'q=a%0Ab',
    'q=x&page=21',
    'q=x&assignee=*',
    `q=x&labels=${encodeURIComponent('say "hi"')}`,
  ])('refuses kind=issues&%s without calling GitHub', async (query) => {
    const github = seams(() => json({ total_count: 0, items: [] }));
    const { status } = await get(`/api/github/list?kind=issues&${query}`, github);
    expect(status).toBe(400);
    expect(github.fetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/github/labels', () => {
  it("lists the repository's labels for the issue filter", async () => {
    const github = seams(() =>
      json([
        { name: 'bug', color: 'd73a4a', description: 'x' },
        { name: 'good first issue', color: 'nothex' },
        { name: 42 },
      ]),
    );
    const { status, body } = await get('/api/github/labels', github);
    expect(status).toBe(200);
    expect(urls(github)).toEqual([`${API}/labels?per_page=100`]);
    expect(body).toEqual({
      status: 'ok',
      labels: [
        { name: 'bug', color: 'd73a4a' },
        { name: 'good first issue', color: '' },
      ],
    });
  });

  it('reports why there are no labels', async () => {
    const github = seams(() => new Response('{}', { status: 429 }));
    const { body } = await get('/api/github/labels', github);
    expect(body).toEqual({ status: 'rate-limited', labels: [] });
  });
});

describe('GET /api/github keeps its open-items shape', () => {
  it('reads the same URLs and now names each item state', async () => {
    const github = seams((url) =>
      url.startsWith(`${API}/pulls?`)
        ? json([pull(2, { state: 'open' })])
        : json([issue(1, { state: 'open' })]),
    );
    const { body } = await get('/api/github', github);
    expect(urls(github)).toEqual([
      `${API}/pulls?state=open&sort=updated&direction=desc&per_page=50`,
      `${API}/issues?state=open&sort=updated&direction=desc&per_page=50`,
    ]);
    const view = body as GitHubRepositoryView;
    expect(view.pulls[0]).toMatchObject({ number: 2, state: 'open', merged: false });
    expect(view.issues[0]).toMatchObject({ number: 1, state: 'open' });
  });
});
