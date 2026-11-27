import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('@wrongstack/core/storage', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getSessionRegistry: () => ({ get: getSession }),
}));

import type { GitHubRepositoryView } from '@wrongstack/webui-protocol';
import type { GitHubSeams } from '../src/server/github-client.js';
import { handleGitHubRoutes } from '../src/server/github-handlers.js';
import { handleApiRoutes } from '../src/server/http-server/api-router.js';

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const pull = {
  number: 12,
  title: 'Add GitHub view',
  html_url: 'https://evil.example/pull/12',
  user: { login: 'octocat' },
  labels: [
    { name: 'feature', color: '0e8a16' },
    { name: 'bad-color', color: 'red;background:url(x)' },
  ],
  comments: 3,
  draft: true,
  head: { ref: 'feat/github' },
  base: { ref: 'main' },
  created_at: '2026-11-20T10:00:00Z',
  updated_at: '2026-11-26T10:00:00Z',
  body: 'x'.repeat(1000),
};
const issue = {
  number: 7,
  title: 'Crash on start',
  user: null,
  labels: [],
  comments: 0,
  created_at: '2026-11-01T10:00:00Z',
  updated_at: '2026-11-02T10:00:00Z',
};

function seams(overrides: Partial<GitHubSeams> = {}) {
  const fetch = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/pulls?')
      ? json([pull], { headers: { link: '<https://api.github.com/x?page=2>; rel="next"' } })
      : json([issue, { ...pull, number: 12, pull_request: {} }]),
  );
  return {
    readRemote: vi.fn(async () => 'git@github.com:WrongStack/WrongStack.git'),
    resolveToken: vi.fn(async () => ({ token: 'secret-token', source: 'gh' as const })),
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => Date.parse('2026-11-27T00:00:00Z'),
    ...overrides,
  } satisfies GitHubSeams;
}

/** Drives the production handler with injected git/token/fetch edges. */
async function readGitHubRepository(
  projectRoot: string,
  { seams: github }: { seams: GitHubSeams },
): Promise<GitHubRepositoryView> {
  let body = '';
  const res = { writeHead: () => res, end: (text: string) => (body = text) };
  await handleGitHubRoutes(
    { method: 'GET' } as IncomingMessage,
    res as unknown as ServerResponse,
    new URL('http://x/api/github'),
    { projectRoot, github },
    { requireAccessToken: false, accessTokenOk: false },
  );
  return JSON.parse(body) as GitHubRepositoryView;
}

async function parseGitHubRemote(remote: string): Promise<string | null> {
  const view = await readGitHubRepository('/p', {
    seams: seams({ readRemote: vi.fn(async () => remote) }),
  });
  return view.repository;
}

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/WrongStack/WrongStack.git', 'WrongStack/WrongStack'],
    ['https://user:pass@github.com/owner/repo', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['ssh://git@github.com:22/owner/repo.git', 'owner/repo'],
    ['https://github.com/owner/repo/', 'owner/repo'],
  ])('reads %s', async (remote, expected) => {
    expect(await parseGitHubRemote(remote)).toBe(expected);
  });

  it.each([
    'https://gitlab.com/owner/repo.git',
    'https://github.com.evil.example/owner/repo',
    'https://github.com/owner/repo/extra',
    'git@github.com:../etc/passwd',
    'git@github.com:../x',
    'https://github.com/owner/..',
    'https://github.com/./repo.git',
    '',
  ])('rejects %s', async (remote) => {
    expect(await parseGitHubRemote(remote)).toBeNull();
  });
});

describe('readGitHubRepository', () => {
  it('maps open pulls and issues into slim, github.com-only items', async () => {
    const edges = seams();
    const view = await readGitHubRepository('/project', { seams: edges });
    expect(view).toMatchObject({
      status: 'ok',
      projectRoot: '/project',
      repository: 'WrongStack/WrongStack',
      tokenSource: 'gh',
      truncated: { pulls: true, issues: false },
    });
    expect(view.pulls).toEqual([
      {
        number: 12,
        title: 'Add GitHub view',
        url: 'https://github.com/WrongStack/WrongStack/pull/12',
        author: 'octocat',
        labels: [
          { name: 'feature', color: '0e8a16' },
          { name: 'bad-color', color: '' },
        ],
        comments: 3,
        createdAt: '2026-11-20T10:00:00Z',
        updatedAt: '2026-11-26T10:00:00Z',
        draft: true,
        headRef: 'feat/github',
        baseRef: 'main',
      },
    ]);
    // Pull requests listed by the issues endpoint are not issues.
    expect(view.issues.map((item) => item.number)).toEqual([7]);
    expect(view.issues[0]).toMatchObject({
      author: null,
      url: 'https://github.com/WrongStack/WrongStack/issues/7',
    });
    const [url, init] = (edges.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/api\.github\.com\/repos\/WrongStack\/WrongStack\//);
    expect((init as RequestInit).redirect).toBe('manual');
    expect((init as { headers: Record<string, string> }).headers['Authorization']).toBe(
      'Bearer secret-token',
    );
  });

  it('sends no Authorization header without a token', async () => {
    const edges = seams({ resolveToken: vi.fn(async () => null) });
    const view = await readGitHubRepository('/project', { seams: edges });
    expect(view.tokenSource).toBe('none');
    const [, init] = (edges.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers).not.toHaveProperty(
      'Authorization',
    );
  });

  it('reports a project without a remote or with a non-GitHub remote', async () => {
    const none = seams({ readRemote: vi.fn(async () => '') });
    expect((await readGitHubRepository('/p', { seams: none })).status).toBe('no-remote');
    expect(none.fetch).not.toHaveBeenCalled();
    const other = seams({ readRemote: vi.fn(async () => 'https://gitlab.com/a/b.git') });
    expect(await readGitHubRepository('/p', { seams: other })).toMatchObject({
      status: 'not-github',
      repository: null,
    });
    expect(other.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [404, {}, false, 'needs-auth'],
    [404, {}, true, 'not-found'],
    [401, {}, true, 'needs-auth'],
    [403, { 'x-ratelimit-remaining': '0' }, false, 'rate-limited'],
    [429, {}, true, 'rate-limited'],
    [502, {}, true, 'unavailable'],
  ] as const)('maps HTTP %i to a typed state', async (status, headers, withToken, expected) => {
    const view = await readGitHubRepository('/p', {
      seams: seams({
        resolveToken: vi.fn(async () =>
          withToken ? { token: 't', source: 'env' as const } : null,
        ),
        fetch: vi.fn(async () =>
          json({ message: 'no' }, { status, headers }),
        ) as unknown as typeof fetch,
      }),
    });
    expect(view).toMatchObject({ status: expected, pulls: [], issues: [] });
  });

  it('treats a repository with issues turned off as having none', async () => {
    const view = await readGitHubRepository('/p', {
      seams: seams({
        fetch: vi.fn(async (input: RequestInfo | URL) =>
          String(input).includes('/pulls?')
            ? json([pull])
            : json({ message: 'Issues are disabled' }, { status: 410 }),
        ) as unknown as typeof fetch,
      }),
    });
    expect(view).toMatchObject({ status: 'ok', issues: [] });
    expect(view.pulls.map((item) => item.number)).toEqual([12]);
  });

  it('follows a renamed repository only to another api.github.com URL', async () => {
    const moved = 'https://api.github.com/repositories/99/pulls?state=open';
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/repos/'))
        return new Response(null, { status: 301, headers: { location: moved } });
      return json(url.includes('/pulls') ? [pull] : []);
    });
    const view = await readGitHubRepository('/p', {
      seams: seams({ fetch: fetcher as unknown as typeof fetch }),
    });
    expect(view.status).toBe('ok');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toContain(moved);

    const leak = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith('https://api.github.com/')
        ? new Response(null, { status: 301, headers: { location: 'https://evil.example/x' } })
        : json([]),
    );
    const refused = await readGitHubRepository('/p', {
      seams: seams({ fetch: leak as unknown as typeof fetch }),
    });
    expect(refused.status).toBe('unavailable');
    expect(
      leak.mock.calls.every(([url]) => String(url).startsWith('https://api.github.com/')),
    ).toBe(true);
  });

  it('reports a network failure as unavailable', async () => {
    const view = await readGitHubRepository('/p', {
      seams: seams({
        fetch: vi.fn(async () => {
          throw new TypeError('fetch failed');
        }) as unknown as typeof fetch,
      }),
    });
    expect(view.status).toBe('unavailable');
  });
});

describe('GET /api/github', () => {
  beforeEach(() => getSession.mockReset());

  async function call(
    query: string,
    deps: Record<string, unknown>,
    { method = 'GET', authorized = true } = {},
  ) {
    let status = 0;
    let body: Record<string, unknown> = {};
    const res = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (text: string) => {
        body = JSON.parse(text);
      },
    } as unknown as ServerResponse;
    const handled = await handleApiRoutes(
      { method } as IncomingMessage,
      res,
      new URL(`http://localhost/api/github${query}`),
      deps as never,
      true,
      authorized,
      vi.fn(),
    );
    return { status, body, handled };
  }

  it('requires the access token and GET', async () => {
    expect((await call('', { projectRoot: '/p' }, { authorized: false })).status).toBe(401);
    expect((await call('', { projectRoot: '/p' }, { method: 'POST' })).status).toBe(405);
  });

  it("reads the session's project, never a client-supplied repository", async () => {
    const edges = seams();
    const { status, body } = await call('?sessionId=s1&repository=evil/repo&path=/etc', {
      projectRoot: '/host',
      getSessionProjectRoot: (id: string) => (id === 's1' ? '/session-project' : undefined),
      github: edges,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      projectRoot: '/session-project',
      repository: 'WrongStack/WrongStack',
    });
    expect(edges.readRemote).toHaveBeenCalledWith('/session-project');
  });

  it('refuses an unknown session instead of falling back to the host project', async () => {
    getSession.mockResolvedValue(undefined);
    const edges = seams();
    const { status } = await call('?sessionId=missing', {
      projectRoot: '/host',
      globalRoot: '/global',
      github: edges,
    });
    expect(status).toBe(404);
    expect(edges.readRemote).not.toHaveBeenCalled();
  });
});
