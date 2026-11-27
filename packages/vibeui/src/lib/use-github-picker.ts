'use client';

import {
  detectGitHubMention,
  type GitHubItemDetailView,
  type GitHubMentionCandidate,
  type GitHubRepositoryView,
  insertGitHubMention,
  matchGitHubMentions,
} from '@wrongstack/webui-protocol';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { SessionController } from './use-session';

const FRESH_MS = 30_000;

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
 * `#` lists the session project's open pull requests and issues (served by
 * the same host as VibeUI); an exact number that is not open is looked up on
 * its own. A pick inserts the item's github.com URL. The list opens only when
 * something matches, so `#` in prose or a project without GitHub never holds Enter.
 */
export function useGitHubPicker(
  input: string,
  setInput: (value: string) => void,
  textarea: React.RefObject<HTMLTextAreaElement | null>,
  controller: SessionController,
) {
  const { state, connection } = controller;
  const listId = useId();
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const [selected, setSelected] = useState(0);
  const [catalog, setCatalog] = useState<{
    session: string;
    at: number;
    items: GitHubMentionCandidate[] | null;
  } | null>(null);
  const [resolved, setResolved] = useState<{
    lookup: string;
    item: GitHubMentionCandidate | null;
  } | null>(null);
  const selection = useRef<number | null>(null);
  const session = state.id ?? '';
  const key = `${session}\0${input}\0${cursor}`;
  const mention =
    dismissed === key || connection !== 'open' || !session
      ? null
      : detectGitHubMention(input, cursor);
  const mentioning = mention !== null;
  const current = catalog?.session === session ? catalog : null;
  const stale = !current || Date.now() - current.at > FRESH_MS;
  useEffect(() => {
    if (!mentioning || !stale) return;
    const controllerAbort = new AbortController();
    fetch(`/api/github?${new URLSearchParams({ sessionId: session })}`, {
      signal: controllerAbort.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(async (response) => (response.ok ? candidates(await response.json()) : null))
      .catch(() => null)
      .then((items) => {
        if (!controllerAbort.signal.aborted) setCatalog({ session, at: Date.now(), items });
      });
    return () => controllerAbort.abort();
  }, [mentioning, stale, session]);
  const items = current?.items ?? null;
  const exact = mention && /^\d{1,9}$/.test(mention.query) ? Number(mention.query) : null;
  const lookup =
    items && exact && !items.some((item) => item.number === exact) ? `${session}:${exact}` : '';
  useEffect(() => {
    if (!lookup || exact === null) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      // Pull first: the issues endpoint also answers for a pull request number.
      for (const kind of ['pull', 'issue'] as const) {
        const query = new URLSearchParams({
          kind,
          number: String(exact),
          parts: 'none',
          sessionId: session,
        });
        try {
          const response = await fetch(`/api/github/item?${query}`, {
            signal: abort.signal,
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
              },
            });
            return;
          }
        } catch {
          if (abort.signal.aborted) return;
        }
      }
      if (!abort.signal.aborted) setResolved({ lookup, item: null });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [lookup, exact, session]);
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
      document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, listId, selected]);
  useLayoutEffect(() => {
    if (selection.current === null) return;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(selection.current, selection.current);
    selection.current = null;
  }, [input, textarea]);
  const pick = (url: string) => {
    if (!mention) return;
    const next = insertGitHubMention(input, mention, url);
    selection.current = next.cursor;
    setInput(next.text);
    setCursor(next.cursor);
  };
  return {
    open,
    listId,
    matches,
    selected,
    pick,
    trackCursor: () => setCursor(textarea.current?.selectionStart ?? 0),
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || event.nativeEvent.isComposing) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(key);
        return true;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected(
          (value) =>
            (value + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length,
        );
        return true;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        const item = matches[selected];
        if (item) pick(item.url);
        return true;
      }
      return false;
    },
  };
}
