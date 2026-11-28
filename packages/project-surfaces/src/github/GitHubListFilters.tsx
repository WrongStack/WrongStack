import type { GitHubLabel, GitHubLabelsView } from '@wrongstack/webui-protocol';
import { useEffect, useState } from 'react';
import { surfaceFetch } from '../host';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import { useGitHubSessionId, withGitHubSession } from './github-session';
import type { GitHubTab } from './github-view-model';
import type { GitHubListFilter } from './use-github-list';

const field =
  'min-w-0 rounded-lg border border-input bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The repository's labels, read once per session while the issue filters show. */
function useGitHubLabels(enabled: boolean): GitHubLabel[] {
  const sessionId = useGitHubSessionId();
  const key = sessionId ?? 'host';
  const [state, setState] = useState<{ key: string; labels: GitHubLabel[] } | null>(null);
  const loaded = state?.key === key;
  useEffect(() => {
    if (!enabled || loaded) return;
    const controller = new AbortController();
    surfaceFetch(withGitHubSession('/api/github/labels', sessionId), {
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then((response) => (response.ok ? (response.json() as Promise<GitHubLabelsView>) : null))
      .then((view) => {
        if (!controller.signal.aborted) setState({ key, labels: view?.labels ?? [] });
      })
      // No label choices is fine: the field still takes typed names.
      .catch(() => {});
    return () => controller.abort();
  }, [enabled, loaded, key, sessionId]);
  return loaded ? state.labels : [];
}

const splitLabels = (value: string) =>
  value
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);

/**
 * State for both tabs; labels and assignee for issues, applied on submit. A
 * picked label is appended to the comma-separated field, which still takes
 * several labels (GitHub matches all of them).
 */
export function GitHubListFilters({
  tab,
  filter,
  canAskMine,
  onChange,
}: {
  tab: GitHubTab;
  filter: GitHubListFilter;
  /** "Me" is the token's owner: offered only when there is a token. */
  canAskMine: boolean;
  onChange: (next: GitHubListFilter) => void;
}) {
  const { t } = useAppTranslation();
  const [labels, setLabels] = useState(filter.labels);
  const [assignee, setAssignee] = useState(filter.assignee);
  const choices = useGitHubLabels(tab === 'issues');
  const picked = new Set(splitLabels(labels).map((label) => label.toLowerCase()));
  const offered = choices.filter((label) => !picked.has(label.name.toLowerCase()));
  const dirty = labels !== filter.labels || assignee !== filter.assignee;
  const mineChoices: GitHubListFilter['mine'][] =
    tab === 'pulls' ? ['', 'authored', 'review-requested'] : ['', 'assigned', 'authored'];
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onChange({ ...filter, labels: labels.trim(), assignee: assignee.trim() });
      }}
    >
      <select
        aria-label={t('activity:github.stateFilter')}
        value={filter.state}
        onChange={(event) =>
          onChange({ ...filter, state: event.target.value as GitHubListFilter['state'] })
        }
        className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
      >
        {(['open', 'closed', 'all'] as const).map((value) => (
          <option key={value} value={value}>
            {t(`activity:github.state.${value}`)}
          </option>
        ))}
      </select>
      {canAskMine && (
        <select
          aria-label={t('activity:github.mineFilter')}
          value={filter.mine}
          onChange={(event) => {
            const mine = event.target.value as GitHubListFilter['mine'];
            // "Assigned to me" names the assignee itself.
            if (mine === 'assigned') setAssignee('');
            onChange({ ...filter, mine, ...(mine === 'assigned' ? { assignee: '' } : {}) });
          }}
          className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
        >
          {mineChoices.map((value) => (
            <option key={value || 'all'} value={value}>
              {t(`activity:github.mine.${value || 'all'}`)}
            </option>
          ))}
        </select>
      )}
      {tab === 'issues' && (
        <>
          <input
            aria-label={t('activity:github.labelsFilter')}
            placeholder={t('activity:github.labelsFilter')}
            value={labels}
            maxLength={1000}
            onChange={(event) => setLabels(event.target.value)}
            className={cn(field, 'w-40')}
          />
          {offered.length > 0 && (
            <select
              aria-label={t('activity:github.addLabel')}
              value=""
              onChange={(event) => {
                const name = event.target.value;
                if (name) setLabels([...splitLabels(labels), name].join(', '));
              }}
              className="max-w-40 rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
            >
              <option value="">{t('activity:github.addLabel')}</option>
              {offered.map((label) => (
                <option key={label.name} value={label.name}>
                  {label.name}
                </option>
              ))}
            </select>
          )}
          <input
            aria-label={t('activity:github.assigneeFilter')}
            placeholder={t('activity:github.assigneeFilter')}
            value={assignee}
            maxLength={39}
            disabled={filter.mine === 'assigned'}
            onChange={(event) => setAssignee(event.target.value)}
            className={cn(field, 'w-40')}
          />
          <Button type="submit" size="sm" variant="outline" disabled={!dirty}>
            {t('activity:github.applyFilters')}
          </Button>
          {(filter.labels || filter.assignee) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setLabels('');
                setAssignee('');
                onChange({ ...filter, labels: '', assignee: '' });
              }}
            >
              {t('activity:github.clearFilters')}
            </Button>
          )}
        </>
      )}
    </form>
  );
}
