import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';
import { gitIsolationEnv } from '@wrongstack/primitives';
import type { WebSocket } from 'ws';
import { isUnsafeRelativePath, repoRelativePrefix } from './git-paths.js';
import { isPathInside } from './path-containment.js';
import { errMessage, send } from './ws-utils.js';

export async function gitReviewBytes(cwd: string, args: string[], input?: string) {
  const isolation = await gitIsolationEnv(cwd, { timeoutMs: 3000 });
  if (!isolation) throw Error('Git could not safely open this repository.');
  return await new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        env: { ...buildChildEnv(), ...isolation, GIT_LITERAL_PATHSPECS: '1' },
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        encoding: 'buffer',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Error(stderr.toString('utf8').trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
export async function gitReviewCommand(cwd: string, args: string[], input?: string) {
  const bytes = await gitReviewBytes(cwd, args, input);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Error('Git review requires UTF-8 text. Use whole-file controls for this file.');
  }
}

export async function gitReviewTarget(projectRoot: string, path: string, allowMissing = false) {
  if (!projectRoot || !path || path.length > 4096 || isUnsafeRelativePath(path))
    throw Error('An explicit project file is required.');
  const project = await realpath(projectRoot);
  const root = (await gitReviewCommand(project, ['rev-parse', '--show-toplevel'])).trim();
  const prefix = repoRelativePrefix(root, project);
  if (prefix && !path.startsWith(prefix)) throw Error('The file is outside this project.');
  const absolute = resolve(root, path);
  let exists = true;
  try {
    if (!(await lstat(absolute)).isFile())
      throw Error('Only regular project files support Git review.');
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }
  let physical: string;
  if (exists) physical = await realpath(absolute);
  else {
    let parent = dirname(absolute);
    while (true) {
      try {
        if (!(await lstat(parent)).isDirectory())
          throw Error('Git review cannot follow a symbolic-link parent.');
        physical = resolve(await realpath(parent), relative(parent, absolute));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dirname(parent))
          throw error;
        parent = dirname(parent);
      }
    }
  }
  if (!isPathInside(project, physical))
    throw Error('Only regular files inside this project support Git text review.');
  return { root, project, physical, exists };
}
async function reviewedPatch(projectRoot: string, path: string, staged: boolean) {
  const { root } = await gitReviewTarget(projectRoot, path);
  const patch = await gitReviewCommand(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-color',
    '--unified=3',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...(staged ? ['--cached'] : []),
    '--',
    path,
  ]);
  const starts = [...patch.matchAll(/^@@ /gm)].map((match) => match.index!);
  // Partial creation/deletion, mode changes, binary and combined merge patches
  // need separate semantics. Keep their existing whole-file controls available.
  const available =
    /^index [a-f0-9]+\.\.[a-f0-9]+ 100(?:644|755)$/m.test(patch) &&
    !/^(?:old mode|new mode|new file mode|deleted file mode|Binary files|GIT binary patch)/m.test(
      patch,
    );
  const header = starts.length ? patch.slice(0, starts[0]) : '';
  const hunks = available
    ? starts.map((start, id) => ({
        id,
        header: patch.slice(start, patch.indexOf('\n', start)),
        text: patch.slice(start, starts[id + 1] ?? patch.length),
      }))
    : [];
  return {
    root,
    header,
    patchId: createHash('sha256').update(patch).digest('hex'),
    hunks,
    reason: !patch
      ? 'No changes in this layer.'
      : available
        ? ''
        : 'Use whole-file staging for added, deleted, binary, mode-changing or conflicted files.',
  };
}

/**
 * A reviewed hunk narrowed to the selected change lines (indices into the hunk body, after its
 * `@@` line). Applied forward to the index, an unselected addition is dropped and an unselected
 * removal stays as context; applied in reverse (unstaging), the roles swap. The header counts
 * are recomputed. Hunks touching the end-of-file newline marker are left whole.
 */
export function partialHunk(text: string, selected: readonly number[], reverse: boolean): string {
  const [header = '', ...rest] = text.replace(/\n$/, '').split('\n');
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header);
  if (!match) throw Error('The selected hunk is unavailable.');
  if (rest.some((line) => line.startsWith('\\')))
    throw Error('Stage this hunk whole: it changes the end-of-file newline.');
  const chosen = new Set(selected);
  if (
    !chosen.size ||
    [...chosen].some(
      (index) =>
        !Number.isSafeInteger(index) ||
        !(rest[index]?.startsWith('+') || rest[index]?.startsWith('-')),
    )
  )
    throw Error('Select one or more added or removed lines of this hunk.');
  // Within each run of changes, the side the patch is applied to keeps its order: forward, the
  // removed lines (selected stay removals, the rest become context) with the selected additions
  // after the last selected removal; in reverse, the mirror of that.
  const body: string[] = [];
  let run: { line: string; index: number }[] = [];
  const flush = () => {
    const kept = reverse ? '+' : '-';
    const fixed = run
      .filter(({ line }) => line.startsWith(kept))
      .map(({ line, index }) => (chosen.has(index) ? line : ` ${line.slice(1)}`));
    const moved = run
      .filter(({ line, index }) => !line.startsWith(kept) && chosen.has(index))
      .map(({ line }) => line);
    const anchors = run
      .filter(({ line }) => line.startsWith(kept))
      .map(({ index }) => chosen.has(index));
    // Forward: after the last selected removal (else at the end). Reverse: before the first
    // selected addition (else at the start).
    const at = reverse
      ? Math.max(0, anchors.indexOf(true))
      : anchors.lastIndexOf(true) === -1
        ? fixed.length
        : anchors.lastIndexOf(true) + 1;
    body.push(...fixed.slice(0, at), ...moved, ...fixed.slice(at));
    run = [];
  };
  rest.forEach((line, index) => {
    if (line.startsWith(' ')) {
      flush();
      body.push(line);
    } else run.push({ line, index });
  });
  flush();
  const oldCount = body.filter((line) => !line.startsWith('+')).length;
  const newCount = body.filter((line) => !line.startsWith('-')).length;
  return `@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3]}\n${body.join('\n')}\n`;
}

/** Server-generated patches only: the caller selects a reviewed hunk, never sends executable patch text. */
export async function handleGitHunks(
  ws: WebSocket,
  projectRoot: string,
  payload: unknown,
  apply = false,
) {
  const type = apply ? 'git.action_result' : 'git.hunks';
  try {
    const value =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (
      typeof value['path'] !== 'string' ||
      !['unstaged', 'staged'].includes(String(value['layer']))
    )
      throw Error('Choose a file and a valid Git layer.');
    const staged = value['layer'] === 'staged';
    const review = await reviewedPatch(projectRoot, value['path'], staged);
    if (!apply) {
      send(ws, {
        type: 'git.hunks',
        payload: {
          path: value['path'],
          layer: value['layer'],
          patchId: review.patchId,
          hunks: review.hunks,
          reason: review.reason,
        },
      });
      return;
    }
    if (value['patchId'] !== review.patchId)
      throw Error('This diff changed since review. Refresh hunks before staging.');
    const id = value['hunk'];
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || !review.hunks[id])
      throw Error('The selected hunk is unavailable.');
    // Optional line selection: still a server-built patch from the reviewed hunk.
    const lines = value['lines'];
    if (lines !== undefined && !Array.isArray(lines))
      throw Error('Select one or more added or removed lines of this hunk.');
    const hunkText = lines
      ? partialHunk(review.hunks[id]!.text, lines as number[], staged)
      : review.hunks[id]!.text;
    const patch = review.header + hunkText;
    await gitReviewCommand(
      review.root,
      [
        'apply',
        '--cached',
        '--whitespace=nowarn',
        ...(lines ? ['--recount'] : []),
        ...(staged ? ['--reverse'] : []),
        '-',
      ],
      patch,
    );
    const unit = lines ? 'lines' : 'hunk';
    send(ws, {
      type: 'git.action_result',
      payload: {
        ok: true,
        action: staged ? `unstage-${unit}` : `stage-${unit}`,
        path: value['path'],
      },
    });
  } catch (error) {
    send(ws, {
      type,
      payload: { ok: false, error: errMessage(error) },
    });
  }
}
