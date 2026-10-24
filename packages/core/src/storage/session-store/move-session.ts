/**
 * Moving a closed session to another checkout.
 *
 * Every git worktree of a repository shares one session store, so a move to
 * another worktree of the same repository keeps the files where they are: it
 * appends a `session_moved` event with the new checkout and re-indexes, and
 * `/resume` then lists and opens the session under that worktree.
 *
 * A move to another project copies the journal and its sidecars into that
 * project's store, stamps the copy, indexes it there, and only then deletes
 * the original, all under one delete lease so a session that is open anywhere
 * is refused before anything is touched. Rewind snapshots keep their absolute
 * paths; rewind already skips any path outside the current project, so a
 * moved session cannot write into the project it came from.
 *
 * The `/rewind redo` stash is dropped: redo re-writes the journal tail, which
 * would cut the move event back out.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  SessionEvent,
  SessionMoveResult,
  SessionMoveTarget,
  SessionSummary,
} from '@wrongstack/contracts/types';
import { sessionScopedPath } from '../../utils/session-scoped-path.js';
import { clearRedoStash } from '../session-writer-redo.js';
import { SESSION_SIDECAR_SUFFIXES } from './delete-session-artifacts.js';
import { executeRehydrate, type SessionArchiveHost } from './session-archive.js';
import { locateTranscript } from './transcript-location.js';

export interface SessionMoveHost extends SessionArchiveHost {
  /** The project this store belongs to, recorded on a cross-project move. */
  projectRoot?: string | undefined;
  /** Delete the session from this store without the catalog (file mode). */
  deleteLocal: (id: string) => Promise<void>;
}

export async function executeMoveSession(
  host: SessionMoveHost,
  id: string,
  target: SessionMoveTarget,
): Promise<SessionMoveResult> {
  const checkout = path.resolve(target.checkout);
  const sameStore = path.resolve(target.store.sessionsDir) === path.resolve(host.dir);
  let located = await locateTranscript(host.dir, id);
  if (!located) throw new Error(`Session not found: ${id}`);
  if (located.state === 'cold') {
    // An archived journal is gzip; the move appends to it, so expand it first.
    await executeRehydrate(host, id);
    located = await locateTranscript(host.dir, id);
    if (!located || located.state === 'cold')
      throw new Error(`Session ${id} could not be restored.`);
  }
  // Strict: the name lives only in this manifest, which the move deletes; an
  // unreadable (not missing) manifest must refuse the move, not drop the name.
  const name = (await host.readSummaryManifest(id, undefined, true))?.name;

  const lease = host.catalogClient
    ? await host.catalogClient
        .call('acquire_maintenance', {
          sessionId: id,
          operation: sameStore ? 'move' : 'delete',
          holderId: host.maintenanceHolderId,
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!/ is live$/.test(message)) throw err;
          throw new Error(`${message}: close it wherever it is open, then move it.`);
        })
    : undefined;
  let leaseSpent = false;
  try {
    if (!lease && host.isSessionInUse) {
      const reason = await host.isSessionInUse(id);
      if (reason) throw new Error(`Session ${id} is in use (${reason}) and cannot be moved.`);
    }

    if (sameStore) {
      await appendMoveEvent(located.filePath, { type: 'session_moved', ts: now(), checkout });
      await clearRedoStash(located.filePath);
      await fsp.rm(host.sessionPath(id, '.summary.json'), { force: true });
      const summary = await target.store.adoptMovedSession(id, name);
      host.clearLoadCache(id);
      return { id, kind: 'worktree', checkout, summary };
    }

    const copied = await copySessionFiles(host.dir, target.store.sessionsDir, id, located.filePath);
    let summary: SessionSummary;
    try {
      await appendMoveEvent(copied.transcript, {
        type: 'session_moved',
        ts: now(),
        checkout,
        ...(host.projectRoot ? { fromProject: host.projectRoot } : {}),
      });
      summary = await target.store.adoptMovedSession(id, name);
    } catch (error) {
      await Promise.all(copied.paths.map((p) => fsp.rm(p, { recursive: true, force: true })));
      throw error;
    }

    if (host.catalogClient && lease) {
      // Mark the lease spent only once the delete actually consumed it. Setting
      // this BEFORE the call meant a delete that REJECTED still left
      // `leaseSpent === true`, so the `finally` below skipped the release and
      // the lease stayed held until it expired on its own — refusing an
      // immediate retry of a move that never happened.
      await host.catalogClient.call('delete', { sessionId: id, lease });
      leaseSpent = true;
    } else {
      await host.deleteLocal(id);
    }
    await clearRedoStash(located.filePath);
    host.clearLoadCache(id);
    return {
      id,
      kind: 'project',
      checkout,
      summary,
      ...(host.projectRoot ? { fromProject: host.projectRoot } : {}),
    };
  } finally {
    if (lease && !leaseSpent) {
      await host.catalogClient?.call('release_maintenance', { lease }).catch(() => undefined);
    }
  }
}

/**
 * Index a session whose journal was just stamped by a move: the summary is
 * rebuilt from the journal (so it carries the new checkout) and the user's
 * name, which lives only in the summary, is carried over.
 */
export async function executeAdoptMovedSession(
  host: SessionArchiveHost,
  id: string,
  name: string | undefined,
): Promise<SessionSummary> {
  const located = await locateTranscript(host.dir, id);
  if (!located) throw new Error(`Session not found after move: ${id}`);
  await fsp.rm(host.sessionPath(id, '.summary.json'), { force: true });
  await host.invalidateShardManifestBySessionId(id);
  const rebuilt = await host.summaryFor(id);
  const summary: SessionSummary = name ? { ...rebuilt, name } : rebuilt;
  if (name) {
    await fsp.writeFile(host.sessionPath(id, '.summary.json'), JSON.stringify(summary), {
      mode: 0o600,
    });
  }
  if (host.catalogClient) {
    await host.catalogClient.call('upsert_summary', {
      summary,
      transcriptRelativePath: located.relativePath,
      summaryRelativePath: `${id}.summary.json`,
      storageState: 'hot',
      uncompressedSize: located.size,
    });
  } else {
    await host.appendToIndex(summary);
  }
  host.clearLoadCache(id);
  return summary;
}

function now(): string {
  return new Date().toISOString();
}

async function appendMoveEvent(
  journal: string,
  event: Extract<SessionEvent, { type: 'session_moved' }>,
): Promise<void> {
  // A journal whose last line lost its newline (a crash mid-write) must not
  // get the event glued onto that line.
  const handle = await fsp.open(journal, 'r');
  let needsNewline = false;
  try {
    const { size } = await handle.stat();
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      needsNewline = last[0] !== 0x0a;
    }
  } finally {
    await handle.close();
  }
  await fsp.appendFile(journal, `${needsNewline ? '\n' : ''}${JSON.stringify(event)}\n`, 'utf8');
}

/**
 * Copy the journal, its sidecars and its per-session directory into the
 * target store under the same id. Refuses when the target already has it.
 * Returns what was written, so a failure can remove it again.
 */
async function copySessionFiles(
  fromDir: string,
  toDir: string,
  id: string,
  transcript: string,
): Promise<{ transcript: string; paths: string[] }> {
  const targetTranscript = sessionScopedPath(toDir, id, '.jsonl');
  if (await exists(targetTranscript)) {
    throw new Error(`The target project already has a session ${id}.`);
  }
  await fsp.mkdir(path.dirname(targetTranscript), { recursive: true });
  const paths: string[] = [];
  const copy = async (from: string, to: string, recursive = false): Promise<void> => {
    if (!(await exists(from))) return;
    paths.push(to);
    await fsp.cp(from, to, { recursive, errorOnExist: true, force: false });
  };
  try {
    await copy(transcript, targetTranscript);
    for (const suffix of SESSION_SIDECAR_SUFFIXES) {
      await copy(sessionScopedPath(fromDir, id, suffix), sessionScopedPath(toDir, id, suffix));
    }
    const base = path.basename(id);
    await copy(
      path.join(path.dirname(transcript), base),
      path.join(path.dirname(targetTranscript), base),
      true,
    );
  } catch (error) {
    await Promise.all(paths.map((p) => fsp.rm(p, { recursive: true, force: true })));
    throw error;
  }
  return { transcript: targetTranscript, paths };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}
