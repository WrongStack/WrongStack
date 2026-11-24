import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WebSocket } from 'ws';
import { gitReviewBytes, gitReviewCommand, gitReviewTarget } from './git-hunks.js';
import { errMessage, send } from './ws-utils.js';

type Side = { mode: string; oid: string; bytes: Buffer; text: string | null };
function decode(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
async function inspect(project: string, path: string) {
  const target = await gitReviewTarget(project, path, true);
  const index = await gitReviewCommand(
    target.root,
    ['ls-files', '--unmerged', '-z', '--', path],
    undefined,
    'none',
  );
  const rows = index
    .split('\0')
    .filter(Boolean)
    .map((entry) => /^(100(?:644|755)) ([a-f0-9]+) ([123])\t/.exec(entry));
  if (
    !rows.length ||
    rows.some((row) => !row) ||
    new Set(rows.map((row) => row![3])).size !== rows.length
  )
    throw Error(
      'This file has no supported unresolved regular-file stages. Symlink and submodule conflicts require Git.',
    );
  const sides: Record<string, Side> = {};
  await Promise.all(
    rows.map(async (row) => {
      const bytes = await gitReviewBytes(
        target.root,
        ['cat-file', 'blob', row![2]!],
        undefined,
        'none',
      );
      sides[row![3]!] = { mode: row![1]!, oid: row![2]!, bytes, text: decode(bytes) };
    }),
  );
  if (target.exists && (await stat(target.physical)).size > 2 * 1024 * 1024)
    throw Error('The working conflict exceeds the 2 MiB review limit.');
  const bytes = target.exists ? await readFile(target.physical) : Buffer.alloc(0);
  const working = target.exists ? decode(bytes) : null;
  const binary =
    (target.exists && working === null) || Object.values(sides).some((side) => side.text === null);
  if (
    !binary &&
    bytes.length + Object.values(sides).reduce((total, side) => total + side.bytes.length, 0) >
      1024 * 1024
  )
    throw Error('The combined conflict preview exceeds the 1 MiB review limit.');
  // Index paths are real evidence; missing sides alone do not prove a rename relationship.
  const related = await gitReviewCommand(
    target.project,
    ['ls-files', '--full-name', '--unmerged', '-z', '--', '.'],
    undefined,
    'none',
  );
  const relatedPaths = [
    ...new Set(
      related
        .split('\0')
        .filter(Boolean)
        .map((entry) => entry.slice(entry.indexOf('\t') + 1)),
    ),
  ];
  const revision = createHash('sha256')
    .update(index)
    .update('\0')
    .update(related)
    .update(target.exists ? '\0exists\0' : '\0absent\0')
    .update(bytes)
    .digest('hex');
  const metadata = (side: Side | undefined) =>
    side
      ? {
          exists: true,
          kind: side.text === null ? 'binary' : 'text',
          bytes: side.bytes.length,
          oid: side.oid,
          mode: side.mode,
        }
      : { exists: false, kind: 'absent' };
  const view = {
    path,
    revision,
    binary,
    base: binary ? null : (sides['1']?.text ?? null),
    ours: binary ? null : (sides['2']?.text ?? null),
    theirs: binary ? null : (sides['3']?.text ?? null),
    working: binary ? null : working,
    sides: { base: metadata(sides['1']), ours: metadata(sides['2']), theirs: metadata(sides['3']) },
    workingInfo: { exists: target.exists, bytes: bytes.length },
    relatedPaths: relatedPaths.slice(0, 200),
    relatedPathsTruncated: relatedPaths.length > 200,
    unresolvedPaths: relatedPaths.length,
  };
  return { ...target, sides, view };
}
export async function handleGitConflict(
  ws: WebSocket,
  project: string,
  payload: unknown,
  resolve = false,
) {
  const type = resolve ? 'git.action_result' : 'git.conflict';
  let changed = false;
  try {
    const value =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (typeof value['path'] !== 'string')
      throw Error('Choose an explicit conflicted project file.');
    const current = await inspect(project, value['path']);
    if (!resolve) {
      send(ws, { type: 'git.conflict', payload: current.view });
      return;
    }
    if (current.view.revision !== value['revision'])
      throw Error(
        'The conflict or working file changed since review. Reload the conflict before resolving.',
      );
    const choice = value['choice'] ?? 'text';
    if (!['text', 'ours', 'theirs', 'delete'].includes(String(choice)))
      throw Error('Choose merged text, an existing side, or explicit deletion.');
    if (choice === 'delete') {
      changed = true;
      await gitReviewCommand(
        current.root,
        ['rm', '--force', '--', value['path']],
        undefined,
        'none',
      );
    } else {
      let bytes: Buffer;
      let mode: string | undefined;
      if (choice === 'ours' || choice === 'theirs') {
        const side = current.sides[choice === 'ours' ? '2' : '3'];
        if (!side)
          throw Error(
            'This side does not contain the file. Choose explicit deletion to remove it.',
          );
        bytes = side.bytes;
        mode = side.mode;
      } else {
        if (current.view.binary)
          throw Error(
            'Choose an existing binary side or explicit deletion; binary conflicts do not accept text edits.',
          );
        const text = value['text'];
        if (
          typeof text !== 'string' ||
          Buffer.byteLength(text) > 2 * 1024 * 1024 ||
          text.includes('\0')
        )
          throw Error('A UTF-8 merged result within 2 MiB is required.');
        if (/^(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)/m.test(text))
          throw Error('Remove conflict markers before marking this file resolved.');
        bytes = Buffer.from(text, 'utf8');
      }
      const text = decode(bytes);
      if (text !== null && /^(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)/m.test(text))
        throw Error('Remove conflict markers before marking this file resolved.');
      changed = true;
      if (!current.exists) await mkdir(dirname(current.physical), { recursive: true });
      await writeFile(current.physical, bytes);
      if (mode) await chmod(current.physical, mode === '100755' ? 0o755 : 0o644);
      // `add` reads working-tree files, so it keeps the repository isolation.
      await gitReviewCommand(current.root, ['add', '--', value['path']]);
      if (mode)
        await gitReviewCommand(
          current.root,
          ['update-index', mode === '100755' ? '--chmod=+x' : '--chmod=-x', '--', value['path']],
          undefined,
          'none',
        );
    }
    const remaining = await gitReviewCommand(
      current.root,
      ['ls-files', '--unmerged', '-z', '--', value['path']],
      undefined,
      'none',
    );
    if (remaining.length) throw Error('Git still reports an unresolved index entry.');
    send(ws, {
      type: 'git.action_result',
      payload: {
        ok: true,
        action: 'resolve-conflict',
        path: value['path'],
        staged: true,
        outcome: choice === 'delete' ? 'deleted' : 'kept',
        choice,
      },
    });
  } catch (error) {
    const prefix = changed
      ? 'The file/index may have changed before resolution completed. Inspect both before retrying. '
      : '';
    send(ws, {
      type,
      payload: {
        ok: false,
        error: prefix + errMessage(error),
      },
    });
  }
}
