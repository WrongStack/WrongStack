import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { GitHubActionResult, GitHubItemDetailView } from '@wrongstack/webui-protocol';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubSeams } from '../src/server/github-client.js';
import { handleGitHubRoutes } from '../src/server/github-handlers.js';

const SHA = 'a'.repeat(40);

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type Route = (url: string, init: RequestInit) => Response | undefined;

function seams(route: Route, token: boolean = true) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const reply = route(String(input), init ?? {});
    if (!reply) throw new Error(`unexpected ${init?.method ?? 'GET'} ${String(input)}`);
    return reply;
  });
  return {
    readRemote: vi.fn(async () => 'https://github.com/octo/repo.git'),
    resolveToken: vi.fn(async () => (token ? { token: 'tkn', source: 'env' as const } : null)),
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => 0,
  } satisfies GitHubSeams;
}

async function call(
  path: string,
  github: GitHubSeams,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const method = options.method ?? 'GET';
  const req = Readable.from(
    options.body === undefined ? [] : [JSON.stringify(options.body)],
  ) as unknown as IncomingMessage;
  Object.assign(req, {
    method,
    headers: {
      ...(method === 'POST'
        ? { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }
        : {}),
      ...options.headers,
    },
  });
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
  const handled = await handleGitHubRoutes(
    req,
    res,
    new URL(`http://localhost${path}`),
    { projectRoot: '/project', github },
    { requireAccessToken: false, accessTokenOk: false },
  );
  return { handled, status, body };
}

const pullRaw = {
  number: 5,
  title: 'Speed up boot',
  state: 'open',
  body: 'Please review.',
  user: { login: 'contributor' },
  labels: [],
  comments: 1,
  created_at: '2026-11-20T00:00:00Z',
  updated_at: '2026-11-21T00:00:00Z',
  draft: false,
  merged: false,
  mergeable: null,
  mergeable_state: 'unknown',
  head: { ref: 'boot', sha: SHA, repo: { full_name: 'contributor/repo' } },
  base: { ref: 'main', repo: { full_name: 'octo/repo' } },
  additions: 10,
  deletions: 2,
  changed_files: 1,
};

function pullRoutes(overrides: Record<string, () => Response> = {}): Route {
  return (url) => {
    const path = url.replace('https://api.github.com/repos/octo/repo/', '');
    for (const [prefix, reply] of Object.entries(overrides))
      if (path.startsWith(prefix)) return reply();
    if (path === 'pulls/5') return json(pullRaw);
    if (path.startsWith('pulls/5/files'))
      return json([
        {
          filename: 'src/boot.ts',
          status: 'modified',
          additions: 10,
          deletions: 2,
          patch: '@@ -1,2 +1,2 @@\n-old\n+new\n ctx',
        },
        { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
      ]);
    if (path.startsWith(`commits/${SHA}/check-runs`))
      return json({
        check_runs: [
          {
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/octo/repo/runs/1',
          },
          {
            name: 'external',
            status: 'queued',
            conclusion: null,
            html_url: 'https://ci.example/x',
          },
        ],
      });
    if (path === `commits/${SHA}/status`)
      return json({ statuses: [{ context: 'legacy', state: 'pending', target_url: null }] });
    if (path.startsWith('pulls/5/reviews'))
      return json([
        {
          user: { login: 'maintainer' },
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-11-21T01:00:00Z',
          body: 'Fix the test',
        },
        { user: { login: 'draft' }, state: 'PENDING', submitted_at: '', body: '' },
      ]);
    return undefined;
  };
}

describe('GET /api/github/item', () => {
  it('reads a pull request with its files, checks and reviews', async () => {
    const { status, body } = await call('/api/github/item?kind=pull&number=5', seams(pullRoutes()));
    expect(status).toBe(200);
    const view = body as GitHubItemDetailView;
    expect(view).toMatchObject({ status: 'ok', repository: 'octo/repo', tokenSource: 'env' });
    expect(view.item).toMatchObject({
      kind: 'pull',
      number: 5,
      state: 'open',
      body: 'Please review.',
      url: 'https://github.com/octo/repo/pull/5',
    });
    expect(view.item?.pull).toMatchObject({
      mergeable: null,
      headSha: SHA,
      fromFork: true,
      files: [
        {
          path: 'src/boot.ts',
          status: 'modified',
          additions: 10,
          deletions: 2,
          patch: '@@ -1,2 +1,2 @@\n-old\n+new\n ctx',
          patchTruncated: false,
        },
        {
          path: 'logo.png',
          status: 'added',
          additions: 0,
          deletions: 0,
          patch: null,
          patchTruncated: false,
        },
      ],
      checks: [
        {
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          url: 'https://github.com/octo/repo/runs/1',
        },
        { name: 'external', status: 'queued', conclusion: null, url: null },
        { name: 'legacy', status: 'in_progress', conclusion: null, url: null },
      ],
      reviews: [
        {
          author: 'maintainer',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-11-21T01:00:00Z',
          body: 'Fix the test',
        },
      ],
    });
  });

  it('caps patches on a line end under one shared budget', async () => {
    const line = `+${'x'.repeat(99)}\n`;
    const big = `@@ -0,0 +1,700 @@\n${line.repeat(700)}`;
    const files = Array.from({ length: 9 }, (_, index) => ({
      filename: `f${index}.ts`,
      status: 'added',
      additions: 700,
      deletions: 0,
      patch: big,
    }));
    const { body } = await call(
      '/api/github/item?kind=pull&number=5',
      seams(pullRoutes({ 'pulls/5/files': () => json(files) })),
    );
    const got = (body as GitHubItemDetailView).item?.pull?.files ?? [];
    expect(got).toHaveLength(9);
    for (const file of got.filter((item) => item.patch !== null)) {
      expect(file.patch!.length).toBeLessThanOrEqual(60_000);
      expect(file.patch!.endsWith('\n')).toBe(true);
      expect(file.patchTruncated).toBe(true);
    }
    const total = got.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(400_000);
    expect(got.at(-1)).toMatchObject({ patch: null, patchTruncated: true });
  });

  it('keeps the rest of the pane when one part fails', async () => {
    const { body } = await call(
      '/api/github/item?kind=pull&number=5',
      seams(pullRoutes({ 'pulls/5/files': () => json({ message: 'boom' }, 500) })),
    );
    const pull = (body as GitHubItemDetailView).item?.pull;
    expect(pull?.files).toBeNull();
    expect(pull?.reviews).toHaveLength(1);
  });

  it('reads an issue without pull parts', async () => {
    const github = seams((url) =>
      url.endsWith('/repos/octo/repo/issues/9')
        ? json({ ...pullRaw, number: 9, state: 'closed' })
        : undefined,
    );
    const { body } = await call('/api/github/item?kind=issue&number=9', github);
    expect((body as GitHubItemDetailView).item).toMatchObject({
      kind: 'issue',
      state: 'closed',
      pull: null,
      url: 'https://github.com/octo/repo/issues/9',
    });
  });

  it('reports a missing item as a typed state', async () => {
    const { body } = await call(
      '/api/github/item?kind=pull&number=5',
      seams(() => json({ message: 'Not Found' }, 404)),
    );
    expect(body).toMatchObject({ status: 'not-found', item: null });
  });

  it.each(['kind=pull&number=0', 'kind=pull&number=abc', 'kind=commit&number=5', 'kind=pull'])(
    'rejects %s',
    async (query) => {
      const github = seams(() => undefined);
      expect((await call(`/api/github/item?${query}`, github)).status).toBe(400);
      expect(github.fetch).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/github/action', () => {
  const merge = {
    kind: 'pull',
    number: 5,
    action: 'merge',
    mergeMethod: 'squash',
    expectedHeadSha: SHA,
  };

  it('merges with the head SHA the user saw', async () => {
    const github = seams((url, init) =>
      url === 'https://api.github.com/repos/octo/repo/pulls/5/merge' && init.method === 'PUT'
        ? json({ merged: true })
        : undefined,
    );
    const { status, body } = await call('/api/github/action', github, {
      method: 'POST',
      body: merge,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, status: 'done' });
    const [, init] = (github.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      merge_method: 'squash',
      sha: SHA,
    });
    expect((init as { headers: Record<string, string> }).headers['Authorization']).toBe(
      'Bearer tkn',
    );
  });

  it.each([
    [
      { kind: 'pull', number: 5, action: 'comment', body: 'Looks good' },
      'POST',
      'issues/5/comments',
      { body: 'Looks good' },
    ],
    [
      { kind: 'pull', number: 5, action: 'approve', expectedHeadSha: SHA },
      'POST',
      'pulls/5/reviews',
      { event: 'APPROVE', commit_id: SHA },
    ],
    [
      {
        kind: 'pull',
        number: 5,
        action: 'request-changes',
        body: 'Add a test',
        expectedHeadSha: SHA,
      },
      'POST',
      'pulls/5/reviews',
      { event: 'REQUEST_CHANGES', commit_id: SHA, body: 'Add a test' },
    ],
    [{ kind: 'pull', number: 5, action: 'close' }, 'PATCH', 'pulls/5', { state: 'closed' }],
    [{ kind: 'issue', number: 9, action: 'reopen' }, 'PATCH', 'issues/9', { state: 'open' }],
  ])('sends %j as one GitHub call', async (request, method, path, payload) => {
    const github = seams(() => json({}));
    const { body } = await call('/api/github/action', github, { method: 'POST', body: request });
    expect(body).toEqual({ ok: true, status: 'done' });
    const calls = (github.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(String(calls[0]![0])).toBe(`https://api.github.com/repos/octo/repo/${path}`);
    expect((calls[0]![1] as RequestInit).method).toBe(method);
    expect(JSON.parse(String((calls[0]![1] as RequestInit).body))).toEqual(payload);
  });

  it.each([
    [409, 'conflict', 'Head branch was modified. Review and try the merge again.'],
    [405, 'rejected', 'Pull Request is not mergeable'],
    [422, 'rejected', 'Can not approve your own pull request'],
  ] as const)("maps HTTP %i to %s with GitHub's message", async (code, expected, message) => {
    const github = seams(() => json({ message }, code));
    const { body } = await call('/api/github/action', github, { method: 'POST', body: merge });
    expect(body).toEqual({ ok: false, status: expected, message } satisfies GitHubActionResult);
  });

  it('re-runs only the failed Actions runs of this repository on the given head', async () => {
    const github = seams((url, init) => {
      if (url.endsWith('/repos/octo/repo/pulls/5')) return json(pullRaw);
      if (url.endsWith(`/commits/${SHA}/check-runs?per_page=100`))
        return json({
          check_runs: [
            {
              conclusion: 'failure',
              html_url: 'https://github.com/octo/repo/actions/runs/11/job/1',
            },
            {
              conclusion: 'timed_out',
              html_url: 'https://github.com/octo/repo/actions/runs/11/job/2',
            },
            {
              conclusion: 'cancelled',
              html_url: 'https://github.com/octo/repo/actions/runs/12/job/3',
            },
            {
              conclusion: 'success',
              html_url: 'https://github.com/octo/repo/actions/runs/13/job/4',
            },
            {
              conclusion: 'failure',
              html_url: 'https://github.com/evil/repo/actions/runs/99/job/5',
            },
            { conclusion: 'failure', html_url: 'https://ci.example/build/7' },
          ],
        });
      if (init.method === 'POST' && /\/actions\/runs\/\d+\/rerun-failed-jobs$/.test(url))
        return json(null, 201);
      return undefined;
    });
    const { body } = await call('/api/github/action', github, {
      method: 'POST',
      body: { kind: 'pull', number: 5, action: 'rerun-failed', expectedHeadSha: SHA },
    });
    expect(body).toEqual({ ok: true, status: 'done' });
    const posts = (github.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([, init]) => (init as RequestInit).method === 'POST')
      .map(([url]) => String(url));
    expect(posts).toEqual([
      'https://api.github.com/repos/octo/repo/actions/runs/11/rerun-failed-jobs',
      'https://api.github.com/repos/octo/repo/actions/runs/12/rerun-failed-jobs',
    ]);
  });

  it('refuses to re-run when the branch moved since the pane loaded', async () => {
    const github = seams((url) =>
      url.endsWith('/repos/octo/repo/pulls/5')
        ? json({ ...pullRaw, head: { ...pullRaw.head, sha: 'f'.repeat(40) } })
        : undefined,
    );
    const { body } = await call('/api/github/action', github, {
      method: 'POST',
      body: { kind: 'pull', number: 5, action: 'rerun-failed', expectedHeadSha: SHA },
    });
    expect(body).toEqual({ ok: false, status: 'conflict' });
    expect(github.fetch).toHaveBeenCalledTimes(1);
  });

  it('reads only the item itself for parts=none', async () => {
    const github = seams(pullRoutes());
    const { body } = await call('/api/github/item?kind=pull&number=5&parts=none', github);
    expect((body as GitHubItemDetailView).item).toMatchObject({ number: 5, pull: null });
    expect(github.fetch).toHaveBeenCalledTimes(1);
  });

  it('says when there is nothing to re-run', async () => {
    const github = seams((url) =>
      url.endsWith('/repos/octo/repo/pulls/5')
        ? json(pullRaw)
        : json({ check_runs: [{ conclusion: 'success', html_url: null }] }),
    );
    const { body } = await call('/api/github/action', github, {
      method: 'POST',
      body: { kind: 'pull', number: 5, action: 'rerun-failed', expectedHeadSha: SHA },
    });
    expect(body).toEqual({ ok: false, status: 'nothing-to-do' });
  });

  it('does not follow a redirect on a write', async () => {
    const github = seams(() =>
      json(null, 307, { location: 'https://api.github.com/repositories/1/pulls/5/merge' }),
    );
    const { body } = await call('/api/github/action', github, { method: 'POST', body: merge });
    expect(body).toMatchObject({ ok: false, status: 'unavailable' });
    expect(github.fetch).toHaveBeenCalledTimes(1);
  });

  it('needs a token', async () => {
    const github = seams(() => undefined, false);
    const { body } = await call('/api/github/action', github, { method: 'POST', body: merge });
    expect(body).toEqual({ ok: false, status: 'needs-auth' });
    expect(github.fetch).not.toHaveBeenCalled();
  });

  it('only accepts writes from the page', async () => {
    const github = seams(() => json({}));
    const noOrigin = await call('/api/github/action', github, {
      method: 'POST',
      body: merge,
      headers: { origin: '' },
    });
    expect(noOrigin.status).toBe(403);
    const plain = await call('/api/github/action', github, {
      method: 'POST',
      body: merge,
      headers: { 'content-type': 'text/plain' },
    });
    expect(plain.status).toBe(400);
    expect(github.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...merge, expectedHeadSha: undefined },
    { ...merge, expectedHeadSha: 'main' },
    { ...merge, kind: 'issue' },
    { ...merge, mergeMethod: 'fast-forward' },
    { kind: 'pull', number: 5, action: 'comment', body: '   ' },
    { kind: 'pull', number: 5, action: 'request-changes', expectedHeadSha: SHA },
    { kind: 'pull', number: 5, action: 'delete-branch' },
    { kind: 'pull', number: -1, action: 'close' },
    { kind: 'pull', number: 5, action: 'rerun-failed' },
    { kind: 'issue', number: 5, action: 'rerun-failed', expectedHeadSha: SHA },
  ])('rejects %j before calling GitHub', async (request) => {
    const github = seams(() => json({}));
    const { status } = await call('/api/github/action', github, { method: 'POST', body: request });
    expect(status).toBe(400);
    expect(github.fetch).not.toHaveBeenCalled();
  });

  it('pins each route to its method', async () => {
    const github = seams(() => json({}));
    expect((await call('/api/github/action', github)).status).toBe(405);
    expect(
      (await call('/api/github/item?kind=pull&number=5', github, { method: 'POST', body: {} }))
        .status,
    ).toBe(405);
    expect((await call('/api/github/elsewhere', github)).handled).toBe(false);
  });
});
