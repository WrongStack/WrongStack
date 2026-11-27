import type { GitHubItemDetailView, GitHubRepositoryView } from '@wrongstack/webui-protocol';
import { CircleDot, GitPullRequest, GitPullRequestDraft } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import {
  detectGitHubMention,
  type GitHubMentionCandidate,
  insertGitHubMention,
  matchGitHubMentions,
} from './github-mention';

const FRESH_MS = 30_000;

type Catalog = { session: string; at: number; items: GitHubMentionCandidate[] | null };

function candidates(view: GitHubRepositoryView): GitHubMentionCandidate[] | null {
  if (view.status !== 'ok') return null;
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
 * `#` in the composer lists the project's open pull requests and issues; an
 * exact number that is not open (closed, merged) is looked up on its own. The
 * list opens only when something matches, so a Markdown heading, a project
 * without GitHub, or `#3` in prose never opens it or holds Enter.
 */
export function useGitHubMentionPicker(
  input: string,
  setInput: (text: string) => void,
  textarea: React.RefObject<HTMLTextAreaElement | null>,
  sessionId: string | null | undefined,
) {
  const { t } = useAppTranslation();
  const listId = useId();
  const pendingSelection = useRef<{ text: string; cursor: number } | null>(null);
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState(0);
  const session = sessionId ?? 'host';
  const key = `${session}\0${input}\0${cursor}`;
  const mention = dismissed === key ? null : detectGitHubMention(input, cursor);
  const current = catalog?.session === session ? catalog : null;
  const stale = !current || Date.now() - current.at > FRESH_MS;
  const mentioning = mention !== null;
  useEffect(() => {
    if (!mentioning || !stale) return;
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (sessionId) query.set('sessionId', sessionId);
    fetch(`/api/github?${query}`, {
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(async (response) => (response.ok ? candidates(await response.json()) : null))
      .catch(() => null)
      .then((items) => {
        if (!controller.signal.aborted) setCatalog({ session, at: Date.now(), items });
      });
    return () => controller.abort();
  }, [mentioning, stale, session, sessionId]);
  const items = current?.items ?? null;
  const exact = mention && /^\d{1,9}$/.test(mention.query) ? Number(mention.query) : null;
  const lookup =
    items && exact && !items.some((item) => item.number === exact) ? `${session}:${exact}` : '';
  const [resolved, setResolved] = useState<{
    lookup: string;
    item: GitHubMentionCandidate | null;
  } | null>(null);
  useEffect(() => {
    if (!lookup || exact === null) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      // Pull first: the issues endpoint also answers for a pull request number.
      for (const kind of ['pull', 'issue'] as const) {
        const query = new URLSearchParams({ kind, number: String(exact), parts: 'none' });
        if (sessionId) query.set('sessionId', sessionId);
        try {
          const response = await fetch(`/api/github/item?${query}`, {
            signal: controller.signal,
            credentials: 'same-origin',
            cache: 'no-store',
          });
          const view = response.ok ? ((await response.json()) as GitHubItemDetailView) : null;
          const item = view?.status === 'ok' ? view.item : null;
          if (item?.url.startsWith('https://github.com/')) {
            setResolved({
              lookup,
              item: {
                kind: item.kind,
                number: item.number,
                title: item.title,
                author: item.author,
                url: item.url,
                draft: item.pull?.draft ?? false,
              },
            });
            return;
          }
        } catch {
          if (controller.signal.aborted) return;
        }
      }
      if (!controller.signal.aborted) setResolved({ lookup, item: null });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [lookup, exact, sessionId]);
  const extra = lookup && resolved?.lookup === lookup ? resolved.item : null;
  const matches =
    items && mention
      ? [...matchGitHubMentions(items, mention.query).slice(0, 12), ...(extra ? [extra] : [])]
      : [];
  const open = matches.length > 0;
  useEffect(() => {
    setSelected(0);
  }, [mention?.query]);
  useEffect(() => {
    if (open)
      document.getElementById(`${listId}-${selected}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, listId, selected, matches.length]);
  const pick = (url: string) => {
    if (!mention) return;
    const next = insertGitHubMention(input, mention, url);
    pendingSelection.current = next;
    setInput(next.text);
    setCursor(next.cursor);
  };
  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    pendingSelection.current = null;
    const element = textarea.current;
    if (pending && element?.value === pending.text) {
      element.focus();
      element.setSelectionRange(pending.cursor, pending.cursor);
    }
  }, [input, cursor, textarea]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(key);
      return true;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((index) =>
        matches.length
          ? (index + (event.key === 'ArrowUp' ? -1 : 1) + matches.length) % matches.length
          : 0,
      );
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      // While the list is open, Enter belongs to it (same contract as `@` and `$`).
      event.preventDefault();
      const candidate = matches[selected];
      if (candidate) pick(candidate.url);
      return true;
    }
    return false;
  };
  const popup = !open ? null : (
    <div
      className="absolute bottom-full z-50 mb-2 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
      style={{ maxHeight: 'min(18rem, 45vh)' }}
      id={listId}
      role="listbox"
      aria-label={t('activity:github.mentionTitle')}
    >
      <div className="px-3 py-2 text-xs text-muted-foreground">
        {t('activity:github.mentionTitle')} · {t('activity:github.mentionHint')}
      </div>
      {matches.map((item, index) => {
        const Icon =
          item.kind === 'issue' ? CircleDot : item.draft ? GitPullRequestDraft : GitPullRequest;
        return (
          <button
            key={`${item.kind}:${item.number}`}
            type="button"
            role="option"
            id={`${listId}-${index}`}
            aria-selected={index === selected}
            onMouseEnter={() => setSelected(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(item.url)}
            className={`flex w-full items-start gap-2 rounded px-3 py-2 text-left ${index === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}`}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">
                <span className="font-medium">#{item.number}</span> {item.title}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {t(
                  item.kind === 'pull'
                    ? 'activity:github.mentionPull'
                    : 'activity:github.mentionIssue',
                )}
                {item.author ? ` · ${item.author}` : ''}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
  return {
    open,
    popup,
    onKeyDown,
    setCursor,
    listId,
    activeId: matches.length ? `${listId}-${selected}` : undefined,
  };
}
