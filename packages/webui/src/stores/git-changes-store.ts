import { create } from 'zustand';

/** One changed file row in the Changes (source-control) panel. */
export interface GitChangedFile {
  path: string;
  /** M/A/D/R/C/U/? — see server git-handlers.ts handleGitChanges. */
  status: string;
  added: number;
  deleted: number;
  staged: boolean;
}

/** The resolved before/after text for the selected file's diff. */
export interface GitDiffContent {
  path: string;
  oldText: string;
  newText: string;
  binary?: boolean;
  tooLarge?: boolean;
  error?: string;
}

interface GitChangesSessionState {
  selectedPath: string | null;
  diff: GitDiffContent | null;
  loadingDiff: boolean;
}

interface GitChangesState {
  files: GitChangedFile[];
  /** Set when the last `git.changes` reply carried an error (e.g. not a repo). */
  error: string | null;
  /**
   * Repo→project path prefix ('' when the project root is the repo root),
   * server-computed via repoRelativePrefix. Git paths are repo-root-
   * relative while FileExplorer tree paths are project-root-relative;
   * prepend this to a tree path to build its git lookup key.
   */
  repoPrefix: string;
  /**
   * Server-computed aggregate status per directory (repo-relative keys) —
   * the highest-ranked child status (U > D > M > R/C > A > ?), shipped in
   * git.changes. Replaces the old client-side prefix-scan heuristic.
   */
  dirs: Record<string, string>;
  loadingList: boolean;
  /** Repo-relative path of the file whose diff is shown in the main pane. */
  selectedPath: string | null;
  /** Diff body for `selectedPath` (null while loading or before selection). */
  diff: GitDiffContent | null;
  loadingDiff: boolean;
  /** Which session the selected diff projection currently describes. */
  gitChangesSessionId: string | null;
  /** Per-session selected diff state. The changed-file list itself is project-global. */
  gitChangesBySession: Record<string, GitChangesSessionState>;

  setFiles: (
    files: GitChangedFile[],
    error: string | null,
    repoPrefix?: string,
    dirs?: Record<string, string>,
  ) => void;
  setListLoading: (loading: boolean) => void;
  select: (path: string | null) => void;
  setDiff: (diff: GitDiffContent | null) => void;
  setDiffLoading: (loading: boolean) => void;
  bindSessionGitChanges: (sessionId: string | null) => void;
  forgetSessionGitChanges: (sessionId: string) => void;
  clear: () => void;
}

function defaultGitChangesSession(): GitChangesSessionState {
  return { selectedPath: null, diff: null, loadingDiff: false };
}

function readGitChangesSession(state: GitChangesState): GitChangesSessionState {
  return {
    selectedPath: state.selectedPath,
    diff: state.diff,
    loadingDiff: state.loadingDiff,
  };
}

function parkGitChanges(
  state: GitChangesState,
  patch: Partial<GitChangesSessionState>,
): { gitChangesBySession?: GitChangesState['gitChangesBySession'] } {
  if (!state.gitChangesSessionId) return {};
  return {
    gitChangesBySession: {
      ...state.gitChangesBySession,
      [state.gitChangesSessionId]: { ...readGitChangesSession(state), ...patch },
    },
  };
}

export const useGitChangesStore = create<GitChangesState>()((set) => ({
  files: [],
  error: null,
  repoPrefix: '',
  dirs: {},
  loadingList: false,
  selectedPath: null,
  diff: null,
  loadingDiff: false,
  gitChangesSessionId: null,
  gitChangesBySession: {},

  setFiles: (files, error, repoPrefix = '', dirs = {}) =>
    set({ files, error, repoPrefix, dirs, loadingList: false }),
  setListLoading: (loadingList) => set({ loadingList }),
  select: (selectedPath) =>
    set((state) => ({
      selectedPath,
      diff: null,
      loadingDiff: !!selectedPath,
      ...parkGitChanges(state, { selectedPath, diff: null, loadingDiff: !!selectedPath }),
    })),
  setDiff: (diff) =>
    set((state) => ({
      diff,
      loadingDiff: false,
      ...parkGitChanges(state, { diff, loadingDiff: false }),
    })),
  setDiffLoading: (loadingDiff) =>
    set((state) => ({
      loadingDiff,
      ...parkGitChanges(state, { loadingDiff }),
    })),
  bindSessionGitChanges: (sessionId) =>
    set((state) => {
      if (state.gitChangesSessionId === sessionId) return {};
      const gitChangesBySession = { ...state.gitChangesBySession };
      if (state.gitChangesSessionId) {
        gitChangesBySession[state.gitChangesSessionId] = readGitChangesSession(state);
      }
      const next = sessionId ? gitChangesBySession[sessionId] : undefined;
      const gitSession = next ?? defaultGitChangesSession();
      return {
        gitChangesSessionId: sessionId,
        gitChangesBySession,
        selectedPath: gitSession.selectedPath,
        diff: gitSession.diff,
        loadingDiff: gitSession.loadingDiff,
      };
    }),
  forgetSessionGitChanges: (sessionId) =>
    set((state) => {
      const gitChangesBySession = { ...state.gitChangesBySession };
      delete gitChangesBySession[sessionId];
      if (state.gitChangesSessionId !== sessionId) return { gitChangesBySession };
      return {
        gitChangesBySession,
        gitChangesSessionId: null,
        ...defaultGitChangesSession(),
      };
    }),
  clear: () =>
    set((state) => ({
      files: [],
      error: null,
      repoPrefix: '',
      dirs: {},
      selectedPath: null,
      diff: null,
      loadingDiff: false,
      ...parkGitChanges(state, { selectedPath: null, diff: null, loadingDiff: false }),
    })),
}));
