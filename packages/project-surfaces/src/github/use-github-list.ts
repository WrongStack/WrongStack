import type {
  GitHubIssueSummary,
  GitHubListPage,
  GitHubListState,
  GitHubPullSummary,
  GitHubRepositoryStatus,
} from '@wrongstack/webui-protocol';
import { useEffect, useRef, useState } from 'react';
import { surfaceFetch } from '../host';
import { useGitHubSessionId, withGitHubSession } from './github-session';
import type { GitHubTab } from './github-view-model';

type Item = GitHubIssueSummary | GitHubPullSummary;

export interface GitHubListFilter {
  state: GitHubListState;
  /** Comma-separated label names; issues only. */
  labels: string;
  /** A login, `none` or `*`; issues only. */
  assignee: string;
}

export const DEFAULT_GITHUB_FILTER: GitHubListFilter = { state: 'open', labels: '', assignee: '' };

/** The open, unfiltered list is the one `/api/github` already read. */
export function isDefaultGitHubFilter(tab: GitHubTab, filter: GitHubListFilter): boolean {
  return (
    filter.state === 'open' &&
    (tab === 'pulls' || (!filter.labels.trim() && !filter.assignee.trim()))
  );
}

/** Later pages replace nothing: an item moved up by an update keeps its first place. */
function append(items: readonly Item[], more: readonly Item[]): Item[] {
  const seen = new Set(items.map((item) => item.number));
  return [...items, ...more.filter((item) => !seen.has(item.number))];
}

/**
 * One tab's list beyond the open items `/api/github` read: the seed is that
 * first page (default filter only), and "load more" or another filter reads
 * `/api/github/list` page by page. An empty page is not the end; only
 * `nextPage: null` is.
 */
export function useGitHubList({
  tab,
  filter,
  seed,
  round,
}: {
  tab: GitHubTab;
  filter: GitHubListFilter;
  /** The open first page, or null when this filter needs its own reads. */
  seed: { items: readonly Item[]; truncated: boolean; fetchedAt: string } | null;
  /** Bumped by a refresh or a write, so loaded pages start over. */
  round: number;
}) {
  const sessionId = useGitHubSessionId();
  const issues = tab === 'issues';
  const key = JSON.stringify([
    sessionId,
    tab,
    filter.state,
    issues ? filter.labels.trim() : '',
    issues ? filter.assignee.trim() : '',
    seed?.fetchedAt ?? 'own',
    round,
  ]);
  const current = useRef(key);
  current.current = key;
  const [pages, setPages] = useState<{
    key: string;
    items: Item[];
    nextPage: number | null;
  } | null>(null);
  const [problem, setProblem] = useState<{
    key: string;
    status: GitHubRepositoryStatus | null;
    text: string;
  } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const load = (page: number, signal?: AbortSignal) => {
    const at = key;
    setLoading(at);
    setProblem(null);
    const query: Record<string, string> = { kind: tab, state: filter.state, page: String(page) };
    if (issues && filter.labels.trim()) query['labels'] = filter.labels.trim();
    if (issues && filter.assignee.trim()) query['assignee'] = filter.assignee.trim();
    surfaceFetch(withGitHubSession('/api/github/list', sessionId, query), {
      ...(signal ? { signal } : {}),
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data as GitHubListPage;
      })
      .then((data) => {
        if (current.current !== at) return;
        if (data.status !== 'ok') {
          setProblem({ key: at, status: data.status, text: '' });
          return;
        }
        setPages((previous) => ({
          key: at,
          items: append(previous?.key === at ? previous.items : [], data.items),
          nextPage: data.nextPage,
        }));
      })
      .catch((reason: Error) => {
        if (current.current === at && reason.name !== 'AbortError')
          setProblem({ key: at, status: null, text: reason.message });
      })
      .finally(() => {
        if (current.current === at) setLoading(null);
      });
  };
  const own = seed === null;
  // The key names every input of the read; `load` is rebuilt each render.
  useEffect(() => {
    if (!own) return;
    const controller = new AbortController();
    load(1, controller.signal);
    return () => controller.abort();
  }, [key]);
  const loaded = pages?.key === key ? pages : null;
  const items = seed ? append(seed.items, loaded?.items ?? []) : (loaded?.items ?? []);
  const nextPage = loaded ? loaded.nextPage : seed?.truncated ? 2 : null;
  return {
    items,
    /** Still waiting for the first page of a filtered list. */
    pending: own && !loaded && !(problem?.key === key),
    nextPage,
    loading: loading === key,
    problem: problem?.key === key ? problem : null,
    loadMore: () => {
      if (nextPage !== null && loading !== key) load(nextPage);
    },
  };
}
