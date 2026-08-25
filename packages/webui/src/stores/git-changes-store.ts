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
  loadingList: boolean;
  /** Repo-relative path of the file whose diff is shown in the main pane. */
  selectedPath: string | null;
  /** Diff body for `selectedPath` (null while loading or before selection). */
  diff: GitDiffContent | null;
  loadingDiff: boolean;

  setFiles: (files: GitChangedFile[], error: string | null, repoPrefix?: string) => void;
  setListLoading: (loading: boolean) => void;
  select: (path: string | null) => void;
  setDiff: (diff: GitDiffContent | null) => void;
  setDiffLoading: (loading: boolean) => void;
  clear: () => void;
}

export const useGitChangesStore = create<GitChangesState>()((set) => ({
  files: [],
  error: null,
  repoPrefix: '',
  loadingList: false,
  selectedPath: null,
  diff: null,
  loadingDiff: false,

  setFiles: (files, error, repoPrefix = '') =>
    set({ files, error, repoPrefix, loadingList: false }),
  setListLoading: (loadingList) => set({ loadingList }),
  select: (selectedPath) => set({ selectedPath, diff: null, loadingDiff: !!selectedPath }),
  setDiff: (diff) => set({ diff, loadingDiff: false }),
  setDiffLoading: (loadingDiff) => set({ loadingDiff }),
  clear: () =>
    set({ files: [], error: null, repoPrefix: '', selectedPath: null, diff: null, loadingDiff: false }),
}));
