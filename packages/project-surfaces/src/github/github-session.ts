// Kept apart from github-host.ts, which host.tsx imports for its types only.
import { useSurfaceHost } from '../host';

const noSession = () => null;

/** The session id of the surface's requests (see {@link GitHubHost.useSessionId}). */
export function useGitHubSessionId(): string | null {
  const useSessionId = useSurfaceHost().github?.useSessionId ?? noSession;
  return useSessionId();
}

/** The session query parameter for an `/api/github*` request, when the host names one. */
export function withGitHubSession(
  path: string,
  sessionId: string | null | undefined,
  query: Record<string, string> = {},
): string {
  const params = new URLSearchParams(query);
  if (sessionId) params.set('sessionId', sessionId);
  return `${path}?${params}`;
}
