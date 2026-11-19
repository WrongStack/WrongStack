'use client';

import { useEffect, useRef, useState } from 'react';
import { record } from './session';
import type { SessionController } from './use-session';

/**
 * Project files matching an `@` mention. The server answers requests
 * concurrently, so a reply for an earlier query can arrive after the current
 * one; each reply names its query, and only the latest one sent is shown.
 * A reply without a query (an older engine) is shown as before.
 */
export function useFileMentions(
  query: string | undefined,
  enabled: boolean,
  controller: Pick<SessionController, 'state' | 'send' | 'subscribe'>,
): string[] {
  const { state, send, subscribe } = controller;
  const [matches, setMatches] = useState<string[]>([]);
  const requested = useRef<string | undefined>(undefined);
  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.type !== 'files.list') return;
        const p = record(frame.payload);
        if (typeof p.query === 'string' && p.query !== requested.current) return;
        setMatches(
          Array.isArray(p.files)
            ? p.files.filter((v): v is string => typeof v === 'string').slice(0, 30)
            : [],
        );
      }),
    [subscribe],
  );
  useEffect(() => {
    if (query === undefined || !enabled) return;
    const timer = setTimeout(() => {
      if (send('files.list', { sessionId: state.id, query, limit: 12 })) requested.current = query;
    }, 120);
    return () => clearTimeout(timer);
  }, [query, enabled, send, state.id]);
  return matches;
}
