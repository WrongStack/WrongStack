import type { GitHubItemDetail as Detail, GitHubPullFile } from '@wrongstack/webui-protocol';
import { ArrowLeft, ArrowUpRight, Bot, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { navigateToView } from '@/lib/view-navigation';
import { useUIStore } from '@/stores/ui-store';
import { ToolDiffView } from '../DiffView';
import { Button } from '../ui/button';
import { GitHubItemActions } from './GitHubItemActions';
import {
  type AgentIntent,
  agentPrompt,
  checkTone,
  type GitHubSelection,
  pullIntents,
  relativeGitHubTime,
  safeGitHubUrl,
} from './github-view-model';
import { useGitHubItem } from './use-github-item';

const TONE_CLASS = {
  pass: 'bg-success',
  fail: 'bg-destructive',
  pending: 'bg-warning',
  neutral: 'bg-muted-foreground',
} as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function PullFile({ file }: { file: GitHubPullFile }) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left font-mono text-xs hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Chevron className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-all">{file.path}</span>
        <span className="shrink-0 text-success">+{file.additions}</span>
        <span className="shrink-0 text-destructive">−{file.deletions}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {file.patch === null ? (
            <p className="px-1 text-xs text-muted-foreground">{t('activity:github.noPatch')}</p>
          ) : (
            <ToolDiffView diff={{ mode: 'unified', patchText: file.patch, caption: file.path }} />
          )}
          {file.patchTruncated && (
            <p className="px-1 text-xs text-muted-foreground">
              {t('activity:github.patchTruncated')}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function PullParts({ pull, locale }: { pull: NonNullable<Detail['pull']>; locale: string }) {
  const { t } = useAppTranslation();
  const unavailable = (
    <p className="text-xs text-muted-foreground">{t('activity:github.partUnavailable')}</p>
  );
  return (
    <>
      <Section title={t('activity:github.checks')}>
        {pull.checks === null ? (
          unavailable
        ) : pull.checks.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('activity:github.noChecks')}</p>
        ) : (
          <ul className="space-y-1">
            {pull.checks.map((check, index) => {
              const tone = checkTone(check);
              const url = check.url ? safeGitHubUrl(check.url) : undefined;
              return (
                <li key={`${check.name}:${index}`} className="flex items-center gap-2 text-sm">
                  <span
                    className={cn('h-2 w-2 shrink-0 rounded-full', TONE_CLASS[tone])}
                    aria-hidden="true"
                  />
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all hover:underline"
                    >
                      {check.name}
                    </a>
                  ) : (
                    <span className="break-all">{check.name}</span>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {t(`activity:github.tone.${tone}`)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section title={t('activity:github.reviews')}>
        {pull.reviews === null ? (
          unavailable
        ) : pull.reviews.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('activity:github.noReviews')}</p>
        ) : (
          <ul className="space-y-2">
            {pull.reviews.map((review, index) => (
              <li
                key={`${review.author}:${review.submittedAt}:${index}`}
                className="rounded-lg border border-border/60 p-2 text-sm"
              >
                <span className="font-medium">
                  {review.author ?? t('activity:github.unknownAuthor')}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {t(`activity:github.review.${review.state}`, { defaultValue: review.state })}
                  {review.submittedAt && ` · ${relativeGitHubTime(review.submittedAt, locale)}`}
                </span>
                {review.body && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                    {review.body}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t('activity:github.files', { count: pull.changedFiles })}>
        {pull.files === null ? (
          unavailable
        ) : (
          <ul className="space-y-1">
            {pull.files.map((file) => (
              <PullFile key={file.path} file={file} />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

export function GitHubItemDetail({
  selection,
  canWrite,
  onBack,
  onChanged,
}: {
  selection: GitHubSelection;
  canWrite: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useAppTranslation();
  const state = useGitHubItem(selection);
  const view = state.view;
  const item = view?.item ?? null;
  const pull = item?.pull ?? null;
  const handOff = (intent: AgentIntent) => {
    if (!view?.repository || !item) return;
    useUIStore.getState().requestPromptInsert(agentPrompt(intent, view.repository, item.number));
    navigateToView('chat');
  };
  const intents: AgentIntent[] = item
    ? pull
      ? pullIntents(pull)
      : item.state === 'open'
        ? ['issue']
        : []
    : [];
  const status = !item
    ? null
    : pull?.merged
      ? 'merged'
      : pull?.draft && item.state === 'open'
        ? 'draft'
        : item.state;
  const href = item ? safeGitHubUrl(item.url) : undefined;
  return (
    <article
      aria-label={t('activity:github.detail')}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="md:hidden">
          <ArrowLeft className="h-4 w-4" />
          {t('activity:github.back')}
        </Button>
        <div className="ml-auto flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={state.reload}
            disabled={state.loading}
            aria-label={t('activity:github.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', state.loading && 'animate-spin')} />
          </Button>
          {href && (
            <Button variant="outline" size="sm" asChild>
              <a href={href} target="_blank" rel="noreferrer">
                <ArrowUpRight className="h-4 w-4" />
                {t('activity:github.openOnGitHub')}
              </a>
            </Button>
          )}
        </div>
      </div>
      {state.error ? (
        <p role="alert" className="m-4 break-words text-sm text-destructive">
          {state.error}
        </p>
      ) : !view ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {t('activity:github.loading')}
        </p>
      ) : !item ? (
        <p role="status" className="m-4 text-sm">
          {t(`activity:github.status.${view.status}`)}
        </p>
      ) : (
        <div className="space-y-5 p-4">
          <header className="space-y-2">
            <h2 className="break-words text-lg font-semibold">
              {item.title} <span className="font-normal text-muted-foreground">#{item.number}</span>
            </h2>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {status && (
                <span className="rounded-full border border-border px-2 py-0.5 text-foreground">
                  {t(`activity:github.state.${status}`)}
                </span>
              )}
              <span>{item.author ?? t('activity:github.unknownAuthor')}</span>
              {pull && (
                <span className="break-all font-mono">
                  {pull.headRef} → {pull.baseRef}
                </span>
              )}
              {pull?.fromFork && <span>{t('activity:github.fork')}</span>}
              {pull && !pull.merged && item.state === 'open' && (
                <span>
                  {t(
                    pull.mergeable === null
                      ? 'activity:github.mergeable.unknown'
                      : pull.mergeable
                        ? 'activity:github.mergeable.yes'
                        : 'activity:github.mergeable.no',
                  )}
                </span>
              )}
              {pull && (
                <span>
                  <span className="text-success">+{pull.additions}</span>{' '}
                  <span className="text-destructive">−{pull.deletions}</span>
                </span>
              )}
            </p>
          </header>
          {intents.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {intents.map((intent) => (
                <Button key={intent} size="sm" variant="secondary" onClick={() => handOff(intent)}>
                  <Bot className="h-4 w-4" />
                  {t(`activity:github.agent.${intent}`)}
                </Button>
              ))}
            </div>
          )}
          <Section title={t('activity:github.description')}>
            {item.body ? (
              <p className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/20 p-3 text-sm">
                {item.body}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('activity:github.noDescription')}</p>
            )}
          </Section>
          {pull && <PullParts pull={pull} locale={i18n.language} />}
          <GitHubItemActions
            item={item}
            repository={view.repository ?? ''}
            canWrite={canWrite}
            onDone={() => {
              state.reload();
              onChanged();
            }}
          />
        </div>
      )}
    </article>
  );
}
