/**
 * `/resume` across git worktrees. Every linked worktree of a repository
 * shares the main checkout's session store (`canonicalProjectRoot`), so one
 * listing already holds all of them; each session records the checkout it ran
 * in (`SessionSummary.checkout`). The picker tags sessions from another
 * worktree, and choosing one switches the TUI to that checkout in place (the
 * F1 project switch) before resuming, so its file work lands in the right tree.
 */
import * as path from 'node:path';
import type { SessionSummary } from '@wrongstack/contracts/types';
import type { GitWorktreeEntry } from '@wrongstack/core/worktree';

export interface WorktreeRef {
  root: string;
  name: string;
  branch?: string | undefined;
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * The other worktree a session belongs to, or undefined when it ran in the
 * current checkout, in a checkout git no longer lists (resuming it here is
 * the only option left), or before checkouts were recorded.
 */
export function worktreeOfSession(
  summary: Pick<SessionSummary, 'checkout'>,
  worktrees: readonly GitWorktreeEntry[],
): WorktreeRef | undefined {
  const checkout = summary.checkout;
  if (!checkout) return undefined;
  const wt = worktrees.find((w) => samePath(w.root, checkout));
  if (!wt || wt.current) return undefined;
  return {
    root: wt.root,
    name: path.basename(wt.root) || wt.root,
    ...(wt.branch ? { branch: wt.branch } : {}),
  };
}

/**
 * Wrap the resume callback: a session that belongs to another worktree
 * (per `lookup`, filled from the last listing) first switches the TUI to that
 * worktree, then resumes there. A failed switch rejects, which the picker
 * shows, and leaves the current project untouched.
 */
export function withWorktreeSwitch<A extends unknown[], R>(
  resume: (sessionId: string, ...rest: A) => Promise<R>,
  lookup: (sessionId: string) => WorktreeRef | undefined,
  switchProject: (root: string, name: string) => Promise<string | null>,
): (sessionId: string, ...rest: A) => Promise<R> {
  return async (sessionId, ...rest) => {
    const target = lookup(sessionId);
    if (target) {
      const error = await switchProject(target.root, target.name);
      if (error) throw new Error(`Could not switch to worktree ${target.name}: ${error}`);
    }
    return resume(sessionId, ...rest);
  };
}
