import type {
  GitHubCreateContext,
  GitHubCreateRequest,
  GitHubCreateResult,
} from '@wrongstack/webui-protocol';
import { useEffect, useState } from 'react';
import { surfaceFetch } from '../host';
import { withGitHubSession } from './github-session';

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

/** What a new pull request can use: the checked-out branch, its state on GitHub, the default base. */
export function useGitHubCreateContext(sessionId: string | null, enabled: boolean) {
  const key = `${sessionId ?? 'host'}:${enabled}`;
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{ key: string; data: GitHubCreateContext } | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setError(null);
    surfaceFetch(withGitHubSession('/api/github/create-context', sessionId), {
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then((response) => readJson<GitHubCreateContext>(response))
      .then((data) => {
        if (!controller.signal.aborted) setState({ key: `${key}:${generation}`, data });
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError({ key, text: reason.message });
      });
    return () => controller.abort();
  }, [key, sessionId, enabled, generation]);
  return {
    context: state?.key === `${key}:${generation}` ? state.data : null,
    error: error?.key === key ? error.text : null,
    reload: () => setGeneration((value) => value + 1),
  };
}

/** Open an issue or a pull request; GitHub's refusal comes back typed, not thrown. */
export async function createGitHubItem(
  sessionId: string | null,
  request: GitHubCreateRequest,
): Promise<GitHubCreateResult> {
  const response = await surfaceFetch(withGitHubSession('/api/github/create', sessionId), {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return readJson<GitHubCreateResult>(response);
}
