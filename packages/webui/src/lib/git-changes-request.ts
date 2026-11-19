import { safeId } from '@/lib/utils';

/**
 * The latest `git.changes` request. Requests are answered concurrently and the
 * server echoes each one's requestId (correlatedReply), so a snapshot from an
 * older request answered last can be told apart and dropped.
 */
let latest = '';

/** A requestId for a new `git.changes` request; it becomes the one whose answer is shown. */
export function nextGitChangesRequest(): string {
  latest = `git-changes-${safeId()}`;
  return latest;
}

/** True for an answer to an older request. A reply without a requestId still applies. */
export function isStaleGitChangesReply(requestId: unknown): boolean {
  return typeof requestId === 'string' && requestId !== latest;
}
