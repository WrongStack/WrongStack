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
  /**
   * True when the project-root `.gitignore` matches this entry. The server
   * already filters these out of `files.tree`, so this flag is normally
   * absent — it is declared so the WebUI can defensively ignore any
   * `ignored: true` node that slips through (e.g. if a future server
   * version stops pruning), keeping features like the Bug Hunter scope
   * dropdown from re-listing hidden directories.
   */
  ignored?: boolean;
}

export interface OpenFile {
  path: string;
  content: string;
  /** True when the editor content differs from what's on disk. */
  dirty: boolean;
  /** The content last known to be on disk — used for dirty detection. */
  savedContent: string;
}

interface FileSessionState {
  projectRoot: string;
  tree: TreeNode[];
  openFiles: OpenFile[];
  activeFilePath: string | null;
  treeLoading: boolean;
  error: string | null;
  targetLine: FileStoreState['targetLine'];
  projectIdentity: string;
  hydratingPaths: ReadonlySet<string>;
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
  setTree: (root: string, tree: TreeNode[], sessionId?: string | null | undefined) => void;
  openFile: (filePath: string, content: string, sessionId?: string | null | undefined) => void;
  closeFile: (filePath: string, sessionId?: string | null | undefined) => void;
  setActiveFile: (filePath: string | null, sessionId?: string | null | undefined) => void;
  jumpToLine: (line: number, col?: number, sessionId?: string | null | undefined) => void;
  clearTargetLine: () => void;
  updateContent: (filePath: string, content: string) => void;
  /** Mark a file as saved (synced with disk). */
  markSaved: (filePath: string, sessionId?: string | null | undefined) => void;
  setTreeLoading: (loading: boolean, sessionId?: string | null | undefined) => void;
  setError: (error: string | null, sessionId?: string | null | undefined) => void;
  /** Drop all open tabs (used when the server switches to a different project). */
  clearOpenTabs: (sessionId?: string | null | undefined) => void;
  /**
   * Canonical absolute project root as reported by the server environment
   * (working_dir.changed / session env). Distinct from `projectRoot`, which
   * holds the tree-response display label and can be a cwd-relative label
   * ("subdir", ".") when browsing a subdirectory — never use that for
   * identity comparisons.
   */
  projectIdentity: string;
  /** Record the canonical absolute project root (env events only). */
  setProjectIdentity: (root: string, sessionId?: string | null | undefined) => void;
  /** Paths whose rehydrated stub content is currently being fetched. */
  hydratingPaths: ReadonlySet<string>;
  setHydratingPaths: (paths: Iterable<string>, sessionId?: string | null | undefined) => void;
  /** Which session the file editor projection currently describes. */
  fileSessionId: string | null;
  /** Per-session open editor tabs and jump targets. */
  filesBySession: Record<string, FileSessionState>;
  bindSessionFiles: (sessionId: string | null) => void;
  forgetSessionFiles: (sessionId: string) => void;
  /**
   * Apply fetched content to a rehydrated stub tab. Only applies while the
   * path is still hydrating AND the tab is still a pristine stub — never
   * overwrites content the user has started editing, never steals focus.
   * Returns true when the content was applied.
   */
  hydrateFileContent: (
    filePath: string,
    content: string,
    sessionId?: string | null | undefined,
  ) => boolean;
  /**
   * Handle a failed hydration read (file deleted or renamed on disk while
   * the page was closed). Removes the path from hydration tracking and
   * closes the tab when it is still a pristine stub — leaving it open would
   * let the next save resurrect a deleted file. A tab the user has started
   * editing is kept; its save recreates the file intentionally.
   */
  hydrateFileFailed: (filePath: string, sessionId?: string | null | undefined) => void;
}

/** Shape written to localStorage — tabs are paths only, never content. */
interface PersistedFileStoreState {
  openFilePaths: string[];
  activeFilePath: string | null;
  /** Canonical absolute project root (env identity), not the display label. */
  projectIdentity: string;
}

function defaultFileSession(): FileSessionState {
  return {
    projectRoot: '',
    tree: [],
    openFiles: [],
    activeFilePath: null,
    treeLoading: false,
    error: null,
    targetLine: null,
    projectIdentity: '',
    hydratingPaths: new Set<string>(),
  };
}

function readFileSession(state: FileStoreState): FileSessionState {
  return {
    projectRoot: state.projectRoot,
    tree: state.tree,
    openFiles: state.openFiles,
    activeFilePath: state.activeFilePath,
    treeLoading: state.treeLoading,
    error: state.error,
    targetLine: state.targetLine,
    projectIdentity: state.projectIdentity,
    hydratingPaths: state.hydratingPaths,
  };
}

function projectFileSession(fileSession: FileSessionState): Partial<FileStoreState> {
  return {
    projectRoot: fileSession.projectRoot,
    tree: fileSession.tree,
    openFiles: fileSession.openFiles,
    activeFilePath: fileSession.activeFilePath,
    treeLoading: fileSession.treeLoading,
    error: fileSession.error,
    targetLine: fileSession.targetLine,
    projectIdentity: fileSession.projectIdentity,
    hydratingPaths: fileSession.hydratingPaths,
  };
}

function updateFileSession(
  state: FileStoreState,
  sessionId: string | null | undefined,
  updater: (fileSession: FileSessionState) => FileSessionState,
): Partial<FileStoreState> {
  if (sessionId && state.fileSessionId !== sessionId) {
    const current = state.filesBySession[sessionId] ?? defaultFileSession();
    return {
      filesBySession: {
        ...state.filesBySession,
        [sessionId]: updater(current),
      },
    };
  }
  const current = readFileSession(state);
  const next = updater(current);
  const parked = state.fileSessionId
    ? {
        filesBySession: {
          ...state.filesBySession,
          [state.fileSessionId]: next,
        },
      }
    : {};
  return { ...projectFileSession(next), ...parked };
}

function parkFiles(
  state: FileStoreState,
  patch: Partial<FileSessionState>,
): { filesBySession?: FileStoreState['filesBySession'] } {
  if (!state.fileSessionId) return {};
  return {
    filesBySession: {
      ...state.filesBySession,
      [state.fileSessionId]: { ...readFileSession(state), ...patch },
    },
  };
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
      : (paths[0] ?? null);
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
      fileSessionId: null,
      filesBySession: {},

      bindSessionFiles: (sessionId) =>
        set((state) => {
          if (state.fileSessionId === sessionId) return {};
          const filesBySession = { ...state.filesBySession };
          if (state.fileSessionId) {
            filesBySession[state.fileSessionId] = readFileSession(state);
          }
          const next = sessionId ? filesBySession[sessionId] : undefined;
          const fileSession = next ?? defaultFileSession();
          return {
            fileSessionId: sessionId,
            filesBySession,
            ...projectFileSession(fileSession),
          };
        }),
      forgetSessionFiles: (sessionId) =>
        set((state) => {
          const filesBySession = { ...state.filesBySession };
          delete filesBySession[sessionId];
          if (state.fileSessionId !== sessionId) return { filesBySession };
          return {
            filesBySession,
            fileSessionId: null,
            ...defaultFileSession(),
          };
        }),

      jumpToLine: (line, col, sessionId) =>
        set((state) => {
          const targetLine = { line, col };
          return updateFileSession(state, sessionId, (fileSession) => ({
            ...fileSession,
            targetLine,
          }));
        }),
      clearTargetLine: () =>
        set((state) => ({ targetLine: null, ...parkFiles(state, { targetLine: null }) })),

      setTree: (root, tree, sessionId) =>
        set((state) =>
          updateFileSession(state, sessionId, (fileSession) => ({
            ...fileSession,
            projectRoot: root,
            tree,
            treeLoading: false,
            error: null,
          })),
        ),

      openFile: (filePath, content, sessionId) =>
        set((state) =>
          updateFileSession(state, sessionId, (fileSession) => {
            const existing = fileSession.openFiles.find((f) => f.path === filePath);
            if (existing) {
              const openFiles = fileSession.openFiles.map((file) =>
                file.path === filePath
                  ? { ...file, content, dirty: false, savedContent: content }
                  : file,
              );
              return { ...fileSession, openFiles, activeFilePath: filePath };
            }
            const openFiles = [
              ...fileSession.openFiles,
              { path: filePath, content, dirty: false, savedContent: content },
            ];
            return { ...fileSession, openFiles, activeFilePath: filePath };
          }),
        ),

      closeFile: (filePath, sessionId) =>
        set((state) =>
          updateFileSession(state, sessionId, (fileSession) => {
            const idx = fileSession.openFiles.findIndex((f) => f.path === filePath);
            if (idx === -1) return fileSession;
            const openFiles = [...fileSession.openFiles];
            openFiles.splice(idx, 1);
            let activeFilePath = fileSession.activeFilePath;
            if (fileSession.activeFilePath === filePath) {
              // Activate the tab to the right, or the last tab, or null.
              if (openFiles.length === 0) {
                activeFilePath = null;
              } else if (idx < openFiles.length) {
                activeFilePath = openFiles[idx].path;
              } else {
                activeFilePath = openFiles[openFiles.length - 1].path;
              }
            }
            return { ...fileSession, openFiles, activeFilePath };
          }),
        ),

      setActiveFile: (filePath, sessionId) =>
        set((state) =>
          updateFileSession(state, sessionId, (fileSession) => ({
            ...fileSession,
            activeFilePath: filePath,
          })),
        ),

      updateContent: (filePath, content) => {
        set((state) => {
          const openFiles = state.openFiles.map((f) =>
            f.path === filePath ? { ...f, content, dirty: content !== f.savedContent } : f,
          );
          return { openFiles, ...parkFiles(state, { openFiles }) };
        });
      },

      markSaved: (filePath, sessionId) =>
        set((state) =>
          updateFileSession(state, sessionId, (fileSession) => ({
            ...fileSession,
            openFiles: fileSession.openFiles.map((f) =>
              f.path === filePath ? { ...f, dirty: false, savedContent: f.content } : f,
            ),
          })),
        ),

      setTreeLoading: (loading, sessionId) =>
        set((state) =>
          updateFileSession(state, sessionId, (fileSession) => ({
            ...fileSession,
            treeLoading: loading,
          })),
        ),

      setError: (error, sessionId) =>
        set((state) =>
          updateFileSession(state, sessionId, (fileSession) => ({
            ...fileSession,
            error,
          })),
        ),

      clearOpenTabs: (sessionId) =>
        set((state) =>
          updateFileSession(state, sessionId, (fileSession) => ({
            ...fileSession,
            openFiles: [],
            activeFilePath: null,
          })),
        ),

      setProjectIdentity: (root, sessionId) =>
        set((state) =>
          updateFileSession(state, sessionId, (fileSession) => ({
            ...fileSession,
            projectIdentity: root,
          })),
        ),

      setHydratingPaths: (paths, sessionId) =>
        set((state) =>
          updateFileSession(state, sessionId, (fileSession) => ({
            ...fileSession,
            hydratingPaths: new Set(paths),
          })),
        ),

      hydrateFileContent: (filePath, content, sessionId) => {
        const state = get();
        let applied = false;
        const patch = updateFileSession(state, sessionId, (fileSession) => {
          if (!fileSession.hydratingPaths.has(filePath)) return fileSession;
          const hydratingPaths = new Set(fileSession.hydratingPaths);
          hydratingPaths.delete(filePath);
          const target = fileSession.openFiles.find((f) => f.path === filePath);
          // A late read response must never overwrite a tab the user has
          // started editing, and hydration never steals focus — drop the
          // fetched content if the stub is gone or no longer pristine.
          if (!target || target.dirty || target.content !== '' || target.savedContent !== '') {
            return { ...fileSession, hydratingPaths };
          }
          applied = true;
          const openFiles = fileSession.openFiles.map((f) =>
            f.path === filePath ? { ...f, content, savedContent: content, dirty: false } : f,
          );
          return { ...fileSession, hydratingPaths, openFiles };
        });
        set(patch);
        return applied;
      },

      hydrateFileFailed: (filePath, sessionId) =>
        set((state) =>
          updateFileSession(state, sessionId, (fileSession) => {
            if (!fileSession.hydratingPaths.has(filePath)) return fileSession;
            const hydratingPaths = new Set(fileSession.hydratingPaths);
            hydratingPaths.delete(filePath);
            const target = fileSession.openFiles.find((f) => f.path === filePath);
            const pristine =
              !target || (target.content === '' && !target.dirty && target.savedContent === '');
            const openFiles =
              pristine && target
                ? fileSession.openFiles.filter((file) => file.path !== filePath)
                : fileSession.openFiles;
            const activeFilePath =
              fileSession.activeFilePath === filePath
                ? (openFiles[0]?.path ?? null)
                : fileSession.activeFilePath;
            return { ...fileSession, hydratingPaths, openFiles, activeFilePath };
          }),
        ),
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
