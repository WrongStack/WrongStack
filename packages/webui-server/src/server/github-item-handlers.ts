import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  GitHubAction,
  GitHubActionResult,
  GitHubCheck,
  GitHubItemDetail,
  GitHubItemDetailView,
  GitHubItemKind,
  GitHubLineComment,
  GitHubMergeMethod,
  GitHubPullFile,
  GitHubReview,
} from '@wrongstack/webui-protocol';
import {
  count,
  defaultGitHubSeams,
  type GitHubDeps,
  type GitHubSeams,
  GitHubStatusError,
  type GitHubToken,
  githubApi,
  githubPage,
  login,
  replyJson,
  resolveRepository,
  resolveRequestProject,
  text,
  toBaseItem,
} from './github-client.js';

/**
 * One pull request or issue in detail, and the writes the WebUI offers on it.
 * Writes are user actions from the page: they need a browser `Origin`, a JSON
 * body, a token, and (for reviews and merges) the head SHA the user looked at,
 * so GitHub refuses them if the branch moved in between.
 */

const BODY_CAP = 20_000;
const PATCH_CAP = 60_000;
const PATCH_BUDGET = 400_000;
const ACTION_BODY_CAP = 10_000;
const ACTIONS: readonly GitHubAction[] = [
  'comment',
  'approve',
  'request-changes',
  'merge',
  'close',
  'reopen',
  'rerun-failed',
  'line-comment',
  'review',
];
const MERGE_METHODS: readonly GitHubMergeMethod[] = ['merge', 'squash', 'rebase'];
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function parseNumber(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseKind(value: unknown): GitHubItemKind | null {
  return value === 'pull' || value === 'issue' ? value : null;
}

/** A part of the detail that may fail on its own without blanking the rest. */
async function settle<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

function list(data: unknown, key?: string): unknown[] {
  const value =
    key && data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : data;
  return Array.isArray(value) ? value : [];
}

async function readChecks(
  seams: GitHubSeams,
  token: GitHubToken | null,
  repository: string,
  sha: string,
): Promise<GitHubCheck[] | null> {
  const [runs, statuses] = await Promise.all([
    settle(() =>
      githubApi(seams, token, `repos/${repository}/commits/${sha}/check-runs?per_page=100`),
    ),
    settle(() => githubApi(seams, token, `repos/${repository}/commits/${sha}/status`)),
  ]);
  if (!runs && !statuses) return null;
  const checks: GitHubCheck[] = list(runs?.data, 'check_runs').map((raw) => {
    const run = (raw ?? {}) as Record<string, unknown>;
    return {
      name: text(run['name'], 200),
      status: text(run['status'], 40),
      conclusion: typeof run['conclusion'] === 'string' ? text(run['conclusion'], 40) : null,
      url: githubPage(run['html_url']),
    };
  });
  for (const raw of list(statuses?.data, 'statuses')) {
    const status = (raw ?? {}) as Record<string, unknown>;
    const state = text(status['state'], 40);
    checks.push({
      name: text(status['context'], 200),
      status: state === 'pending' ? 'in_progress' : 'completed',
      conclusion: state === 'pending' ? null : state,
      url: githubPage(status['target_url']),
    });
  }
  return checks.filter((check) => check.name).slice(0, 150);
}

async function readPullParts(
  seams: GitHubSeams,
  token: GitHubToken | null,
  repository: string,
  number: number,
  raw: Record<string, unknown>,
): Promise<NonNullable<GitHubItemDetail['pull']>> {
  const head = (raw['head'] ?? {}) as Record<string, unknown>;
  const base = (raw['base'] ?? {}) as Record<string, unknown>;
  const headSha = text(head['sha'], 64);
  const repoName = (value: unknown) =>
    (value as { full_name?: unknown } | null | undefined)?.full_name;
  let patchBudget = PATCH_BUDGET;
  const [files, checks, reviews, lineComments] = await Promise.all([
    settle(async () =>
      list(
        (await githubApi(seams, token, `repos/${repository}/pulls/${number}/files?per_page=100`))
          .data,
      ).map((file): GitHubPullFile => {
        const record = (file ?? {}) as Record<string, unknown>;
        const raw = typeof record['patch'] === 'string' ? record['patch'] : null;
        // One shared budget, so a pull request with many files stays a bounded reply.
        const take = raw === null ? 0 : Math.min(raw.length, PATCH_CAP, patchBudget);
        patchBudget -= take;
        const cut = raw === null ? '' : raw.slice(0, take);
        // A cut patch ends on a whole line, so the hunk parser never sees half of one.
        const patch =
          raw !== null && take < raw.length ? cut.slice(0, cut.lastIndexOf('\n') + 1) : cut;
        return {
          path: text(record['filename'], 500),
          status: text(record['status'], 40),
          additions: count(record['additions']),
          deletions: count(record['deletions']),
          patch: patch ? patch : null,
          patchTruncated: raw !== null && take < raw.length,
        };
      }),
    ),
    SHA.test(headSha) ? readChecks(seams, token, repository, headSha) : Promise.resolve(null),
    settle(async () =>
      list(
        (await githubApi(seams, token, `repos/${repository}/pulls/${number}/reviews?per_page=100`))
          .data,
      )
        .map((review): GitHubReview => {
          const record = (review ?? {}) as Record<string, unknown>;
          return {
            author: login(record['user']),
            state: text(record['state'], 40),
            submittedAt: text(record['submitted_at'], 40),
            body: text(record['body'], 2000),
          };
        })
        .filter((review) => review.state && review.state !== 'PENDING')
        .slice(-30),
    ),
    settle(async () =>
      list(
        (await githubApi(seams, token, `repos/${repository}/pulls/${number}/comments?per_page=100`))
          .data,
      ).map((comment): GitHubLineComment => {
        const record = (comment ?? {}) as Record<string, unknown>;
        const line = record['line'];
        return {
          path: text(record['path'], 500),
          // GitHub sends `line: null` once the commented line left the diff.
          line: typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? line : null,
          side: record['side'] === 'LEFT' ? 'LEFT' : 'RIGHT',
          author: login(record['user']),
          body: text(record['body'], 4000),
          createdAt: text(record['created_at'], 40),
          url: githubPage(record['html_url']),
        };
      }),
    ),
  ]);
  return {
    draft: raw['draft'] === true,
    merged: raw['merged'] === true,
    mergeable: typeof raw['mergeable'] === 'boolean' ? raw['mergeable'] : null,
    mergeableState: text(raw['mergeable_state'], 40),
    headRef: text(head['ref'], 250),
    baseRef: text(base['ref'], 250),
    headSha,
    // A deleted fork leaves `head.repo` null; treat it as foreign too.
    fromFork: repoName(head['repo']) !== repoName(base['repo']) || !repoName(head['repo']),
    additions: count(raw['additions']),
    deletions: count(raw['deletions']),
    changedFiles: count(raw['changed_files']),
    files,
    checks,
    reviews,
    lineComments,
  };
}

/** `GET /api/github/item?sessionId=…&kind=pull|issue&number=N` */
export async function handleGitHubItemRead(
  res: ServerResponse,
  url: URL,
  deps: GitHubDeps,
): Promise<void> {
  const kind = parseKind(url.searchParams.get('kind'));
  const number = parseNumber(url.searchParams.get('number'));
  if (!kind || !number) {
    replyJson(res, 400, { error: 'kind must be pull or issue and number a positive integer' });
    return;
  }
  const projectRoot = await resolveRequestProject(res, url, deps);
  if (!projectRoot) return;
  const seams = deps.github ?? defaultGitHubSeams;
  const target = await resolveRepository(seams, projectRoot);
  const view = (patch: Partial<GitHubItemDetailView>): GitHubItemDetailView => ({
    status: 'ok',
    repository: target.repository,
    tokenSource: target.token?.source ?? 'none',
    item: null,
    ...patch,
  });
  if (target.status !== 'ok') {
    replyJson(res, 200, view({ status: target.status }));
    return;
  }
  const { repository, token } = target;
  try {
    const path = `repos/${repository}/${kind === 'pull' ? 'pulls' : 'issues'}/${number}`;
    const raw = (await githubApi(seams, token, path)).data;
    if (!raw || typeof raw !== 'object') throw new GitHubStatusError('unavailable');
    const record = raw as Record<string, unknown>;
    const base = toBaseItem(record, repository, kind);
    if (!base) throw new GitHubStatusError('unavailable');
    const item: GitHubItemDetail = {
      ...base,
      kind,
      state: record['state'] === 'closed' ? 'closed' : 'open',
      body: text(record['body'], BODY_CAP),
      // `parts=none` (the composer's # lookup) wants the title only, not files and patches.
      pull:
        kind === 'pull' && url.searchParams.get('parts') !== 'none'
          ? await readPullParts(seams, token, repository, number, record)
          : null,
    };
    replyJson(res, 200, view({ item }));
  } catch (error) {
    if (!(error instanceof GitHubStatusError)) throw error;
    replyJson(res, 200, view({ status: error.status }));
  }
}

async function readActionBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') return null;
  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 32_000) return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type LineTarget = { path: string; line: number; side: 'LEFT' | 'RIGHT' };

/** A line of the pull request's diff: a repository path, a positive line, a side. */
function parseLineTarget(raw: Record<string, unknown>): LineTarget | string {
  const path = raw['path'];
  const line = raw['line'];
  // A path inside the repository: no control characters, never absolute.
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 500 ||
    /[\u0000-\u001f]/.test(path) ||
    path.startsWith('/')
  )
    return 'A file path is required';
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1 || line > 10_000_000)
    return 'A positive line number is required';
  if (raw['side'] !== 'LEFT' && raw['side'] !== 'RIGHT') return 'side must be LEFT or RIGHT';
  return { path, line, side: raw['side'] };
}

const MAX_REVIEW_COMMENTS = 50;

interface ValidAction {
  kind: GitHubItemKind;
  number: number;
  action: GitHubAction;
  body: string;
  mergeMethod: GitHubMergeMethod;
  expectedHeadSha: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  comments: (LineTarget & { body: string })[];
}

function parseActionRequest(input: Record<string, unknown>): ValidAction | string {
  const kind = parseKind(input['kind']);
  const number = parseNumber(input['number']);
  const action = ACTIONS.find((name) => name === input['action']);
  if (!kind || !number || !action) return 'kind, number and a known action are required';
  const body = typeof input['body'] === 'string' ? input['body'].trim() : '';
  if (body.length > ACTION_BODY_CAP) return 'The text is too long';
  if ((action === 'comment' || action === 'request-changes' || action === 'line-comment') && !body)
    return 'This action needs a text';
  const needsHead =
    action === 'approve' ||
    action === 'request-changes' ||
    action === 'merge' ||
    action === 'rerun-failed' ||
    action === 'line-comment' ||
    action === 'review';
  if (needsHead && kind !== 'pull')
    return 'Reviews, merges and re-runs apply to pull requests only';
  const expectedHeadSha =
    typeof input['expectedHeadSha'] === 'string' ? input['expectedHeadSha'] : '';
  if (needsHead && !SHA.test(expectedHeadSha)) return 'expectedHeadSha is required';
  let target: LineTarget = { path: '', line: 0, side: 'RIGHT' };
  if (action === 'line-comment') {
    const parsed = parseLineTarget(input);
    if (typeof parsed === 'string') return parsed;
    target = parsed;
  }
  const comments: ValidAction['comments'] = [];
  if (input['comments'] !== undefined) {
    const isReview = action === 'approve' || action === 'request-changes' || action === 'review';
    if (!isReview || !Array.isArray(input['comments']))
      return 'comments go with approve, request-changes or review';
    if (input['comments'].length > MAX_REVIEW_COMMENTS) return 'Too many review comments';
    for (const raw of input['comments']) {
      if (!raw || typeof raw !== 'object') return 'A review comment must be an object';
      const record = raw as Record<string, unknown>;
      const parsed = parseLineTarget(record);
      if (typeof parsed === 'string') return parsed;
      const text = typeof record['body'] === 'string' ? record['body'].trim() : '';
      if (!text || text.length > ACTION_BODY_CAP) return 'Every review comment needs a text';
      comments.push({ ...parsed, body: text });
    }
  }
  if (action === 'review' && !body && comments.length === 0)
    return 'A review needs a text or line comments';
  const mergeMethod = input['mergeMethod'] ?? 'merge';
  if (!MERGE_METHODS.includes(mergeMethod as GitHubMergeMethod)) return 'Unknown merge method';
  return {
    kind,
    number,
    action,
    body,
    mergeMethod: mergeMethod as GitHubMergeMethod,
    expectedHeadSha,
    ...target,
    comments,
  };
}

const FAILED_RUN = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);

/**
 * The GitHub Actions runs behind the failed check runs of a commit. Only runs
 * of this repository count: a check run's page names its workflow run.
 */
async function failedActionRuns(
  seams: GitHubSeams,
  token: GitHubToken,
  repository: string,
  sha: string,
): Promise<number[]> {
  const result = await githubApi(
    seams,
    token,
    `repos/${repository}/commits/${sha}/check-runs?per_page=100`,
  );
  const prefix = `https://github.com/${repository}/actions/runs/`.toLowerCase();
  const runs = new Set<number>();
  for (const raw of list(result.data, 'check_runs')) {
    const run = (raw ?? {}) as Record<string, unknown>;
    if (!FAILED_RUN.has(String(run['conclusion']))) continue;
    const page = githubPage(run['html_url'])?.toLowerCase() ?? '';
    const id = page.startsWith(prefix)
      ? /^(\d{1,15})\//.exec(page.slice(prefix.length))?.[1]
      : null;
    if (id) runs.add(Number(id));
  }
  return [...runs].slice(0, 10);
}

function actionCall(repository: string, input: ValidAction) {
  const item = `repos/${repository}/${input.kind === 'pull' ? 'pulls' : 'issues'}/${input.number}`;
  switch (input.action) {
    case 'comment':
      // Pull requests share the issue comment thread.
      return {
        method: 'POST' as const,
        path: `repos/${repository}/issues/${input.number}/comments`,
        body: { body: input.body },
      };
    case 'approve':
    case 'request-changes':
    case 'review':
      // One review: its line comments land together, against the head shown.
      return {
        method: 'POST' as const,
        path: `${item}/reviews`,
        body: {
          event:
            input.action === 'approve'
              ? 'APPROVE'
              : input.action === 'request-changes'
                ? 'REQUEST_CHANGES'
                : 'COMMENT',
          commit_id: input.expectedHeadSha,
          ...(input.body ? { body: input.body } : {}),
          ...(input.comments.length
            ? {
                comments: input.comments.map(({ path, line, side, body }) => ({
                  path,
                  line,
                  side,
                  body,
                })),
              }
            : {}),
        },
      };
    case 'merge':
      return {
        method: 'PUT' as const,
        path: `${item}/merge`,
        body: { merge_method: input.mergeMethod, sha: input.expectedHeadSha },
      };
    case 'line-comment':
      // `commit_id` pins the comment to the head the user read; GitHub refuses
      // a line that is not part of that diff (422).
      return {
        method: 'POST' as const,
        path: `${item}/comments`,
        body: {
          body: input.body,
          commit_id: input.expectedHeadSha,
          path: input.path,
          line: input.line,
          side: input.side,
        },
      };
    case 'rerun-failed':
      throw new Error('rerun-failed is not a single call');
    case 'close':
    case 'reopen':
      return {
        method: 'PATCH' as const,
        path: item,
        body: { state: input.action === 'close' ? 'closed' : 'open' },
      };
  }
}

function actionStatus(error: GitHubStatusError): GitHubActionResult['status'] {
  if (error.httpStatus === 409) return 'conflict';
  if (error.httpStatus === 405 || error.httpStatus === 422) return 'rejected';
  if (error.status === 'not-found') return 'not-found';
  if (error.status === 'needs-auth' || error.status === 'rate-limited') return error.status;
  return 'unavailable';
}

/** `POST /api/github/action?sessionId=…` with a {@link GitHubActionRequest} body. */
export async function handleGitHubAction(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: GitHubDeps,
  invalidate: (repository: string) => void,
  accessTokenOk: boolean,
): Promise<void> {
  // Same rule as the server's global mutation gate: a write comes from a page
  // (the global guard already checked its Origin against Host) or from a
  // client holding the access token (the desktop bridge sends no Origin).
  // Neither is authentication on the token-less loopback default: a local
  // process that sets a matching Origin can still call this route, as it can
  // the automation routes; configuring the access token is what closes that.
  if (!req.headers.origin && !accessTokenOk) {
    replyJson(res, 403, {
      error: 'GitHub writes need the WebUI page or the access token',
    });
    return;
  }
  const raw = await readActionBody(req);
  if (!raw) {
    replyJson(res, 400, { error: 'Send a JSON object body' });
    return;
  }
  const input = parseActionRequest(raw);
  if (typeof input === 'string') {
    replyJson(res, 400, { error: input });
    return;
  }
  const projectRoot = await resolveRequestProject(res, url, deps);
  if (!projectRoot) return;
  const seams = deps.github ?? defaultGitHubSeams;
  const target = await resolveRepository(seams, projectRoot);
  const reply = (result: GitHubActionResult) => replyJson(res, 200, result);
  if (target.status !== 'ok') return reply({ ok: false, status: target.status });
  if (!target.token) return reply({ ok: false, status: 'needs-auth' });
  try {
    if (input.action === 'rerun-failed') {
      // Bind the re-run to this pull request's current head: a moved branch is
      // refused, like a merge, instead of restarting an old commit's jobs.
      const pullRequest = await githubApi<{ head?: { sha?: unknown } }>(
        seams,
        target.token,
        `repos/${target.repository}/pulls/${input.number}`,
      );
      if (pullRequest.data?.head?.sha !== input.expectedHeadSha)
        return reply({ ok: false, status: 'conflict' });
      const runs = await failedActionRuns(
        seams,
        target.token,
        target.repository,
        input.expectedHeadSha,
      );
      if (runs.length === 0) return reply({ ok: false, status: 'nothing-to-do' });
      for (const run of runs)
        await githubApi(
          seams,
          target.token,
          `repos/${target.repository}/actions/runs/${run}/rerun-failed-jobs`,
          { method: 'POST' },
        );
    } else {
      const call = actionCall(target.repository, input);
      await githubApi(seams, target.token, call.path, { method: call.method, body: call.body });
    }
  } catch (error) {
    if (!(error instanceof GitHubStatusError)) throw error;
    return reply({
      ok: false,
      status: actionStatus(error),
      ...(error.detail ? { message: error.detail } : {}),
    });
  }
  invalidate(target.repository);
  reply({ ok: true, status: 'done' });
}
