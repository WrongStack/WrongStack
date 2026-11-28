import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { GitHubCreateContext, GitHubCreateResult } from '@wrongstack/webui-protocol';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubLocalBranch, GitHubSeams } from '../src/server/github-client.js';
import { handleGitHubRoutes } from '../src/server/github-handlers.js';

const API = 'https://api.github.com/repos/octo/repo';
const LOCAL = 'a'.repeat(40);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Route = (url: string, init: RequestInit) => Response | undefined;

function seams(
  route: Route,
  branch: Partial<GitHubLocalBranch> = {},
  remote = 'https://github.com/octo/repo.git',
) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const reply = route(String(input), init ?? {});
    if (!reply) throw new Error(`unexpected ${init?.method ?? 'GET'} ${String(input)}`);
    return reply;
  });
  return {
    readRemote: vi.fn(async () => remote),
    readBranch: vi.fn(async () => ({
      name: 'feat/new-view',
      head: LOCAL,
      subject: 'Add the new view',
      ...branch,
    })),
    resolveToken: vi.fn(async () => ({ token: 'tkn', source: 'gh' as const })),
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => 0,
  } satisfies GitHubSeams;
}

async function call(
  path: string,
  github: GitHubSeams,
  options: { method?: string; body?: unknown; origin?: boolean; accessTokenOk?: boolean } = {},
) {
  const method = options.method ?? 'GET';
  const req = Readable.from(
    options.body === undefined ? [] : [JSON.stringify(options.body)],
  ) as unknown as IncomingMessage;
  Object.assign(req, {
    method,
    headers:
      method === 'POST'
        ? {
            ...(options.origin === false ? {} : { origin: 'http://127.0.0.1:3000' }),
            'content-type': 'application/json',
          }
        : {},
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
  await handleGitHubRoutes(
    req,
    res,
    new URL(`http://localhost${path}`),
    { projectRoot: '/project', github },
    { requireAccessToken: false, accessTokenOk: options.accessTokenOk ?? false },
  );
  return { status, body };
}

const calls = (github: GitHubSeams) =>
  (github.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
    (entry) => `${(entry[1] as RequestInit).method} ${String(entry[0])}`,
  );

/** A repository whose default branch is main, with the given ref and open pulls. */
function repoRoutes(ref: Response, pulls: unknown[] = []): Route {
  return (url) => {
    if (url === API) return json({ default_branch: 'main' });
    if (url.startsWith(`${API}/git/ref/heads/`)) return ref.clone();
    if (url.startsWith(`${API}/pulls?`)) return json(pulls);
    return undefined;
  };
}

describe('GET /api/github/create-context', () => {
  it('reports a pushed branch with its open pull request', async () => {
    const github = seams(
      repoRoutes(json({ object: { sha: LOCAL } }), [
        { number: 77, title: 'Add the new view', html_url: 'https://evil.example/x' },
      ]),
    );
    const { body } = await call('/api/github/create-context', github);
    expect(calls(github)).toEqual([
      `GET ${API}`,
      `GET ${API}/git/ref/heads/feat/new-view`,
      `GET ${API}/pulls?state=open&head=octo%3Afeat%2Fnew-view&per_page=1`,
    ]);
    expect(body).toEqual({
      status: 'ok',
      repository: 'octo/repo',
      tokenSource: 'gh',
      defaultBranch: 'main',
      branch: {
        name: 'feat/new-view',
        state: 'ready',
        subject: 'Add the new view',
        // The URL is rebuilt from the repository, never taken from GitHub.
        openPull: {
          number: 77,
          title: 'Add the new view',
          url: 'https://github.com/octo/repo/pull/77',
        },
      },
    } satisfies GitHubCreateContext);
  });

  it('tells a branch GitHub does not have from one at another commit', async () => {
    const missing = seams(repoRoutes(json({ message: 'Not Found' }, 404)));
    expect(
      ((await call('/api/github/create-context', missing)).body as GitHubCreateContext).branch,
    ).toMatchObject({ state: 'not-pushed', openPull: null });
    expect(calls(missing)).toHaveLength(2);

    const moved = seams(repoRoutes(json({ object: { sha: 'b'.repeat(40) } })));
    expect(
      ((await call('/api/github/create-context', moved)).body as GitHubCreateContext).branch,
    ).toMatchObject({ state: 'out-of-sync' });
  });

  it.each([
    [{ name: null }, 'detached'],
    [{ name: 'main' }, 'default'],
    [{ name: '-x' }, 'unsupported'],
    [{ name: 'feat/../main' }, 'unsupported'],
    [{ name: 'feat/x.lock' }, 'unsupported'],
  ] as const)('reads only the repository for a %j checkout', async (branch, state) => {
    const github = seams(repoRoutes(json({})), branch);
    const { body } = await call('/api/github/create-context', github);
    expect((body as GitHubCreateContext).branch?.state).toBe(state);
    expect(calls(github)).toEqual([`GET ${API}`]);
  });

  it('explains a project that is not on GitHub', async () => {
    const github = seams(() => undefined, {}, 'https://gitlab.com/a/b.git');
    const { body } = await call('/api/github/create-context', github);
    expect(body).toMatchObject({ status: 'not-github', branch: null });
    expect(github.fetch).not.toHaveBeenCalled();
  });
});

describe('POST /api/github/create', () => {
  const created = (number: number) => json({ number, html_url: 'https://evil.example/' }, 201);

  it('opens an issue and answers its github.com URL', async () => {
    const github = seams((url, init) =>
      url === `${API}/issues` && init.method === 'POST' ? created(31) : undefined,
    );
    const { body } = await call('/api/github/create', github, {
      method: 'POST',
      body: { kind: 'issue', title: '  Crash on start  ', body: 'Steps to reproduce' },
    });
    expect(body).toEqual({
      ok: true,
      status: 'done',
      item: { kind: 'issue', number: 31, url: 'https://github.com/octo/repo/issues/31' },
    } satisfies GitHubCreateResult);
    const [, init] = (github.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      title: 'Crash on start',
      body: 'Steps to reproduce',
    });
  });

  it('opens a pull request from the checked-out branch', async () => {
    const github = seams((url, init) =>
      url === `${API}/pulls` && init.method === 'POST' ? created(78) : undefined,
    );
    const { body } = await call('/api/github/create', github, {
      method: 'POST',
      accessTokenOk: true,
      origin: false,
      body: {
        kind: 'pull',
        title: 'Add the new view',
        base: 'main',
        head: 'feat/new-view',
        draft: true,
      },
    });
    expect(body).toMatchObject({
      ok: true,
      item: { kind: 'pull', number: 78, url: 'https://github.com/octo/repo/pull/78' },
    });
    const [, init] = (github.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      title: 'Add the new view',
      head: 'feat/new-view',
      base: 'main',
      body: '',
      draft: true,
    });
  });

  it('refuses when another branch is checked out than the form showed', async () => {
    const github = seams(() => undefined, { name: 'other' });
    const { body } = await call('/api/github/create', github, {
      method: 'POST',
      body: { kind: 'pull', title: 'T', base: 'main', head: 'feat/new-view' },
    });
    expect(body).toEqual({ ok: false, status: 'conflict' });
    expect(github.fetch).not.toHaveBeenCalled();
  });

  it("passes on GitHub's reason a pull request was refused", async () => {
    const github = seams(() =>
      json(
        {
          message: 'Validation Failed',
          errors: [{ message: 'A pull request already exists for octo:feat/new-view.' }],
        },
        422,
      ),
    );
    const { body } = await call('/api/github/create', github, {
      method: 'POST',
      body: { kind: 'pull', title: 'T', base: 'main', head: 'feat/new-view' },
    });
    expect(body).toEqual({
      ok: false,
      status: 'rejected',
      message: 'Validation Failed: A pull request already exists for octo:feat/new-view.',
    });
  });

  it('refuses a write with neither an Origin nor the access token', async () => {
    const github = seams(() => created(1));
    const { status } = await call('/api/github/create', github, {
      method: 'POST',
      origin: false,
      body: { kind: 'issue', title: 'T' },
    });
    expect(status).toBe(403);
    expect(github.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'discussion', title: 'T' },
    { kind: 'issue', title: '   ' },
    { kind: 'issue', title: 'two\nlines' },
    { kind: 'issue', title: 'x'.repeat(257) },
    { kind: 'issue', title: 'T', body: 5 },
    { kind: 'pull', title: 'T', head: 'feat/new-view' },
    { kind: 'pull', title: 'T', base: 'main' },
    { kind: 'pull', title: 'T', base: '../main', head: 'feat/new-view' },
    { kind: 'pull', title: 'T', base: 'main', head: 'feat/new-view', draft: 'yes' },
  ])('refuses %j before calling GitHub', async (request) => {
    const github = seams(() => created(1));
    const { status } = await call('/api/github/create', github, { method: 'POST', body: request });
    expect(status).toBe(400);
    expect(github.fetch).not.toHaveBeenCalled();
  });
});
