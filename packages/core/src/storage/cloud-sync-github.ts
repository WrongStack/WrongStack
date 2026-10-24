import { ERROR_CODES, WrongStackError } from '@wrongstack/contracts/types/errors';

/**
 * GitHub git-data API calls Cloud Sync pushes and pulls through. Each takes a
 * repo-scoped `gh` so the HTTP layer stays one method on `CloudSync`.
 */

export type LocalTreeEntry = { path: string; content: string; mode: string };
export type GitTreeEntry = LocalTreeEntry | { path: string; sha: null; mode: string };
export type RemoteTreeEntry = { path: string; sha: string; type: 'blob' | 'tree' };

/** One authenticated request against `/repos/<owner>/<repo>`; resolves to the parsed body. */
export interface GitHubFetch {
  (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    pathSegment: string,
    body?: unknown | undefined,
  ): Promise<unknown>;
  /** `owner/repo`, for error context. */
  readonly repo: string;
}

export async function getRef(gh: GitHubFetch, ref: string) {
  return (await gh('GET', `/git/refs/heads/${ref}`)) as {
    object: { sha: string };
  };
}

export async function getOptionalRef(gh: GitHubFetch, ref: string) {
  try {
    return await getRef(gh, ref);
  } catch (err) {
    if (err instanceof Error && err.message.includes('failed (404)')) return null;
    if (err instanceof Error && err.message.includes('failed (409)')) {
      throw new WrongStackError({
        message:
          'GitHub repository is empty. Initialize it with a README or first commit, then retry `/sync push`.',
        code: ERROR_CODES.UNKNOWN,
        subsystem: 'general',
        context: { repo: gh.repo, ref },
        cause: err,
      });
    }
    throw err;
  }
}

export async function createRef(gh: GitHubFetch, ref: string, sha: string) {
  await gh('POST', '/git/refs', {
    ref: `refs/heads/${ref}`,
    sha,
  });
}

export async function updateRef(gh: GitHubFetch, ref: string, sha: string) {
  await gh('PATCH', `/git/refs/heads/${ref}`, {
    sha,
    force: false,
  });
}

export async function getCommit(gh: GitHubFetch, sha: string) {
  return (await gh('GET', `/git/commits/${sha}`)) as {
    tree: { sha: string };
    message: string;
  };
}

export async function getTreeEntries(gh: GitHubFetch, treeSha: string): Promise<RemoteTreeEntry[]> {
  // GitHub returns `{ sha, tree: [...], truncated }`, NOT a bare array — the
  // previous cast made `for (const entry of ...)` throw "not iterable", so
  // pull never actually ran. Unwrap `.tree`, and refuse a truncated result
  // rather than silently syncing a partial file set.
  const res = (await gh('GET', `/git/trees/${treeSha}?recursive=1`)) as {
    tree?: Array<{ path: string; sha: string; type: 'blob' | 'tree' }>;
    truncated?: boolean;
  };
  if (res.truncated) {
    throw new WrongStackError({
      message: 'Sync tree is too large — GitHub truncated the result; refusing a partial pull.',
      code: ERROR_CODES.UNKNOWN,
      subsystem: 'general',
    });
  }
  return res.tree ?? [];
}

export async function createCommit(
  gh: GitHubFetch,
  treeSha: string,
  parentSha?: string | undefined,
  message = 'sync',
) {
  const body: Record<string, unknown> = { message, tree: treeSha };
  if (parentSha) body.parents = [parentSha];
  const result = (await gh('POST', '/git/commits', body)) as {
    sha: string;
  };
  return result.sha;
}

export async function createGitTree(
  gh: GitHubFetch,
  entries: GitTreeEntry[],
  baseTreeSha?: string | undefined,
): Promise<string> {
  const tree = entries.map((entry) =>
    'sha' in entry
      ? { path: entry.path, mode: entry.mode, type: 'blob', sha: entry.sha }
      : { path: entry.path, mode: entry.mode, type: 'blob', content: entry.content },
  );
  const body: Record<string, unknown> = { tree };
  if (baseTreeSha) body.base_tree = baseTreeSha;
  const result = (await gh('POST', '/git/trees', body)) as {
    sha: string;
  };
  return result.sha;
}

export async function getBlob(gh: GitHubFetch, sha: string): Promise<string> {
  const result = (await gh('GET', `/git/blobs/${sha}`)) as {
    content: string;
  };
  return result.content;
}
