import type { GitHubIssueSummary, GitHubPullSummary } from '@wrongstack/webui-protocol';
import {
  ArrowUpRight,
  CircleCheck,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import { PageMotif } from '../ui/PageMotif';
import { GitHubCreateForm } from './GitHubCreateForm';
import { GitHubItemDetail } from './GitHubItemDetail';
import { GitHubListFilters } from './GitHubListFilters';
import {
  filterGitHubItems,
  type GitHubSelection,
  type GitHubTab,
  labelColor,
  relativeGitHubTime,
  safeGitHubUrl,
} from './github-view-model';
import {
  DEFAULT_GITHUB_FILTER,
  type GitHubListFilter,
  isDefaultGitHubFilter,
  useGitHubList,
} from './use-github-list';
import { useGitHubRepository } from './use-github-repository';

function ItemRow({
  item,
  locale,
  selected,
  onSelect,
}: {
  item: GitHubIssueSummary | GitHubPullSummary;
  locale: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useAppTranslation();
  const pull = 'headRef' in item ? item : null;
  const status = pull?.merged
    ? 'merged'
    : item.state === 'closed'
      ? 'closed'
      : pull?.draft
        ? 'draft'
        : 'open';
  const Icon = pull
    ? {
        merged: GitMerge,
        closed: GitPullRequestClosed,
        draft: GitPullRequestDraft,
        open: GitPullRequest,
      }[status]
    : item.state === 'closed'
      ? CircleCheck
      : CircleDot;
  const body = (
    <>
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          status === 'merged'
            ? 'text-primary'
            : status === 'closed'
              ? pull
                ? 'text-destructive'
                : 'text-primary'
              : status === 'draft'
                ? 'text-muted-foreground'
                : 'text-success',
        )}
        aria-hidden="true"
      />
      {status !== 'open' && status !== 'draft' && (
        <span className="sr-only">{t(`activity:github.state.${status}`)}</span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="break-words text-sm font-medium text-foreground">{item.title}</span>
          {pull?.draft && (
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {t('activity:github.draft')}
            </span>
          )}
          {item.labels.map((label) => {
            const color = labelColor(label.color);
            return (
              <span
                key={label.name}
                className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {color && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                    aria-hidden="true"
                  />
                )}
                {label.name}
              </span>
            );
          })}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t('activity:github.opened', {
              number: item.number,
              author: item.author ?? t('activity:github.unknownAuthor'),
            })}
          </span>
          {/* Search results carry no branches. */}
          {pull?.headRef && (
            <span className="break-all font-mono text-[11px]">
              {pull.headRef} → {pull.baseRef}
            </span>
          )}
          <span title={item.updatedAt}>
            {t('activity:github.updated', { time: relativeGitHubTime(item.updatedAt, locale) })}
          </span>
        </span>
      </span>
      {item.comments > 0 && (
        <span
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
          title={t('activity:github.comments', { count: item.comments })}
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
          <span aria-hidden="true">{item.comments}</span>
          <span className="sr-only">{t('activity:github.comments', { count: item.comments })}</span>
        </span>
      )}
    </>
  );
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected
            ? 'border-primary/30 bg-primary/10'
            : 'border-transparent hover:border-border/60 hover:bg-muted/40',
        )}
      >
        {body}
      </button>
    </li>
  );
}

export function GitHubView() {
  const { t, i18n } = useAppTranslation();
  const state = useGitHubRepository();
  const [tab, setTab] = useState<GitHubTab>('pulls');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<GitHubTab, GitHubListFilter>>({
    pulls: DEFAULT_GITHUB_FILTER,
    issues: DEFAULT_GITHUB_FILTER,
  });
  const [round, setRound] = useState(0);
  const view = state.view;
  // The new-item form belongs to one repository and session, like a selection.
  const [creatingIn, setCreatingIn] = useState<{
    kind: 'pull' | 'issue';
    session: string;
    repository: string;
  } | null>(null);
  const creating =
    creatingIn && view?.repository === creatingIn.repository && state.session === creatingIn.session
      ? creatingIn.kind
      : null;
  // A selection belongs to one repository: switching the session (and so the
  // project) must never leave a merge button pointing at another repo's #N.
  const [picked, setPicked] = useState<
    (GitHubSelection & { session: string; repository: string }) | null
  >(null);
  const selected =
    picked && view?.repository === picked.repository && state.session === picked.session
      ? picked
      : null;
  const setSelected = (next: GitHubSelection | null) =>
    setPicked(
      next && view?.repository
        ? { ...next, session: state.session, repository: view.repository }
        : null,
    );
  const kind = tab === 'pulls' ? 'pull' : 'issue';
  const filter = filters[tab];
  const usable = view?.status === 'ok';
  const list = useGitHubList({
    tab,
    filter,
    // Until the repository answered, nothing is read; the open list is its first page.
    seed:
      !usable || isDefaultGitHubFilter(tab, filter)
        ? {
            items: view?.[tab] ?? [],
            truncated: view?.truncated[tab] ?? false,
            fetchedAt: view?.fetchedAt ?? '',
          }
        : null,
    round,
  });
  const searching = filter.q.trim();
  // GitHub's search also matches descriptions and comments; the local text
  // filter would hide those results, so it only narrows listed items.
  const items = useMemo(
    () =>
      searching
        ? list.items
        : filterGitHubItems<GitHubIssueSummary | GitHubPullSummary>(list.items, query),
    [list.items, query, searching],
  );
  const setFilter = (next: GitHubListFilter) => setFilters((all) => ({ ...all, [tab]: next }));
  const refresh = () => {
    state.refresh();
    setRound((value) => value + 1);
  };
  const filtered = !isDefaultGitHubFilter(tab, filter);
  const canWrite = view?.status === 'ok' && view.tokenSource !== 'none';
  const startCreating = () => {
    if (view?.repository)
      setCreatingIn({ kind, session: state.session, repository: view.repository });
    setPicked(null);
  };
  const repositoryUrl = view?.repository
    ? safeGitHubUrl(`https://github.com/${view.repository}`)
    : undefined;
  const tokenText =
    view?.tokenSource === 'env'
      ? t('activity:github.tokenEnv')
      : view?.tokenSource === 'gh'
        ? t('activity:github.tokenGh')
        : t('activity:github.tokenNone');
  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="GitHub">
      <header className="ws-page-header flex flex-wrap items-center justify-between gap-3 border-b border-border">
        <PageMotif kind="network" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitPullRequest className="h-5 w-5 text-primary" />
            <h1 className="">GitHub</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t('activity:github.subtitle')}</p>
          {view?.repository && (
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span className="break-all font-mono">{view.repository}</span>
              <span>{tokenText}</span>
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          {canWrite && (
            <Button size="sm" onClick={startCreating}>
              <Plus className="h-4 w-4" />
              <span className="ml-2">
                {t(
                  tab === 'pulls'
                    ? 'activity:github.create.newPull'
                    : 'activity:github.create.newIssue',
                )}
              </span>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={state.loading}
            aria-label={t('activity:github.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', state.loading && 'animate-spin')} />
            <span className="ml-2">{t('activity:github.refresh')}</span>
          </Button>
          {repositoryUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={repositoryUrl} target="_blank" rel="noreferrer">
                <ArrowUpRight className="h-4 w-4" />
                <span className="ml-2">{t('activity:github.openOnGitHub')}</span>
              </a>
            </Button>
          )}
        </div>
      </header>
      {state.error ? (
        <div
          role="alert"
          className="m-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          {t('activity:github.status.unavailable')}
          <p className="mt-2 break-words text-muted-foreground">{state.error}</p>
        </div>
      ) : !view ? (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          {t('activity:github.loading')}
        </p>
      ) : view.status !== 'ok' ? (
        <div role="status" className="m-6 rounded-lg border border-border bg-muted/30 p-4 text-sm">
          {t(`activity:github.status.${view.status}`)}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div
            className={cn(
              'min-h-0 min-w-0 flex-1 flex-col md:flex md:max-w-[min(46rem,55%)] md:border-r md:border-border',
              selected || creating ? 'hidden' : 'flex',
            )}
          >
            <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3 sm:px-6">
              <div
                role="tablist"
                aria-label="GitHub"
                className="flex gap-1 rounded-lg bg-muted/40 p-1"
              >
                {(['pulls', 'issues'] as const).map((id) => {
                  // The other tab's count is known only for its open first page.
                  const count =
                    id === tab
                      ? `${list.items.length}${list.nextPage !== null ? '+' : ''}`
                      : isDefaultGitHubFilter(id, filters[id])
                        ? `${view[id].length}${view.truncated[id] ? '+' : ''}`
                        : '';
                  return (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={tab === id}
                      onClick={() => setTab(id)}
                      className={cn(
                        'rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        tab === id
                          ? 'bg-background font-medium text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(`activity:github.${id}`)}
                      {count && <span className="ml-2 text-xs text-muted-foreground">{count}</span>}
                    </button>
                  );
                })}
              </div>
              <form
                className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-md"
                onSubmit={(event) => {
                  // Enter searches GitHub: an explicit submit, never per keystroke
                  // (search has a small rate limit).
                  event.preventDefault();
                  if (query.trim()) setFilter({ ...filter, q: query.trim() });
                }}
              >
                <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-3 py-1.5">
                  <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <input
                    aria-label={t('activity:github.filter')}
                    placeholder={t('activity:github.filter')}
                    value={query}
                    maxLength={256}
                    onChange={(event) => setQuery(event.target.value)}
                    className="w-full min-w-0 bg-transparent text-sm outline-none"
                  />
                </label>
                {query.trim() && query.trim() !== searching && (
                  <Button type="submit" size="sm" variant="outline">
                    {t('activity:github.searchGitHub')}
                  </Button>
                )}
              </form>
              <GitHubListFilters key={tab} tab={tab} filter={filter} onChange={setFilter} />
            </div>
            {searching && (
              <div
                role="status"
                className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground sm:px-6"
              >
                <span className="min-w-0 break-words">
                  {list.total === null
                    ? t('activity:github.searchingFor', { query: searching })
                    : t('activity:github.searchResults', { query: searching, count: list.total })}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setQuery('');
                    setFilter({ ...filter, q: '' });
                  }}
                >
                  {t('activity:github.clearSearch')}
                </Button>
              </div>
            )}
            <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-4">
              {list.problem ? (
                <div
                  role="alert"
                  className="m-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
                >
                  {list.problem.status
                    ? t(`activity:github.status.${list.problem.status}`)
                    : t('activity:github.status.unavailable')}
                  {list.problem.text && (
                    <p className="mt-1 break-words text-muted-foreground">{list.problem.text}</p>
                  )}
                </div>
              ) : list.pending ? (
                <p role="status" className="p-4 text-sm text-muted-foreground">
                  {t('activity:github.loading')}
                </p>
              ) : list.items.length === 0 && list.nextPage !== null ? null : list.items.length ===
                0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {filtered
                    ? t('activity:github.emptyFiltered')
                    : t(
                        tab === 'pulls'
                          ? 'activity:github.emptyPulls'
                          : 'activity:github.emptyIssues',
                      )}
                </p>
              ) : items.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{t('activity:github.noMatch')}</p>
              ) : (
                <ul className="space-y-0.5">
                  {items.map((item) => (
                    <ItemRow
                      key={item.number}
                      item={item}
                      locale={i18n.language}
                      selected={selected?.kind === kind && selected.number === item.number}
                      onSelect={() => {
                        setCreatingIn(null);
                        setSelected({ kind, number: item.number });
                      }}
                    />
                  ))}
                </ul>
              )}
              {!list.problem && list.nextPage !== null && (
                <div className="flex flex-wrap items-center gap-3 px-3 py-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={list.loading}
                    onClick={list.loadMore}
                  >
                    {list.loading
                      ? t('activity:github.loadingMore')
                      : t('activity:github.loadMore')}
                  </Button>
                  {query.trim() && !searching && (
                    <span className="text-xs text-muted-foreground">
                      {t('activity:github.filterLoadedOnly')}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          {creating && view.repository ? (
            <GitHubCreateForm
              key={creating}
              kind={creating}
              repository={view.repository}
              onCancel={() => setCreatingIn(null)}
              onCreated={(next) => {
                setCreatingIn(null);
                refresh();
                setSelected(next);
              }}
            />
          ) : selected ? (
            <GitHubItemDetail
              key={`${selected.kind}:${selected.number}`}
              selection={selected}
              canWrite={view.tokenSource !== 'none'}
              onBack={() => setSelected(null)}
              onChanged={refresh}
            />
          ) : (
            <p className="hidden flex-1 items-center justify-center p-6 text-sm text-muted-foreground md:flex">
              {t('activity:github.pickItem')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
