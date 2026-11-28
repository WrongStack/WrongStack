import type {
  GitHubActionRequest,
  GitHubActionResult,
  GitHubItemDetailView,
} from '@wrongstack/webui-protocol';
import { useEffect, useState } from 'react';
import { surfaceFetch } from '../host';
import { useGitHubSessionId, withGitHubSession } from './github-session';
import type { GitHubSelection } from './github-view-model';

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

/** One pull request or issue of the active session's project. */
export function useGitHubItem(selection: GitHubSelection | null) {
  const sessionId = useGitHubSessionId();
  const [generation, setGeneration] = useState(0);
  const key = selection ? `${sessionId ?? 'host'}:${selection.kind}:${selection.number}` : '';
  const [state, setState] = useState<{ key: string; data: GitHubItemDetailView } | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!selection) return;
    const controller = new AbortController();
    setError(null);
    setLoading(true);
    surfaceFetch(
      withGitHubSession('/api/github/item', sessionId, {
        kind: selection.kind,
        number: String(selection.number),
      }),
      { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' },
    )
      .then((response) => readJson<GitHubItemDetailView>(response))
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data });
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError({ key, text: reason.message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [key, selection, sessionId, generation]);
  return {
    view: state?.key === key ? state.data : null,
    error: error?.key === key ? error.text : null,
    loading,
    reload: () => setGeneration((g) => g + 1),
  };
}

/** Run one write the user asked for; GitHub's refusal comes back typed, not thrown. */
export async function runGitHubAction(
  sessionId: string | null | undefined,
  request: GitHubActionRequest,
): Promise<GitHubActionResult> {
  const response = await surfaceFetch(withGitHubSession('/api/github/action', sessionId), {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return readJson<GitHubActionResult>(response);
}
