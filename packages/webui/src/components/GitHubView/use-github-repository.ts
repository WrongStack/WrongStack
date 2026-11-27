import type { GitHubRepositoryView } from '@wrongstack/webui-protocol';
import { useEffect, useState } from 'react';
import { useActiveSessionId, useConfigStore } from '@/stores';

async function request(
  sessionId: string | null | undefined,
  refresh: boolean,
  signal: AbortSignal,
): Promise<GitHubRepositoryView> {
  const query = new URLSearchParams();
  if (sessionId) query.set('sessionId', sessionId);
  if (refresh) query.set('refresh', '1');
  const response = await fetch(`/api/github?${query}`, {
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as GitHubRepositoryView;
}

/** The active session's project repository; re-read on session or socket change. */
export function useGitHubRepository() {
  const sessionId = useActiveSessionId();
  const connected = useConfigStore((s) => s.wsConnected);
  const [generation, setGeneration] = useState(0);
  const session = sessionId ?? 'host';
  const scope = `${session}:${connected}:${generation}`;
  const [state, setState] = useState<{ session: string; data: GitHubRepositoryView } | null>(null);
  const [error, setError] = useState<{ scope: string; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setLoading(true);
    request(sessionId, generation > 0, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ session, data });
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError({ scope, text: reason.message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [scope, session, sessionId, generation]);
  return {
    session,
    // A refresh keeps the previous lists on screen until the new ones arrive.
    view: state?.session === session ? state.data : null,
    error: error?.scope === scope ? error.text : null,
    loading,
    refresh: () => setGeneration((g) => g + 1),
  };
}
