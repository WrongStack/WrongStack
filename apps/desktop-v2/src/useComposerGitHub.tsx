import {
  detectGitHubMention,
  type GitHubItemDetailView,
  type GitHubMentionCandidate,
  type GitHubRepositoryView,
  insertGitHubMention,
  matchGitHubMentions,
} from '@wrongstack/webui-protocol';
import { GitPullRequest } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EngineHttp } from './engine-http';
import { surfaceI18n } from './surface-i18n';

const FRESH_MS = 30_000;

function candidates(view: GitHubRepositoryView | null): GitHubMentionCandidate[] | null {
  if (view?.status !== 'ok') return null;
  return [
    ...view.pulls.map((pull) => ({
      kind: 'pull' as const,
      number: pull.number,
      title: pull.title,
      author: pull.author,
      url: pull.url,
      draft: pull.draft,
    })),
    ...view.issues.map((issue) => ({
      kind: 'issue' as const,
      number: issue.number,
      title: issue.title,
      author: issue.author,
      url: issue.url,
    })),
  ].filter((item) => item.url.startsWith('https://github.com/'));
}

/**
 * `#` in the desktop composer: the project's open pull requests and issues
 * (an exact number that is not open is looked up on its own); a pick inserts
 * the item's github.com URL. Keys go to the list only while it has matches, so
 * `#` in prose or a project without GitHub never holds Enter.
 */
export function useComposerGitHub({
  draft,
  cursor,
  projectId,
  http,
  suppressed,
  onInsert,
  onDismiss,
}: {
  draft: string;
  cursor: number;
  projectId: string;
  http: EngineHttp;
  /** Another list owns the keys, or the user dismissed this one here. */
  suppressed: boolean;
  onInsert: (text: string, cursor: number) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('activity', { i18n: surfaceI18n });
  const mention = suppressed ? null : detectGitHubMention(draft, cursor);
  const mentioning = mention !== null;
  const [catalog, setCatalog] = useState<{
    projectId: string;
    at: number;
    items: GitHubMentionCandidate[] | null;
  } | null>(null);
  const [resolved, setResolved] = useState<{
    lookup: string;
    item: GitHubMentionCandidate | null;
  } | null>(null);
  const [selected, setSelected] = useState(0);
  const current = catalog?.projectId === projectId ? catalog : null;
  const stale = !current || Date.now() - current.at > FRESH_MS;
  useEffect(() => {
    if (!mentioning || !stale) return;
    let live = true;
    http('/api/github')
      .then((data) => candidates(data as GitHubRepositoryView))
      .catch(() => null)
      .then((items) => {
        if (live) setCatalog({ projectId, at: Date.now(), items });
      });
    return () => {
      live = false;
    };
  }, [mentioning, stale, projectId, http]);
  const items = current?.items ?? null;
  const exact = mention && /^\d{1,9}$/.test(mention.query) ? Number(mention.query) : null;
  const lookup =
    items && exact && !items.some((item) => item.number === exact) ? `${projectId}:${exact}` : '';
  useEffect(() => {
    if (!lookup || exact === null) return;
    let live = true;
    const timer = setTimeout(async () => {
      // Pull first: the issues endpoint also answers for a pull request number.
      for (const kind of ['pull', 'issue'] as const) {
        try {
          const view = (await http(
            `/api/github/item?kind=${kind}&number=${exact}&parts=none`,
          )) as GitHubItemDetailView;
          const item = view?.status === 'ok' ? view.item : null;
          if (item?.url.startsWith('https://github.com/')) {
            if (live)
              setResolved({
                lookup,
                item: {
                  kind: item.kind,
                  number: item.number,
                  title: item.title,
                  author: item.author,
                  url: item.url,
                },
              });
            return;
          }
        } catch {
          if (!live) return;
        }
      }
      if (live) setResolved({ lookup, item: null });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [lookup, exact, http]);
  const extra = lookup && resolved?.lookup === lookup ? resolved.item : null;
  const matches =
    items && mention
      ? [...matchGitHubMentions(items, mention.query).slice(0, 12), ...(extra ? [extra] : [])]
      : [];
  const query = mention?.query;
  useEffect(() => {
    setSelected(0);
  }, [query]);
  const active = Math.min(selected, Math.max(0, matches.length - 1));
  const pick = (url: string) => {
    if (!mention) return;
    const next = insertGitHubMention(draft, mention, url);
    onInsert(next.text, next.cursor);
  };
  const onKey = (key: string, shift: boolean): boolean => {
    if (!matches.length || (key === 'Enter' && shift)) return false;
    if (key === 'Escape') onDismiss();
    else if (key === 'ArrowDown' || key === 'ArrowUp')
      setSelected(
        (index) => (index + (key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length,
      );
    else if (key === 'Enter' || key === 'Tab') {
      const item = matches[active];
      if (item) pick(item.url);
    } else return false;
    return true;
  };
  const popup = matches.length ? (
    <section className="composer-mention-popup" aria-label={t('github.mentionTitle')}>
      <header>
        <GitPullRequest size={14} /> {t('github.mentionTitle')}
        <small>{t('github.mentionHint')}</small>
      </header>
      <div role="listbox" aria-label={t('github.mentionTitle')}>
        {matches.map((item, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            key={`${item.kind}:${item.number}`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => pick(item.url)}
          >
            <strong>
              #{item.number} {item.title}
            </strong>
            <span>
              {t(item.kind === 'pull' ? 'github.mentionPull' : 'github.mentionIssue')}
              {item.author ? ` · ${item.author}` : ''}
            </span>
          </button>
        ))}
      </div>
    </section>
  ) : null;
  return { onKey, popup };
}
