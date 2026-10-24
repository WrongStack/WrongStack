/**
 * State, git plumbing and base-branch history operations of the
 * {@link WorktreeManager} (worktree-manager.ts): the handle map, event
 * emission, conflict-resolution host, and the handle-free merge / revert /
 * diff operations on the base branch.
 */

import { join, resolve } from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import {
  conflictMarkedFiles as conflictMarkedFilesFromHost,
  diffSummary as diffSummaryFromHost,
  hasConflictMarkers as hasConflictMarkersFromHost,
  tryResolveConflict as tryResolveConflictFromHost,
  type WorktreeConflictResolutionHost,
} from './worktree-conflict-resolution.js';
import { NOTHING_TO_COMMIT } from './worktree-conflict-resolution-contracts.js';
import {
  collectStats,
  defaultRun,
  identityArgs,
  makeSlug,
  parseConflictPaths,
} from './worktree-git.js';
import type { ManagedOpsContext } from './worktree-managed-ops.js';
import type {
  MergeOpts,
  MergeResult,
  RunResult,
  WorktreeHandle,
  WorktreeManagerOptions,
  WorktreeStatus,
} from './worktree-types.js';

export abstract class WorktreeManagerCore {
  protected readonly projectRoot: string;
  protected readonly events?: EventBus | undefined;
  protected readonly sessionIdSource: string | (() => string | undefined) | undefined;
  protected readonly gitBin: string;
  protected readonly runGit: (args: string[], cwd: string) => Promise<RunResult>;
  /** Keyed by ownerId. */
  protected readonly handles = new Map<string, WorktreeHandle>();
  protected readonly usedSlugs = new Set<string>();

  constructor(opts: WorktreeManagerOptions) {
    this.projectRoot = resolve(opts.projectRoot);
    this.events = opts.events;
    this.sessionIdSource = opts.sessionId;
    this.gitBin = opts.gitBin ?? 'git';
    this.runGit = opts.run ?? ((args, cwd) => this.defaultRun(args, cwd));
  }
  /**
   * Current tip SHA of a handle's base branch (without checking it out). Capture
   * this before a merge so a regressed merge can be reverted to exactly this
   * commit — unambiguous even when a squash produced no diff. Returns null on
   * failure (caller then skips the revert).
   */
  async baseHead(handle: WorktreeHandle): Promise<string | null> {
    const res = await this.runGit(['rev-parse', handle.baseBranch], this.projectRoot);
    const sha = res.stdout.trim();
    return res.code === 0 && sha ? sha : null;
  }

  /**
   * Hard-reset the base branch back to `sha` (a value previously returned by
   * {@link baseHead}). Used to undo a squash-merge whose integrated result failed
   * re-verification, so an auto-resolved-but-broken merge never sticks on base.
   * Safe because SDD merges are serialized — no other commit lands in between.
   */
  async revertBaseTo(handle: WorktreeHandle, sha: string): Promise<boolean> {
    // Never hard-reset tracked/index dirt: `checkout baseBranch` no-ops when
    // already on base (succeeding even with uncommitted changes), and the
    // reset would silently destroy tracked working-tree/index edits. Same
    // guard as merge/mergeBranch/revertCommits — the caller (SDD rollback)
    // already handles the `false` return.
    //
    // Untracked files (`??`) are exempt: `reset --hard` and a same-branch
    // checkout leave untracked files untouched, so verification artifacts
    // written before a post-merge verification failure do NOT block restoring
    // the captured base SHA — the invalid merge is reverted while the output
    // stays on disk for inspection.
    const status = await this.runGit(['status', '--porcelain'], this.projectRoot);
    if (status.code !== 0) return false;
    const hasTrackedDirt = status.stdout
      .split('\n')
      .some((line) => line.trim().length > 0 && !line.startsWith('??'));
    if (hasTrackedDirt) return false;
    const co = await this.runGit(['checkout', handle.baseBranch], this.projectRoot);
    if (co.code !== 0) return false;
    const reset = await this.runGit(['reset', '--hard', sha], this.projectRoot);
    return reset.code === 0;
  }

  /**
   * Current base branch + tip SHA, captured WITHOUT a handle. The SDD run calls
   * this once at start so a later rollback knows which branch the run's squash
   * commits landed on. Returns null when not in a usable git state.
   */
  async currentBase(): Promise<{ branch: string; sha: string } | null> {
    const branch = await this.detectBaseBranch();
    const head = await this.runGit(['rev-parse', 'HEAD'], this.projectRoot);
    const sha = head.stdout.trim();
    return head.code === 0 && sha ? { branch, sha } : null;
  }
  /**
   * Squash-merge an arbitrary `wstack/ap/*` branch into the base branch from the
   * main checkout — the handle-free counterpart to {@link merge}, used by the
   * WebUI worktree panel's per-row "Merge to base". On conflict it hard-resets
   * the base tree (never leaves it dirty) and reports the conflicted paths.
   * Refuses on a dirty base tree so uncommitted work is never clobbered.
   */
  async mergeBranch(
    branch: string,
    baseBranch?: string | undefined,
  ): Promise<{ ok: boolean; conflict?: boolean; conflictFiles?: string[]; reason?: string }> {
    const base = baseBranch ?? (await this.detectBaseBranch());
    // Defense-in-depth: a ref that begins with `-` could be parsed as a git
    // flag (argv smuggling). The WebUI boundary already restricts to managed
    // branches; this guards every other caller too.
    if (branch.startsWith('-') || base.startsWith('-')) {
      return { ok: false, reason: 'invalid ref' };
    }

    // Untracked files don't block: `merge --squash` refuses on its own to
    // overwrite one, and the `reset --hard` rollbacks below leave them alone.
    const status = await this.runGit(
      ['status', '--porcelain', '--untracked-files=no'],
      this.projectRoot,
    );
    if (status.code !== 0 || status.stdout.trim().length > 0) {
      return { ok: false, reason: 'working tree has uncommitted changes — commit or stash first' };
    }
    const co = await this.runGit(['checkout', base], this.projectRoot);
    if (co.code !== 0) {
      return { ok: false, reason: co.stderr || `checkout ${base} failed` };
    }
    // Identity fallback on the merge too: see merge() — a squash still needs it.
    const idArgs = await this.identityArgs(this.projectRoot);
    const merged = await this.runGit([...idArgs, 'merge', '--squash', branch], this.projectRoot);
    const fromOutput = parseConflictPaths(`${merged.stdout}\n${merged.stderr}`);
    const fromIndex = await this.unmergedFiles();
    const conflictFiles = [...new Set([...fromOutput, ...fromIndex])];
    if (merged.code !== 0 || conflictFiles.length > 0) {
      // `merge --squash` leaves no MERGE_HEAD — hard-reset to undo cleanly.
      await this.runGit(['reset', '--hard', 'HEAD'], this.projectRoot).catch(() => undefined);
      return {
        ok: false,
        conflict: conflictFiles.length > 0,
        conflictFiles,
        reason: merged.stderr || (conflictFiles.length > 0 ? 'merge conflict' : 'merge failed'),
      };
    }
    const commit = await this.runGit(
      [...idArgs, 'commit', '-m', `merge ${branch} (squash)`],
      this.projectRoot,
    );
    if (commit.code !== 0 && !NOTHING_TO_COMMIT.test(commit.stdout + commit.stderr)) {
      // Same rollback as merge(): never leave the squash staged on base.
      await this.runGit(['reset', '--hard', 'HEAD'], this.projectRoot).catch(() => undefined);
      return { ok: false, reason: commit.stderr || commit.stdout || 'squash commit failed' };
    }
    return { ok: true };
  }

  /**
   * Compact change summary for a worktree checkout: working-tree edits
   * (numstat vs HEAD) + commit count ahead of `baseBranch`. Powers the panel's
   * "View changes" without streaming a full diff. Never throws.
   */
  async diffSummary(
    dir: string,
    baseBranch?: string | undefined,
  ): Promise<{
    files: Array<{ path: string; insertions: number; deletions: number }>;
    insertions: number;
    deletions: number;
    commits: number;
  }> {
    return diffSummaryFromHost(this.worktreeConflictResolutionHost(), dir, baseBranch);
  }
  /**
   * Undo a run's squash commits by reverting each (newest → oldest) on the base
   * branch — history-preserving, never a destructive reset. Refuses on a dirty
   * working tree (so uncommitted work is never clobbered) and aborts cleanly if a
   * revert conflicts, reporting which SHA. `shas` are the run commit SHAs in the
   * order they landed; this reverses them. Returns the count reverted.
   */
  async revertCommits(
    baseBranch: string,
    shas: string[],
  ): Promise<{ ok: boolean; reverted: number; reason?: string }> {
    if (shas.length === 0) return { ok: true, reverted: 0, reason: 'nothing to revert' };

    const status = await this.runGit(['status', '--porcelain'], this.projectRoot);
    // F2026101030: match revertBaseTo(). A non-zero status is not a clean tree.
    if (status.code !== 0) {
      return {
        ok: false,
        reverted: 0,
        reason: 'could not read working tree status — commit or stash first',
      };
    }
    if (status.stdout.trim().length > 0) {
      return {
        ok: false,
        reverted: 0,
        reason: 'working tree has uncommitted changes — commit or stash first',
      };
    }

    const co = await this.runGit(['checkout', baseBranch], this.projectRoot);
    if (co.code !== 0) {
      return { ok: false, reverted: 0, reason: co.stderr || `checkout ${baseBranch} failed` };
    }

    const idArgs = await this.identityArgs(this.projectRoot);
    let reverted = 0;
    // Newest commit first so each revert applies cleanly on top of the prior one.
    for (const sha of [...shas].reverse()) {
      const res = await this.runGit([...idArgs, 'revert', '--no-edit', sha], this.projectRoot);
      if (res.code !== 0) {
        // Conflict or bad ref — abort the in-progress revert so the tree is clean.
        await this.runGit(['revert', '--abort'], this.projectRoot).catch(() => undefined);
        return {
          ok: false,
          reverted,
          reason: `revert of ${sha.slice(0, 8)} failed: ${(res.stderr || res.stdout).trim().split('\n')[0] ?? 'conflict'}`,
        };
      }
      reverted++;
    }
    return { ok: true, reverted };
  }

  /**
   * Run the caller-supplied resolver against a conflicted squash-merge, then
   * commit if it cleared every marker. Returns a successful `MergeResult` on a
   * clean resolution, or `null` to signal the caller should fall back to the
   * abort path. Never leaves the base tree committed-but-dirty: a partial or
   * failed resolution returns `null` and the caller hard-resets.
   */
  protected async tryResolveConflict(
    handle: WorktreeHandle,
    conflictFiles: string[],
    opts: MergeOpts,
  ): Promise<MergeResult | null> {
    return tryResolveConflictFromHost(
      this.worktreeConflictResolutionHost(),
      handle,
      conflictFiles,
      opts,
    );
  }

  /**
   * True when staged content still carries conflict markers.
   *
   * Reads the working-tree files directly and matches a full marker line
   * (`<<<<<<< `, `=======`, `>>>>>>> `, `||||||| `) with a lenient regex
   * (`{7,}`) that stays platform- and config-independent — unlike the old
   * `git diff --check` (only fires when `core.whitespace` opts in) and
   * `git grep` (assumes the default 7-char markers).
   *
   * Scan set: when the caller supplies the conflicted paths (the normal
   * path from {@link tryResolveConflict}), ONLY those files are scanned so
   * an unrelated `=======` setext-heading underline in a staged document
   * can't false-positive and discard valid resolution work. The staged-file
   * listing (`git diff --cached --name-only`) is used only as a fallback
   * when no paths are given.
   *
   * CRLF caveat: conflicted files checked out with CRLF (`core.autocrlf=true`,
   * `.gitattributes eol=crlf`) carry bare markers as `=======\r\n`. Because
   * `$` in multiline mode matches only before `\n`, carriage returns are
   * stripped before matching so `\r` never defeats the end-of-line anchor.
   */
  protected async hasConflictMarkers(files?: string[]): Promise<boolean> {
    return hasConflictMarkersFromHost(this.worktreeConflictResolutionHost(), files);
  }

  /**
   * The subset of `files` (default: the staged listing, as above) whose
   * working-tree content carries a conflict marker. `firstOnly` stops at the
   * first hit for the boolean check.
   */
  protected async conflictMarkedFiles(files?: string[], firstOnly = false): Promise<string[]> {
    return conflictMarkedFilesFromHost(this.worktreeConflictResolutionHost(), files, firstOnly);
  }
  // ── internals ────────────────────────────────────────────────────────────

  protected worktreesRoot(): string {
    return join(this.projectRoot, '.wrongstack', 'worktrees');
  }

  protected async detectBaseBranch(): Promise<string> {
    const head = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], this.projectRoot);
    const name = head.stdout.trim();
    if (name && name !== 'HEAD') return name;
    // Detached HEAD — fall back to the commit SHA.
    const sha = await this.runGit(['rev-parse', 'HEAD'], this.projectRoot);
    return sha.stdout.trim() || 'HEAD';
  }

  protected makeSlug(hint: string): string {
    return makeSlug(hint, this.usedSlugs);
  }

  protected async collectStats(
    dir: string,
  ): Promise<{ insertions: number; deletions: number; files: number; sha: string }> {
    return collectStats(this.runGit, dir);
  }

  protected async identityArgs(cwd: string): Promise<string[]> {
    return identityArgs(this.runGit, cwd);
  }

  protected async unmergedFiles(): Promise<string[]> {
    // -z: core.quotePath would C-quote non-ASCII names (`şema.ts` -> `"\305\237ema.ts"`).
    const args = ['diff', '--name-only', '-z', '--diff-filter=U'];
    const res = await this.runGit(args, this.projectRoot);
    return res.stdout.split('\0').filter(Boolean);
  }

  protected emitCommitted(handle: WorktreeHandle, committed: boolean): void {
    this.emit('worktree.committed', {
      handleId: handle.id,
      ownerId: handle.ownerId,
      branch: handle.branch,
      committed,
      insertions: handle.insertions,
      deletions: handle.deletions,
      files: handle.files,
      sha: handle.sha,
    });
  }

  protected fail(
    handle: WorktreeHandle,
    error: string,
    stage: 'allocate' | 'commit' | 'merge',
  ): WorktreeHandle {
    this.setStatus(handle, 'failed', { lastError: error });
    this.emit('worktree.failed', {
      handleId: handle.id,
      ownerId: handle.ownerId,
      branch: handle.branch,
      error,
      stage,
    });
    return handle;
  }

  protected setStatus(
    handle: WorktreeHandle,
    status: WorktreeStatus,
    patch?: Partial<WorktreeHandle> | undefined,
  ): void {
    handle.status = status;
    handle.updatedAt = Date.now();
    if (patch) Object.assign(handle, patch);
  }

  protected emit<E extends Parameters<EventBus['emit']>[0]>(
    event: E,
    payload: Parameters<EventBus['emit']>[1],
  ): void {
    const sessionId = this.currentSessionId();
    // `at` is the emit time: listeners in other processes (HQ) and late
    // subscribers (a WebUI tab opened mid-run) place lifecycle steps by it.
    this.events?.emit(
      event,
      (payload && typeof payload === 'object'
        ? {
            ...(payload as Record<string, unknown>),
            at: Date.now(),
            ...(sessionId ? { sessionId } : {}),
          }
        : payload) as never,
    );
  }

  protected currentSessionId(): string | undefined {
    const value =
      typeof this.sessionIdSource === 'function' ? this.sessionIdSource() : this.sessionIdSource;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  protected defaultRun(args: string[], cwd: string): Promise<RunResult> {
    return defaultRun(this.gitBin, args, cwd);
  }

  /** Bundle of manager state the handle-free managed-artifact ops operate on. */
  protected managedOpsContext(): ManagedOpsContext {
    return {
      runGit: this.runGit,
      projectRoot: this.projectRoot,
      worktreesRoot: this.worktreesRoot(),
      handles: this.handles,
      usedSlugs: this.usedSlugs,
      emit: (event, payload) => this.emit(event, payload),
    };
  }

  protected worktreeConflictResolutionHost(): WorktreeConflictResolutionHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      projectRoot: this.projectRoot,
      runGit: this.runGit,
      hasConflictMarkers: this.hasConflictMarkers,
      identityArgs: this.identityArgs,
      setStatus: this.setStatus,
      emit: this.emit,
      conflictMarkedFiles: this.conflictMarkedFiles,
      detectBaseBranch: this.detectBaseBranch,
    } satisfies WorktreeConflictResolutionHost);
    return this as unknown as WorktreeConflictResolutionHost;
  }
}
