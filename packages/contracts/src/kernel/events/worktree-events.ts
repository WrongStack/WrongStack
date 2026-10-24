export interface WorktreeEventMap {
  /**
   * Git-worktree lifecycle, emitted by WorktreeManager. Goal allocates one
   * worktree per phase so parallelizable phases run isolated, then merges them
   * back sequentially. The WebUI/TUI subscribe to render live swim-lanes/DAG.
   */
  'worktree.allocated': {
    sessionId?: string | undefined;
    /** Emit time (ms), stamped by WorktreeManager — cross-process timelines use it. */
    at?: number | undefined;
    handleId: string;
    ownerId: string;
    ownerLabel: string;
    slug: string;
    dir: string;
    branch: string;
    baseBranch: string;
  };
  'worktree.committed': {
    sessionId?: string | undefined;
    /** Emit time (ms), stamped by WorktreeManager — cross-process timelines use it. */
    at?: number | undefined;
    handleId: string;
    ownerId: string;
    branch: string;
    committed: boolean;
    insertions: number;
    deletions: number;
    files: number;
    sha?: string | undefined;
  };
  /** A merge into the base branch started (committed → merging = queue wait). */
  'worktree.merging': {
    sessionId?: string | undefined;
    /** Emit time (ms), stamped by WorktreeManager — cross-process timelines use it. */
    at?: number | undefined;
    handleId: string;
    ownerId: string;
    branch: string;
    baseBranch: string;
  };
  'worktree.merged': {
    sessionId?: string | undefined;
    /** Emit time (ms), stamped by WorktreeManager — cross-process timelines use it. */
    at?: number | undefined;
    handleId: string;
    ownerId: string;
    branch: string;
    baseBranch: string;
    squash: boolean;
  };
  'worktree.conflict': {
    sessionId?: string | undefined;
    /** Emit time (ms), stamped by WorktreeManager — cross-process timelines use it. */
    at?: number | undefined;
    handleId: string;
    ownerId: string;
    branch: string;
    conflictFiles: string[];
  };
  'worktree.released': {
    sessionId?: string | undefined;
    /** Emit time (ms), stamped by WorktreeManager — cross-process timelines use it. */
    at?: number | undefined;
    handleId: string;
    ownerId: string;
    branch: string;
    kept: boolean;
  };
  'worktree.failed': {
    sessionId?: string | undefined;
    /** Emit time (ms), stamped by WorktreeManager — cross-process timelines use it. */
    at?: number | undefined;
    handleId: string;
    ownerId: string;
    branch?: string | undefined;
    error: string;
    /** Which lifecycle step failed: checkout creation, the worktree commit, or the merge. */
    stage?: 'allocate' | 'commit' | 'merge' | undefined;
  };
}
