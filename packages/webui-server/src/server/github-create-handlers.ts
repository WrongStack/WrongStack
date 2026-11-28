import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  GitHubBranchState,
  GitHubCreateContext,
  GitHubCreateRequest,
  GitHubCreateResult,
} from '@wrongstack/webui-protocol';
import {
  defaultGitHubSeams,
  type GitHubDeps,
  type GitHubSeams,
  GitHubStatusError,
  type GitHubToken,
  gitHubWriteStatus,
  githubApi,
  itemUrl,
  readGitHubWriteBody,
  refuseGitHubWrite,
  replyJson,
  resolveRepository,
  resolveRequestProject,
  text,
} from './github-client.js';

/**
 * Opening a new issue, or a pull request from the project's checked-out
 * branch. The server never pushes: a branch GitHub does not have, or has at
 * another commit, is reported so the user (or an agent they hand it to) can
 * push it first.
 */

const BODY_CAP = 20_000;
const TITLE_CAP = 256;

/**
 * A branch name safe in an API path and as a pull request head: git's ref
 * rules for the characters used in practice, no `..`, no empty or dot-led
 * segment, no leading `-`, no `.lock` component.
 */
function validBranchName(name: string): boolean {
  if (name.length > 200 || !/^[A-Za-z0-9._\-/+]+$/.test(name) || name.startsWith('-')) return false;
  return name
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))
    ? !name.includes('..')
    : false;
}

const refPath = (name: string) => name.split('/').map(encodeURIComponent).join('/');

async function branchState(
  seams: GitHubSeams,
  token: GitHubToken | null,
  repository: string,
  name: string,
  head: string,
): Promise<{
  state: GitHubBranchState;
  openPull: { number: number; title: string; url: string } | null;
}> {
  const ref = await githubApi<{ object?: { sha?: unknown } }>(
    seams,
    token,
    `repos/${repository}/git/ref/heads/${refPath(name)}`,
    { allow: [404] },
  );
  if (ref.httpStatus === 404) return { state: 'not-pushed', openPull: null };
  const owner = repository.split('/')[0]!;
  const pulls = await githubApi<unknown[]>(
    seams,
    token,
    `repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${name}`)}&per_page=1`,
  );
  const first = Array.isArray(pulls.data)
    ? (pulls.data[0] as { number?: unknown; title?: unknown } | undefined)
    : undefined;
  const number = first?.number;
  return {
    state: ref.data?.object?.sha === head ? 'ready' : 'out-of-sync',
    openPull:
      typeof number === 'number' && Number.isSafeInteger(number) && number > 0
        ? { number, title: text(first?.title, 300), url: itemUrl(repository, 'pull', number) }
        : null,
  };
}

/** `GET /api/github/create-context?sessionId=…` — what the new-item form can offer. */
export async function handleGitHubCreateContext(
  res: ServerResponse,
  url: URL,
  deps: GitHubDeps,
): Promise<void> {
  const projectRoot = await resolveRequestProject(res, url, deps);
  if (!projectRoot) return;
  const seams = deps.github ?? defaultGitHubSeams;
  const target = await resolveRepository(seams, projectRoot);
  const context = (patch: Partial<GitHubCreateContext>): GitHubCreateContext => ({
    status: 'ok',
    repository: target.repository,
    tokenSource: target.token?.source ?? 'none',
    defaultBranch: null,
    branch: null,
    ...patch,
  });
  if (target.status !== 'ok') return replyJson(res, 200, context({ status: target.status }));
  try {
    const [local, repo] = await Promise.all([
      seams.readBranch(projectRoot),
      githubApi<{ default_branch?: unknown }>(seams, target.token, `repos/${target.repository}`),
    ]);
    const defaultBranch = text(repo.data?.default_branch, 200) || null;
    const name = local.name;
    const known: GitHubBranchState | null = !name
      ? 'detached'
      : name === defaultBranch
        ? 'default'
        : !validBranchName(name)
          ? 'unsupported'
          : null;
    const remote =
      known || !name
        ? { state: known ?? 'detached', openPull: null }
        : await branchState(seams, target.token, target.repository, name, local.head);
    replyJson(
      res,
      200,
      context({
        defaultBranch,
        branch: { name, state: remote.state, subject: local.subject, openPull: remote.openPull },
      }),
    );
  } catch (error) {
    if (!(error instanceof GitHubStatusError)) throw error;
    replyJson(res, 200, context({ status: error.status }));
  }
}

function parseCreateRequest(input: Record<string, unknown>): GitHubCreateRequest | string {
  const kind = input['kind'];
  if (kind !== 'issue' && kind !== 'pull') return 'kind must be issue or pull';
  const title = typeof input['title'] === 'string' ? input['title'].trim() : '';
  if (!title || title.length > TITLE_CAP || /[\u0000-\u001f\u007f]/.test(title))
    return `A one-line title of at most ${TITLE_CAP} characters is required`;
  const body = input['body'] ?? '';
  if (typeof body !== 'string' || body.length > BODY_CAP) return 'The text is too long';
  if (kind === 'issue') return { kind, title, body };
  const base = input['base'];
  const head = input['head'];
  if (typeof base !== 'string' || !validBranchName(base)) return 'A valid base branch is required';
  if (typeof head !== 'string' || !validBranchName(head)) return 'A valid head branch is required';
  const draft = input['draft'] ?? false;
  if (typeof draft !== 'boolean') return 'draft must be true or false';
  return { kind, title, body, base, head, draft };
}

/** `POST /api/github/create?sessionId=…` with a {@link GitHubCreateRequest} body. */
export async function handleGitHubCreate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: GitHubDeps,
  invalidate: (repository: string) => void,
  accessTokenOk: boolean,
): Promise<void> {
  if (refuseGitHubWrite(req, res, accessTokenOk)) return;
  const raw = await readGitHubWriteBody(req);
  if (!raw) {
    replyJson(res, 400, { error: 'Send a JSON object body' });
    return;
  }
  const input = parseCreateRequest(raw);
  if (typeof input === 'string') {
    replyJson(res, 400, { error: input });
    return;
  }
  const projectRoot = await resolveRequestProject(res, url, deps);
  if (!projectRoot) return;
  const seams = deps.github ?? defaultGitHubSeams;
  const reply = (result: GitHubCreateResult) => replyJson(res, 200, result);
  if (input.kind === 'pull' && (await seams.readBranch(projectRoot)).name !== input.head)
    return reply({ ok: false, status: 'conflict' });
  const target = await resolveRepository(seams, projectRoot);
  if (target.status !== 'ok') return reply({ ok: false, status: target.status });
  if (!target.token) return reply({ ok: false, status: 'needs-auth' });
  try {
    const created = await githubApi<{ number?: unknown }>(
      seams,
      target.token,
      `repos/${target.repository}/${input.kind === 'pull' ? 'pulls' : 'issues'}`,
      {
        method: 'POST',
        body:
          input.kind === 'pull'
            ? {
                title: input.title,
                head: input.head,
                base: input.base,
                body: input.body ?? '',
                draft: input.draft ?? false,
              }
            : { title: input.title, body: input.body ?? '' },
      },
    );
    const number = created.data?.number;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0)
      return reply({ ok: false, status: 'unavailable' });
    invalidate(target.repository);
    reply({
      ok: true,
      status: 'done',
      item: { kind: input.kind, number, url: itemUrl(target.repository, input.kind, number) },
    });
  } catch (error) {
    if (!(error instanceof GitHubStatusError)) throw error;
    reply({
      ok: false,
      status: gitHubWriteStatus(error),
      ...(error.detail ? { message: error.detail } : {}),
    });
  }
}
