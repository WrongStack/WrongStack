import type { ServerResponse } from 'node:http';
import { getSessionRegistry } from '@wrongstack/core/storage';
import { buildChildEnv } from '@wrongstack/core/utils';
import type {
  GitHubIssueSummary,
  GitHubLabel,
  GitHubPullSummary,
  GitHubRepositoryStatus,
  GitHubTokenSource,
} from '@wrongstack/webui-protocol';
import { makeGit } from './git-history.js';
import { decodeSessionId } from './http-server/security-helpers.js';

/**
 * Shared edges of the WebUI GitHub panel: which repository a project talks to
 * (always its own git remote), which token (env, else the `gh` CLI login), and
 * a fetch that only ever reaches api.github.com. Tokens never leave this
 * process, and URLs shown to the user are rebuilt from `owner/repo` + number.
 */

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RESPONSE_CAP = 8 * 1024 * 1024;
const TOKEN_TTL_MS = 5 * 60_000;
const MISSING_TOKEN_TTL_MS = 60_000;
export const API_ORIGIN = 'https://api.github.com/';
const REDIRECTS = [301, 302, 307, 308];

export interface GitHubToken {
  token: string;
  source: Exclude<GitHubTokenSource, 'none'>;
}

/** Injectable edges, so tests never spawn git/gh or reach GitHub. */
export interface GitHubSeams {
  readRemote(projectRoot: string): Promise<string>;
  resolveToken(): Promise<GitHubToken | null>;
  fetch: typeof fetch;
  now(): number;
}

export interface GitHubDeps {
  projectRoot?: string | undefined;
  globalRoot?: string | undefined;
  getSessionProjectRoot?: ((sessionId: string) => string | undefined) | undefined;
  github?: GitHubSeams | undefined;
}

/** `owner/repo` for a github.com remote in https, scp or ssh:// form; else null. */
function parseGitHubRemote(remote: string): string | null {
  const value = remote.trim();
  const match =
    /^(?:https?|git\+https|git):\/\/(?:[^@/]*@)?github\.com(?::\d+)?\/(.+)$/i.exec(value) ??
    /^ssh:\/\/(?:[^@/]*@)?github\.com(?::\d+)?\/(.+)$/i.exec(value) ??
    /^(?:[^@/\s]+@)?github\.com:(.+)$/i.exec(value);
  if (!match) return null;
  const repository = match[1]!.replace(/\/+$/, '').replace(/\.git$/i, '');
  // `.`/`..` segments would re-root the API path (`repos/../x`) with the token on it.
  if (!REPOSITORY.test(repository) || repository.split('/').some((part) => /^\.+$/.test(part)))
    return null;
  return repository;
}

async function readRemote(projectRoot: string): Promise<string> {
  const git = makeGit(projectRoot);
  const origin = (await git(['remote', 'get-url', 'origin'])).trim();
  if (origin) return origin;
  const first = (await git(['remote'])).split(/\r?\n/).find((name) => name.trim());
  return first ? (await git(['remote', 'get-url', first.trim()])).trim() : '';
}

function validToken(value: string | undefined): string | null {
  const token = value?.trim();
  return token && token.length <= 512 && !/\s/.test(token) ? token : null;
}

async function ghAuthToken(): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['auth', 'token', '--hostname', 'github.com'],
      // Filtered env: `gh` reads its own login from its config dir, and must not
      // inherit provider keys or the vault passphrase.
      { env: buildChildEnv(), timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error ? null : validToken(String(stdout))),
    );
  });
}

let tokenCache: { value: GitHubToken | null; until: number } | null = null;

async function resolveToken(): Promise<GitHubToken | null> {
  const fromEnv = validToken(process.env['GITHUB_TOKEN']) ?? validToken(process.env['GH_TOKEN']);
  if (fromEnv) return { token: fromEnv, source: 'env' };
  if (tokenCache && tokenCache.until > Date.now()) return tokenCache.value;
  const fromGh = await ghAuthToken();
  const value: GitHubToken | null = fromGh ? { token: fromGh, source: 'gh' } : null;
  tokenCache = { value, until: Date.now() + (value ? TOKEN_TTL_MS : MISSING_TOKEN_TTL_MS) };
  return value;
}

export const defaultGitHubSeams: GitHubSeams = {
  readRemote,
  resolveToken,
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

export class GitHubStatusError extends Error {
  constructor(
    readonly status: GitHubRepositoryStatus,
    readonly httpStatus = 0,
    readonly detail = '',
  ) {
    super(status);
  }
}

export function replyJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * The project a request is about: the session's own root, else the server's.
 * Replies and returns null when it cannot be resolved; never trusts a path
 * from the client and never falls back to another project for an unknown session.
 */
export async function resolveRequestProject(
  res: ServerResponse,
  url: URL,
  deps: GitHubDeps,
): Promise<string | null> {
  const sessionId = url.searchParams.get('sessionId');
  if (sessionId === null) {
    if (deps.projectRoot) return deps.projectRoot;
    replyJson(res, 400, { error: 'Project root not configured' });
    return null;
  }
  const decodedSessionId = decodeSessionId(sessionId);
  if (!decodedSessionId || sessionId.length > 200) {
    replyJson(res, 400, { error: 'Session context is unavailable' });
    return null;
  }
  const sessionRoot =
    deps.getSessionProjectRoot?.(decodedSessionId) ??
    (deps.globalRoot
      ? (await getSessionRegistry(deps.globalRoot).get(decodedSessionId))?.projectRoot
      : undefined);
  if (!sessionRoot) {
    replyJson(res, 404, { error: 'Session project not found' });
    return null;
  }
  return sessionRoot;
}

export type RepositoryTarget =
  | { status: 'ok'; repository: string; token: GitHubToken | null }
  | { status: 'no-remote' | 'not-github'; repository: null; token: null };

/** The project's GitHub repository and the token to read it with. */
export async function resolveRepository(
  seams: GitHubSeams,
  projectRoot: string,
): Promise<RepositoryTarget> {
  const remote = await seams.readRemote(projectRoot);
  if (!remote) return { status: 'no-remote', repository: null, token: null };
  const repository = parseGitHubRemote(remote);
  if (!repository) return { status: 'not-github', repository: null, token: null };
  return { status: 'ok', repository, token: await seams.resolveToken() };
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > RESPONSE_CAP) throw new GitHubStatusError('unavailable');
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function statusFor(response: Response, authenticated: boolean): GitHubRepositoryStatus {
  if (response.status === 429) return 'rate-limited';
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    return 'rate-limited';
  if (response.status === 401 || response.status === 403) return 'needs-auth';
  // GitHub answers 404 for private repositories it will not reveal.
  if (response.status === 404) return authenticated ? 'not-found' : 'needs-auth';
  return 'unavailable';
}

/** GitHub's own `message`, as capped single-paragraph plain text. */
function errorMessage(raw: string): string {
  try {
    const message = (JSON.parse(raw) as { message?: unknown }).message;
    return typeof message === 'string' ? message.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  } catch {
    return '';
  }
}

export interface ApiResult<T> {
  data: T;
  headers: Headers;
  httpStatus: number;
}

/**
 * One api.github.com call. Reads follow at most one redirect, and only to
 * another api.github.com URL (a renamed repository answers 301); writes never
 * follow one. `allow` lists non-2xx statuses returned instead of thrown.
 */
export async function githubApi<T = unknown>(
  seams: GitHubSeams,
  token: GitHubToken | null,
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH'; body?: unknown; allow?: number[] } = {},
): Promise<ApiResult<T | null>> {
  const method = options.method ?? 'GET';
  const url = `${API_ORIGIN}${path}`;
  const init: RequestInit = {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'WrongStack-WebUI',
      'X-GitHub-Api-Version': '2026-03-10',
      ...(token ? { Authorization: `Bearer ${token.token}` } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  };
  let response: Response;
  try {
    response = await seams.fetch(url, init);
    if (REDIRECTS.includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      if (method !== 'GET') throw new GitHubStatusError('unavailable', response.status);
      const location = new URL(response.headers.get('location') ?? '', url).href;
      if (!location.startsWith(API_ORIGIN)) throw new GitHubStatusError('unavailable');
      response = await seams.fetch(location, init);
      if (REDIRECTS.includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw new GitHubStatusError('unavailable');
      }
    }
  } catch (error) {
    if (error instanceof GitHubStatusError) throw error;
    throw new GitHubStatusError('unavailable');
  }
  if (!response.ok && !options.allow?.includes(response.status)) {
    const raw = await readCapped(response).catch(() => '');
    throw new GitHubStatusError(
      statusFor(response, token !== null),
      response.status,
      errorMessage(raw),
    );
  }
  if (response.status === 204 || !response.ok) {
    await response.body?.cancel().catch(() => {});
    return { data: null, headers: response.headers, httpStatus: response.status };
  }
  let data: unknown;
  try {
    const raw = await readCapped(response);
    data = raw ? JSON.parse(raw) : null;
  } catch (error) {
    if (error instanceof GitHubStatusError) throw error;
    throw new GitHubStatusError('unavailable');
  }
  return { data: data as T, headers: response.headers, httpStatus: response.status };
}

export function text(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function login(value: unknown): string | null {
  const user = value as { login?: unknown } | null | undefined;
  return typeof user?.login === 'string' ? user.login.slice(0, 100) : null;
}

/** Only github.com pages; anything else from a payload is dropped. */
export function githubPage(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('https://github.com/')
    ? value.slice(0, 500)
    : null;
}

function labels(value: unknown): GitHubLabel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label): GitHubLabel[] => {
    if (!label || typeof label !== 'object') return [];
    const { name, color } = label as { name?: unknown; color?: unknown };
    const safeColor = typeof color === 'string' && /^[0-9a-f]{6}$/i.test(color) ? color : '';
    return typeof name === 'string' && name ? [{ name: name.slice(0, 100), color: safeColor }] : [];
  });
}

export function itemUrl(repository: string, kind: 'pull' | 'issue', number: number): string {
  return `https://github.com/${repository}/${kind === 'pull' ? 'pull' : 'issues'}/${number}`;
}

export function toBaseItem(
  raw: Record<string, unknown>,
  repository: string,
  kind: 'pull' | 'issue',
): GitHubIssueSummary | null {
  const number = raw['number'];
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;
  return {
    number,
    title: text(raw['title']),
    url: itemUrl(repository, kind, number),
    author: login(raw['user']),
    labels: labels(raw['labels']),
    comments: count(raw['comments']),
    createdAt: text(raw['created_at'], 40),
    updatedAt: text(raw['updated_at'], 40),
    state: raw['state'] === 'closed' ? 'closed' : 'open',
  };
}

export function toPull(raw: unknown, repository: string): GitHubPullSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const item = toBaseItem(record, repository, 'pull');
  if (!item) return null;
  const head = record['head'] as { ref?: unknown } | undefined;
  const base = record['base'] as { ref?: unknown } | undefined;
  return {
    ...item,
    draft: record['draft'] === true,
    merged: typeof record['merged_at'] === 'string',
    headRef: text(head?.ref, 250),
    baseRef: text(base?.ref, 250),
  };
}

export function toIssue(raw: unknown, repository: string): GitHubIssueSummary | null {
  // The issues endpoint also lists pull requests; those carry `pull_request`.
  if (!raw || typeof raw !== 'object' || 'pull_request' in raw) return null;
  return toBaseItem(raw as Record<string, unknown>, repository, 'issue');
}
