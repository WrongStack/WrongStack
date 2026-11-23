import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { restrictFilePermissions } from '@wrongstack/core/security';
import { buildChildEnv } from '@wrongstack/core/utils';

export function automationGit(root: string, args: string[], index?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', root, ...args],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 20 * 1024 * 1024,
        encoding: 'buffer',
        env: buildChildEnv({
          extra: {
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            ...(index ? { GIT_INDEX_FILE: index } : {}),
          },
        }),
      },
      (error, stdout) =>
        error
          ? reject(
              new Error(
                'Git could not materialize the verified patch; check the clean source and patch.',
                { cause: error },
              ),
            )
          : resolve(stdout),
    );
  });
}

export interface AutomationGitChange {
  path: string;
  mode: '100644' | '100755' | '120000';
  sha: string | null;
}

/** Uses an isolated index only. Never changes the host index, worktree, HEAD or refs. */
export async function materializeAutomationPatch(
  root: string,
  patch: string,
  expectedSource: string,
  baseCommit?: string,
) {
  const project = await realpath(root);
  if (
    (await realpath(
      (await automationGit(root, ['rev-parse', '--show-toplevel'])).toString().trim(),
    )) !== project
  )
    throw new Error('PR preparation requires the Git repository root');
  const commit = baseCommit ?? (await automationGit(root, ['rev-parse', 'HEAD'])).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error('PR preparation requires a SHA-1 Git repository');
  const source = (await automationGit(root, ['rev-parse', `${commit}^{tree}`])).toString().trim();
  if (source !== expectedSource)
    throw new Error(
      'Verified source differs from the committed Git tree; rerun from a clean source',
    );
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-pr-index-'));
  try {
    const index = path.join(temporary, 'index');
    const patchFile = path.join(temporary, 'changes.patch');
    await writeFile(patchFile, patch, { mode: 0o600 });
    // F53 (WS-045 class): the patch is project source content and `mode:
    // 0o600` is a Windows no-op. Harden before git applies it (best-effort).
    await restrictFilePermissions(patchFile, { label: 'automation-patch' });
    await automationGit(root, ['read-tree', commit], index);
    await automationGit(
      root,
      ['apply', '--cached', '--binary', '--whitespace=nowarn', '--', patchFile],
      index,
    );
    const tree = (await automationGit(root, ['write-tree'], index)).toString().trim();
    const fields = (
      await automationGit(root, [
        'diff-tree',
        '-r',
        '--raw',
        '--no-abbrev',
        '--no-renames',
        '-z',
        source,
        tree,
      ])
    )
      .toString('utf8')
      .split('\0');
    const changes: AutomationGitChange[] = [];
    for (let i = 0; i < fields.length - 1; i += 2) {
      const header = fields[i]!.match(/^:\d{6} (\d{6}) [a-f0-9]{40} ([a-f0-9]{40}) [ADM T]$/);
      const file = fields[i + 1]!;
      if (
        !header ||
        !file ||
        /[\x00-\x1f\x7f]/.test(file) ||
        file.split('/').some((part) => ['.', '..', '.git'].includes(part.toLowerCase()))
      )
        throw new Error('Unsupported changed-file entry');
      const mode = header[1]!;
      if (!['000000', '100644', '100755', '120000'].includes(mode))
        throw new Error('Submodule publication is not supported');
      changes.push({
        path: file,
        mode: (mode === '000000' ? '100644' : mode) as AutomationGitChange['mode'],
        sha: mode === '000000' ? null : header[2]!,
      });
    }
    if (!changes.length || changes.length > 200)
      throw new Error('PR preparation requires 1 to 200 changed files');
    let size = 0;
    const blobs = new Map<string, Buffer>();
    for (const change of changes) {
      if (!change.sha || blobs.has(change.sha)) continue;
      const blob = await automationGit(root, ['cat-file', 'blob', change.sha]);
      size += blob.length;
      if (blob.length > 5 * 1024 * 1024 || size > 16 * 1024 * 1024)
        throw new Error('PR blobs exceed the 5 MB per-file / 16 MB total limit');
      blobs.set(change.sha, blob);
    }
    return { commit, source, tree, changes, blobs };
  } finally {
    // mkdtemp's direct owned child, independent of any input path.
    if (
      path.dirname(temporary) === os.tmpdir() &&
      path.basename(temporary).startsWith('wrongstack-pr-index-')
    )
      await rm(temporary, { recursive: true, force: true });
  }
}
