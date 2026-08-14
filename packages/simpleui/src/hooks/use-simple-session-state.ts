import { useRef, useState } from 'react';
import type { ContextInfo, SessionInfo, SimpleSessionSummary } from '../types.js';

const EMPTY_CONTEXT: ContextInfo = { load: 0, tokens: 0, maxContext: 0, cache: null };

/** Owns session identity, catalog, context, and lifecycle timestamps for SimpleUI. */
export function useSimpleSessionState() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessions, setSessions] = useState<SimpleSessionSummary[]>([]);
  const [context, setContext] = useState<ContextInfo>(EMPTY_CONTEXT);
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const activeModelRef = useRef<{ provider: string; model: string } | null>(null);

  return {
    session,
    setSession,
    sessions,
    setSessions,
    context,
    setContext,
    sessionStart,
    setSessionStart,
    sessionIdRef,
    activeModelRef,
  };
}
