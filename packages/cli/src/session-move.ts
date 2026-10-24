/**
 * `sessions move` for the CLI subcommand and the `/sessions move` slash
 * command: resolve where a session goes and hand both stores to
 * `SessionStore.move`.
 *
 * A path inside another git worktree of this repository resolves to this
 * store (all worktrees share one), so the move only re-stamps the session's
 * checkout. Any other path is a project of its own: its store is opened here,
 * which connects to that project's session catalog.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionMoveResult, SessionStore } from '@wrongstack/contracts/types';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { resolveWstackPaths } from '@wrongstack/core/utils';

export async function moveSessionTo(opts: {
  store: SessionStore;
  sessionId: string;
  targetPath: string;
  globalRoot?: string | undefined;
}): Promise<SessionMoveResult> {
  const { store } = opts;
  if (!store.move || store.sessionsDir === undefined) {
    throw new Error('This session store cannot move sessions.');
  }
  const checkout = path.resolve(opts.targetPath);
  const stat = await fs.stat(checkout).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Not a directory: ${checkout}`);

  const targetDir = resolveWstackPaths({
    projectRoot: checkout,
    ...(opts.globalRoot ? { globalRoot: opts.globalRoot } : {}),
  }).projectSessions;
  const adopt = store.adoptMovedSession?.bind(store);
  if (path.resolve(targetDir) === path.resolve(store.sessionsDir) && adopt) {
    return store.move(opts.sessionId, {
      store: { sessionsDir: store.sessionsDir, adoptMovedSession: adopt },
      checkout,
    });
  }
  await fs.mkdir(targetDir, { recursive: true });
  const targetStore = new DefaultSessionStore({ dir: targetDir, projectRoot: checkout });
  try {
    return await store.move(opts.sessionId, { store: targetStore, checkout });
  } finally {
    await targetStore.dispose().catch(() => undefined);
  }
}

/** One line for the user: where the session went and how to open it there. */
export function describeSessionMove(result: SessionMoveResult): string {
  if (result.kind === 'worktree') {
    return `Moved ${result.id} to the worktree at ${result.checkout}; /resume lists it there.`;
  }
  return (
    `Moved ${result.id} to the project at ${result.checkout}` +
    `${result.fromProject ? ` (from ${result.fromProject})` : ''}. ` +
    `Open it there with: cd "${result.checkout}" && wstack resume ${result.id}`
  );
}
