import type { ServerResponse } from 'node:http';
import type { GitHubListPage, GitHubListState } from '@wrongstack/webui-protocol';
import {
  defaultGitHubSeams,
  type GitHubDeps,
  GitHubStatusError,
  githubApi,
  replyJson,
  resolveRepository,
  resolveRequestProject,
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
}

function parseListQuery(params: URLSearchParams): ListQuery | string {
  const kind = params.get('kind');
  if (kind !== 'pulls' && kind !== 'issues') return 'kind must be pulls or issues';
  const state = STATES.find((value) => value === (params.get('state') ?? 'open'));
  if (!state) return 'state must be open, closed or all';
  const rawPage = params.get('page') ?? '1';
  const page = /^\d{1,3}$/.test(rawPage) ? Number(rawPage) : 0;
  if (page < 1 || page > MAX_PAGE) return `page must be 1 to ${MAX_PAGE}`;
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
  return { kind, state, page, labels, assignee };
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

/** `GET /api/github/list?sessionId=…&kind=pulls|issues[&state][&page][&labels][&assignee]` */
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
