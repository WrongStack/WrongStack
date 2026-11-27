import type { IncomingMessage, ServerResponse } from 'node:http';
import { sanitizeApiError } from '@wrongstack/core/security';
import type {
  GitHubRepositoryStatus,
  GitHubRepositoryView,
  GitHubTokenSource,
} from '@wrongstack/webui-protocol';
import {
  defaultGitHubSeams,
  type GitHubDeps,
  type GitHubSeams,
  GitHubStatusError,
  type GitHubToken,
  githubApi,
  replyJson,
  resolveRepository,
  resolveRequestProject,
  toIssue,
  toPull,
} from './github-client.js';
import { handleGitHubAction, handleGitHubItemRead } from './github-item-handlers.js';

/**
 * Read-only list of the active session's project repository, plus the single
 * entry point for every `/api/github*` route.
 */

const PAGE_SIZE = 50;
const VIEW_TTL_MS = 30_000;

const viewCache = new Map<string, { view: GitHubRepositoryView; until: number }>();

/** Drop cached lists of a repository after a write changed it. */
export function invalidateGitHubView(repository: string): void {
  const prefix = `${repository.toLowerCase()}\u0000`;
  for (const key of viewCache.keys()) if (key.startsWith(prefix)) viewCache.delete(key);
}

async function listOpen(
  seams: GitHubSeams,
  repository: string,
  kind: 'pulls' | 'issues',
  token: GitHubToken | null,
): Promise<{ items: unknown[]; truncated: boolean }> {
  const result = await githubApi(
    seams,
    token,
    `repos/${repository}/${kind}?state=open&sort=updated&direction=desc&per_page=${PAGE_SIZE}`,
    // Repositories with issues turned off (most forks) answer 410 Gone.
    kind === 'issues' ? { allow: [410] } : {},
  );
  if (result.httpStatus === 410) return { items: [], truncated: false };
  if (!Array.isArray(result.data)) throw new GitHubStatusError('unavailable');
  return {
    items: result.data,
    truncated: /rel="next"/.test(result.headers.get('link') ?? ''),
  };
}

async function readGitHubRepository(
  projectRoot: string,
  options: { refresh?: boolean; seams?: GitHubSeams | undefined } = {},
): Promise<GitHubRepositoryView> {
  const seams = options.seams ?? defaultGitHubSeams;
  const empty = (
    status: GitHubRepositoryStatus,
    repository: string | null,
    tokenSource: GitHubTokenSource,
  ): GitHubRepositoryView => ({
    status,
    projectRoot,
    repository,
    tokenSource,
    pulls: [],
    issues: [],
    truncated: { pulls: false, issues: false },
    fetchedAt: new Date(seams.now()).toISOString(),
  });
  const target = await resolveRepository(seams, projectRoot);
  if (target.status !== 'ok') return empty(target.status, null, 'none');
  const { repository, token } = target;
  const tokenSource: GitHubTokenSource = token?.source ?? 'none';
  const key = `${repository.toLowerCase()}\u0000${tokenSource}`;
  const cached = options.seams ? undefined : viewCache.get(key);
  if (!options.refresh && cached && cached.until > seams.now())
    return { ...cached.view, projectRoot };
  try {
    const [pulls, issues] = await Promise.all([
      listOpen(seams, repository, 'pulls', token),
      listOpen(seams, repository, 'issues', token),
    ]);
    const view: GitHubRepositoryView = {
      ...empty('ok', repository, tokenSource),
      pulls: pulls.items.flatMap((raw) => toPull(raw, repository) ?? []),
      issues: issues.items.flatMap((raw) => toIssue(raw, repository) ?? []),
      truncated: { pulls: pulls.truncated, issues: issues.truncated },
    };
    if (!options.seams) {
      if (viewCache.size >= 32) viewCache.delete(viewCache.keys().next().value!);
      viewCache.set(key, { view, until: seams.now() + VIEW_TTL_MS });
    }
    return view;
  } catch (error) {
    if (error instanceof GitHubStatusError) return empty(error.status, repository, tokenSource);
    throw error;
  }
}

/** `GET /api/github?sessionId=…[&refresh=1]` — open pull requests and issues. */
async function handleGitHubRepositoryRead(
  res: ServerResponse,
  url: URL,
  deps: GitHubDeps,
): Promise<void> {
  const projectRoot = await resolveRequestProject(res, url, deps);
  if (!projectRoot) return;
  replyJson(
    res,
    200,
    await readGitHubRepository(projectRoot, {
      refresh: url.searchParams.get('refresh') === '1',
      seams: deps.github,
    }),
  );
}

/**
 * Every `/api/github*` route. Returns false for paths it does not own.
 *  - `GET  /api/github`         open pull requests and issues
 *  - `GET  /api/github/item`    one pull request or issue (`kind`, `number`)
 *  - `POST /api/github/action`  comment, review, merge, close or reopen
 */
export async function handleGitHubRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: GitHubDeps,
  auth: { requireAccessToken: boolean; accessTokenOk: boolean },
): Promise<boolean> {
  const routes: Record<string, 'GET' | 'POST'> = {
    '/api/github': 'GET',
    '/api/github/item': 'GET',
    '/api/github/action': 'POST',
  };
  const method = routes[url.pathname];
  if (!method) return false;
  if (auth.requireAccessToken && !auth.accessTokenOk) {
    replyJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  if (req.method !== method) {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: method });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return true;
  }
  try {
    if (url.pathname === '/api/github') await handleGitHubRepositoryRead(res, url, deps);
    else if (url.pathname === '/api/github/item') await handleGitHubItemRead(res, url, deps);
    else await handleGitHubAction(req, res, url, deps, invalidateGitHubView);
  } catch (error) {
    if (!res.headersSent) replyJson(res, 500, { error: sanitizeApiError(error) });
  }
  return true;
}
