import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Types ───────────────────────────────────────────────────────────────

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
  /** File size in bytes (files only; undefined for directories). */
  size?: number;
  /** Last-modified timestamp in milliseconds since epoch. */
  lastModified?: number;
}

export interface OpenFile {
  path: string;
  content: string;
  /** True when the editor content differs from what's on disk. */
  dirty: boolean;
  /** The content last known to be on disk — used for dirty detection. */
  savedContent: string;
}

// ── Store ───────────────────────────────────────────────────────────────

export interface FileStoreState {
  /** The project root path as reported by the server. */
  projectRoot: string;
  /** The directory tree structure. */
  tree: TreeNode[];
  /** Files currently open in editor tabs. */
  openFiles: OpenFile[];
  /** The path of the currently active editor tab. */
  activeFilePath: string | null;
  /** Whether the file tree is being fetched. */
  treeLoading: boolean;
  /** Last error message, if any. */
  error: string | null;
  /** Target line to jump to in the active editor. */
  targetLine: { line: number; col?: number | undefined } | null;

  // Actions
  setTree: (root: string, tree: TreeNode[]) => void;
  openFile: (filePath: string, content: string) => void;
  closeFile: (filePath: string) => void;
  setActiveFile: (filePath: string | null) => void;
  jumpToLine: (line: number, col?: number) => void;
  clearTargetLine: () => void;
  updateContent: (filePath: string, content: string) => void;
  /** Mark a file as saved (synced with disk). */
  markSaved: (filePath: string) => void;
  setTreeLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  /** Drop all open tabs (used when the server switches to a different project). */
  clearOpenTabs: () => void;
  /**
   * Canonical absolute project root as reported by the server environment
   * (working_dir.changed / session env). Distinct from `projectRoot`, which
   * holds the tree-response display label and can be a cwd-relative label
   * ("subdir", ".") when browsing a subdirectory — never use that for
   * identity comparisons.
   */
  projectIdentity: string;
  /** Record the canonical absolute project root (env events only). */
  setProjectIdentity: (root: string) => void;
  /** Paths whose rehydrated stub content is currently being fetched. */
  hydratingPaths: ReadonlySet<string>;
  /**
   * Apply fetched content to a rehydrated stub tab. Only applies while the
   * path is still hydrating AND the tab is still a pristine stub — never
   * overwrites content the user has started editing, never steals focus.
   * Returns true when the content was applied.
   */
  hydrateFileContent: (filePath: string, content: string) => boolean;
  /**
   * Handle a failed hydration read (file deleted or renamed on disk while
   * the page was closed). Removes the path from hydration tracking and
   * closes the tab when it is still a pristine stub — leaving it open would
   * let the next save resurrect a deleted file. A tab the user has started
   * editing is kept; its save recreates the file intentionally.
   */
  hydrateFileFailed: (filePath: string) => void;
}

/** Shape written to localStorage — tabs are paths only, never content. */
export interface PersistedFileStoreState {
  openFilePaths: string[];
  activeFilePath: string | null;
  /** Canonical absolute project root (env identity), not the display label. */
  projectIdentity: string;
}

/**
 * Merge persisted (path-only) tab state into the live store on rehydration.
 *
 * Tabs are restored as empty-content stubs: trusting cached content across a
 * reload would silently overwrite changes made on disk while the page was
 * closed the next time the user saves. The empty stubs are re-fetched via
 * `files.read` once the server environment is known (see
 * `reconcileFileTabsAfterEnvChange` in the ws handlers). Exported as a pure
 * function so the merge contract is unit-testable without zustand internals.
 */
export function mergePersistedFileStore(
  persisted: unknown,
  current: FileStoreState,
): FileStoreState {
  const p = (persisted ?? {}) as Partial<PersistedFileStoreState>;
  const paths = Array.isArray(p.openFilePaths)
    ? p.openFilePaths.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  const openFiles: OpenFile[] = paths.map((path) => ({
    path,
    content: '',
    dirty: false,
    savedContent: '',
  }));
  const activeFilePath =
    typeof p.activeFilePath === 'string' && paths.includes(p.activeFilePath)
      ? p.activeFilePath
      : paths[0] ?? null;
  return {
    ...current,
    projectIdentity:
      typeof p.projectIdentity === 'string' ? p.projectIdentity : current.projectIdentity,
    openFiles,
    activeFilePath,
  };
}

export const useFileStore = create<FileStoreState>()(
  persist(
    (set, get) => ({
      projectRoot: '',
      tree: [],
      openFiles: [],
      activeFilePath: null,
      treeLoading: false,
      error: null,
      targetLine: null,
      projectIdentity: '',
      hydratingPaths: new Set<string>(),

      setTree: (root, tree) => set({ projectRoot: root, tree, treeLoading: false, error: null }),

      jumpToLine: (line, col) => set({ targetLine: { line, col } }),
      clearTargetLine: () => set({ targetLine: null }),

      openFile: (filePath, content) => {
        const state = get();
        const existing = state.openFiles.find((f) => f.path === filePath);
        if (existing) {
          // Already open — refresh it with the latest disk content and switch to it.
          set({
            openFiles: state.openFiles.map((file) =>
              file.path === filePath
                ? { ...file, content, dirty: false, savedContent: content }
                : file,
            ),
            activeFilePath: filePath,
          });
          return;
        }
        set({
          openFiles: [
            ...state.openFiles,
            { path: filePath, content, dirty: false, savedContent: content },
          ],
          activeFilePath: filePath,
        });
      },

      closeFile: (filePath) => {
        const state = get();
        const idx = state.openFiles.findIndex((f) => f.path === filePath);
        if (idx === -1) return;
        const next = [...state.openFiles];
        next.splice(idx, 1);
        let nextActive = state.activeFilePath;
        if (state.activeFilePath === filePath) {
          // Activate the tab to the right, or the last tab, or null.
          if (next.length === 0) {
            nextActive = null;
          } else if (idx < next.length) {
            nextActive = next[idx].path;
          } else {
            nextActive = next[next.length - 1].path;
          }
        }
        set({ openFiles: next, activeFilePath: nextActive });
      },

      setActiveFile: (filePath) => set({ activeFilePath: filePath }),

      updateContent: (filePath, content) => {
        set((state) => {
          const openFiles = state.openFiles.map((f) =>
            f.path === filePath
              ? { ...f, content, dirty: content !== f.savedContent }
              : f,
          );
          return { openFiles };
        });
      },

      markSaved: (filePath) => {
        set((state) => {
          const openFiles = state.openFiles.map((f) =>
            f.path === filePath ? { ...f, dirty: false, savedContent: f.content } : f,
          );
          return { openFiles };
        });
      },

      setTreeLoading: (loading) => set({ treeLoading: loading }),

      setError: (error) => set({ error }),

      clearOpenTabs: () => set({ openFiles: [], activeFilePath: null }),

      setProjectIdentity: (root) => set({ projectIdentity: root }),

      hydrateFileContent: (filePath, content) => {
        const state = get();
        if (!state.hydratingPaths.has(filePath)) return false;
        const nextHydrating = new Set(state.hydratingPaths);
        nextHydrating.delete(filePath);
        const target = state.openFiles.find((f) => f.path === filePath);
        // A late read response must never overwrite a tab the user has
        // started editing, and hydration never steals focus — drop the
        // fetched content if the stub is gone or no longer pristine.
        if (!target || target.dirty || target.content !== '' || target.savedContent !== '') {
          set({ hydratingPaths: nextHydrating });
          return false;
        }
        set({
          hydratingPaths: nextHydrating,
          openFiles: state.openFiles.map((f) =>
            f.path === filePath ? { ...f, content, savedContent: content, dirty: false } : f,
          ),
        });
        return true;
      },

      hydrateFileFailed: (filePath) => {
        const state = get();
        if (!state.hydratingPaths.has(filePath)) return;
        const nextHydrating = new Set(state.hydratingPaths);
        nextHydrating.delete(filePath);
        const target = state.openFiles.find((f) => f.path === filePath);
        const pristine =
          !target || (target.content === '' && !target.dirty && target.savedContent === '');
        set({ hydratingPaths: nextHydrating });
        // A pristine stub for a vanished file is a dead tab — drop it. A tab
        // the user has typed into stays open; their next save recreates the
        // file intentionally.
        if (pristine && target) {
          get().closeFile(filePath);
        }
      },
    }),
    {
      name: 'wrongstack-file-store',
      version: 2,
      // Only persist tab paths + the active file + the canonical project
      // identity. Tree, loading, and error are transient state re-fetched on
      // reconnect. Content is deliberately NOT persisted: cached content
      // restored after a reload would silently overwrite on-disk changes on
      // the next save. Rehydrated stubs are re-fetched from disk via
      // reconcileFileTabsAfterEnvChange. `projectRoot` (display label) is
      // NOT persisted — it can be a relative label; `projectIdentity` is the
      // absolute env root used for cross-project detection.
      partialize: (state): PersistedFileStoreState => ({
        openFilePaths: state.openFiles.map((f) => f.path),
        activeFilePath: state.activeFilePath,
        projectIdentity: state.projectIdentity,
      }),
      // v1 payloads carried full file content — untrustworthy by definition.
      // Drop them rather than restore stale data.
      migrate: (): PersistedFileStoreState => ({
        openFilePaths: [],
        activeFilePath: null,
        projectIdentity: '',
      }),
      merge: (persisted, current) => mergePersistedFileStore(persisted, current),
    },
  ),
);
