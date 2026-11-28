import type { GitHubIssueSummary, GitHubPullSummary } from '@wrongstack/webui-protocol';
import {
  ArrowUpRight,
  CircleDot,
  GitPullRequest,
  GitPullRequestDraft,
  MessageSquare,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import { PageMotif } from '../ui/PageMotif';
import { GitHubItemDetail } from './GitHubItemDetail';
import {
  filterGitHubItems,
  type GitHubSelection,
  type GitHubTab,
  labelColor,
  relativeGitHubTime,
  safeGitHubUrl,
} from './github-view-model';
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
  const Icon = pull ? (pull.draft ? GitPullRequestDraft : GitPullRequest) : CircleDot;
  const body = (
    <>
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          pull?.draft ? 'text-muted-foreground' : 'text-success',
        )}
        aria-hidden="true"
      />
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
          {pull && (
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
  const view = state.view;
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
  const items = useMemo(
    () => filterGitHubItems<GitHubIssueSummary | GitHubPullSummary>(view?.[tab] ?? [], query),
    [view, tab, query],
  );
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
          <Button
            variant="outline"
            size="sm"
            onClick={state.refresh}
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
              selected ? 'hidden' : 'flex',
            )}
          >
            <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3 sm:px-6">
              <div
                role="tablist"
                aria-label="GitHub"
                className="flex gap-1 rounded-lg bg-muted/40 p-1"
              >
                {(['pulls', 'issues'] as const).map((id) => (
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
                    <span className="ml-2 text-xs text-muted-foreground">
                      {view[id].length}
                      {view.truncated[id] ? '+' : ''}
                    </span>
                  </button>
                ))}
              </div>
              <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-3 py-1.5 sm:max-w-sm">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  aria-label={t('activity:github.filter')}
                  placeholder={t('activity:github.filter')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="w-full min-w-0 bg-transparent text-sm outline-none"
                />
              </label>
            </div>
            <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-4">
              {view[tab].length === 0 && view.truncated[tab] ? null : view[tab].length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {t(
                    tab === 'pulls' ? 'activity:github.emptyPulls' : 'activity:github.emptyIssues',
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
                      onSelect={() => setSelected({ kind, number: item.number })}
                    />
                  ))}
                </ul>
              )}
              {view.truncated[tab] && (
                <p className="px-3 py-3 text-xs text-muted-foreground">
                  {t('activity:github.truncated', { count: view[tab].length })}
                </p>
              )}
            </div>
          </div>
          {selected ? (
            <GitHubItemDetail
              key={`${selected.kind}:${selected.number}`}
              selection={selected}
              canWrite={view.tokenSource !== 'none'}
              onBack={() => setSelected(null)}
              onChanged={state.refresh}
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
