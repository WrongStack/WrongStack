import type { ServerResponse } from 'node:http';
import type {
  GitHubLabelsView,
  GitHubListPage,
  GitHubListState,
  GitHubPullSummary,
} from '@wrongstack/webui-protocol';
import {
  defaultGitHubSeams,
  type GitHubDeps,
  type GitHubSeams,
  GitHubStatusError,
  githubApi,
  type RepositoryTarget,
  replyJson,
  resolveRepository,
  resolveRequestProject,
  toBaseItem,
  toGitHubLabels,
  toIssue,
  toPull,
} from './github-client.js';

/**
 * `GET /api/github/list` — one page of pull requests or issues in any state,
 * for the view's state filter and "load more". The open-items read at
 * `/api/github` stays as it is: the `#` pickers rely on it.
 */

const PAGE_SIZE = 50;
const MAX_PAGE = 400;
/** GitHub search returns at most 1,000 results: 20 pages of 50. */
const MAX_SEARCH_PAGE = 20;
const QUERY_CAP = 256;
/** Issue pages can hold only pull requests; read on this many before answering. */
const READ_AHEAD = 3;
const STATES: readonly GitHubListState[] = ['open', 'closed', 'all'];
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

interface ListQuery {
  kind: 'pulls' | 'issues';
  state: GitHubListState;
  page: number;
  labels: string[];
  assignee: string | null;
  /** Text for GitHub's search; null lists instead. */
  q: string | null;
}

function parseListQuery(params: URLSearchParams): ListQuery | string {
  const kind = params.get('kind');
  if (kind !== 'pulls' && kind !== 'issues') return 'kind must be pulls or issues';
  const state = STATES.find((value) => value === (params.get('state') ?? 'open'));
  if (!state) return 'state must be open, closed or all';
  const q = params.get('q')?.trim() || null;
  if (q && (q.length > QUERY_CAP || /[\u0000-\u001f\u007f]/.test(q)))
    return `The search text must be one line of at most ${QUERY_CAP} characters`;
  const maxPage = q ? MAX_SEARCH_PAGE : MAX_PAGE;
  const rawPage = params.get('page') ?? '1';
  const page = /^\d{1,3}$/.test(rawPage) ? Number(rawPage) : 0;
  if (page < 1 || page > maxPage) return `page must be 1 to ${maxPage}`;
  const rawLabels = params.get('labels');
  const rawAssignee = params.get('assignee');
  if (kind === 'pulls' && (rawLabels !== null || rawAssignee !== null))
    return 'labels and assignee filter issues only';
  const labels = (rawLabels ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
  if (labels.length > 10) return 'At most 10 labels';
  if (labels.some((label) => label.length > 100 || /[\u0000-\u001f\u007f]/.test(label)))
    return 'A label is too long or holds control characters';
  const assignee = rawAssignee?.trim() || null;
  if (assignee && assignee !== 'none' && assignee !== '*' && !LOGIN.test(assignee))
    return 'assignee must be a GitHub login, none or *';
  // Search has no "any assignee" qualifier, and a label is quoted there.
  if (q && assignee === '*') return 'Search cannot filter by any assignee; use a login or none';
  if (q && labels.some((label) => label.includes('"')))
    return 'Search cannot filter by a label that holds a quote';
  return { kind, state, page, labels, assignee, q };
}

/** GitHub's next page number from a `Link` header, or null on the last page. */
function nextPageOf(link: string | null): number | null {
  const next = link?.split(',').find((part) => /rel="next"/.test(part));
  const target = next?.match(/<([^>]+)>/)?.[1];
  if (!target) return null;
  try {
    const page = Number(new URL(target).searchParams.get('page'));
    return Number.isSafeInteger(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

/**
 * A pull request from a search result: search items are issue-shaped, so
 * the branches are unknown (left empty) and the merge time sits under
 * `pull_request`.
 */
function toSearchPull(raw: Record<string, unknown>, repository: string): GitHubPullSummary | null {
  const item = toBaseItem(raw, repository, 'pull');
  if (!item) return null;
  const pull = raw['pull_request'] as { merged_at?: unknown } | undefined;
  return {
    ...item,
    draft: raw['draft'] === true,
    merged: typeof pull?.merged_at === 'string',
    headRef: '',
    baseRef: '',
  };
}

/**
 * One page of GitHub search, pinned to this repository and tab by qualifiers
 * before the user's text. The text can still widen the query (`repo:`, `OR`,
 * `is:`), so every result from another repository or of the other kind is
 * dropped: rows are rebuilt as this repository's numbers, and a stranger's
 * item would open (and offer writes on) the wrong one. No read-ahead: search
 * has a far smaller rate limit than listing.
 */
async function searchPage(
  query: ListQuery & { q: string },
  target: Extract<RepositoryTarget, { status: 'ok' }>,
  seams: GitHubSeams,
): Promise<GitHubListPage> {
  const qualifiers = [
    `repo:${target.repository}`,
    query.kind === 'pulls' ? 'is:pr' : 'is:issue',
    ...(query.state === 'all' ? [] : [`is:${query.state}`]),
    ...query.labels.map((label) => `label:"${label}"`),
    ...(query.assignee === 'none'
      ? ['no:assignee']
      : query.assignee
        ? [`assignee:${query.assignee}`]
        : []),
  ];
  const result = await githubApi<{ total_count?: unknown; items?: unknown }>(
    seams,
    target.token,
    `search/issues?q=${encodeURIComponent(`${qualifiers.join(' ')} ${query.q}`)}&sort=updated&order=desc&per_page=${PAGE_SIZE}&page=${query.page}`,
  );
  const raw = result.data?.items;
  if (!Array.isArray(raw)) throw new GitHubStatusError('unavailable');
  const home = `https://api.github.com/repos/${target.repository}`.toLowerCase();
  const ours = raw.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) &&
      typeof item === 'object' &&
      String((item as Record<string, unknown>)['repository_url']).toLowerCase() === home &&
      'pull_request' in item === (query.kind === 'pulls'),
  );
  const items =
    query.kind === 'pulls'
      ? ours.flatMap((item) => toSearchPull(item, target.repository) ?? [])
      : ours.flatMap((item) => toIssue(item, target.repository) ?? []);
  const next = nextPageOf(result.headers.get('link'));
  const total = result.data?.total_count;
  return {
    status: 'ok',
    kind: query.kind,
    items,
    nextPage: next !== null && next <= MAX_SEARCH_PAGE ? next : null,
    ...(typeof total === 'number' && Number.isSafeInteger(total) ? { total } : {}),
  } as GitHubListPage;
}

/** `GET /api/github/list?sessionId=…&kind=pulls|issues[&state][&page][&labels][&assignee][&q]` */
export async function handleGitHubListRead(
  res: ServerResponse,
  url: URL,
  deps: GitHubDeps,
): Promise<void> {
  const query = parseListQuery(url.searchParams);
  if (typeof query === 'string') {
    replyJson(res, 400, { error: query });
    return;
  }
  const projectRoot = await resolveRequestProject(res, url, deps);
  if (!projectRoot) return;
  const seams = deps.github ?? defaultGitHubSeams;
  const page = (patch: Partial<GitHubListPage> = {}) =>
    ({ status: 'ok', kind: query.kind, items: [], nextPage: null, ...patch }) as GitHubListPage;
  const target = await resolveRepository(seams, projectRoot);
  if (target.status !== 'ok') return replyJson(res, 200, page({ status: target.status }));
  if (query.q) {
    try {
      return replyJson(res, 200, await searchPage({ ...query, q: query.q }, target, seams));
    } catch (error) {
      if (error instanceof GitHubStatusError)
        return replyJson(res, 200, page({ status: error.status }));
      throw error;
    }
  }
  const filters = [
    ...(query.labels.length ? [`labels=${encodeURIComponent(query.labels.join(','))}`] : []),
    ...(query.assignee ? [`assignee=${encodeURIComponent(query.assignee)}`] : []),
  ];
  const items: unknown[] = [];
  let nextPage: number | null = query.page;
  try {
    for (let read = 0; read < READ_AHEAD && nextPage !== null && items.length === 0; read++) {
      const result = await githubApi(
        seams,
        target.token,
        [
          `repos/${target.repository}/${query.kind}?state=${query.state}&sort=updated&direction=desc`,
          `per_page=${PAGE_SIZE}`,
          `page=${nextPage}`,
          ...filters,
        ].join('&'),
        // Repositories with issues turned off (most forks) answer 410 Gone.
        query.kind === 'issues' ? { allow: [410] } : {},
      );
      if (result.httpStatus === 410) return replyJson(res, 200, page());
      if (!Array.isArray(result.data)) throw new GitHubStatusError('unavailable');
      const mapped =
        query.kind === 'pulls'
          ? result.data.flatMap((raw) => toPull(raw, target.repository) ?? [])
          : result.data.flatMap((raw) => toIssue(raw, target.repository) ?? []);
      items.push(...mapped);
      nextPage = nextPageOf(result.headers.get('link'));
      if (nextPage !== null && nextPage > MAX_PAGE) nextPage = null;
    }
  } catch (error) {
    if (error instanceof GitHubStatusError)
      return replyJson(res, 200, page({ status: error.status }));
    throw error;
  }
  replyJson(res, 200, page({ items: items as GitHubListPage['items'], nextPage }));
}

/** `GET /api/github/labels?sessionId=…` — label choices for the issue filter. */
export async function handleGitHubLabelsRead(
  res: ServerResponse,
  url: URL,
  deps: GitHubDeps,
): Promise<void> {
  const projectRoot = await resolveRequestProject(res, url, deps);
  if (!projectRoot) return;
  const seams = deps.github ?? defaultGitHubSeams;
  const view = (patch: Partial<GitHubLabelsView>): GitHubLabelsView => ({
    status: 'ok',
    labels: [],
    ...patch,
  });
  const target = await resolveRepository(seams, projectRoot);
  if (target.status !== 'ok') return replyJson(res, 200, view({ status: target.status }));
  try {
    const result = await githubApi(
      seams,
      target.token,
      `repos/${target.repository}/labels?per_page=100`,
    );
    replyJson(res, 200, view({ labels: toGitHubLabels(result.data) }));
  } catch (error) {
    if (!(error instanceof GitHubStatusError)) throw error;
    replyJson(res, 200, view({ status: error.status }));
  }
}
