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

interface FileStoreState {
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

  // Actions
  setTree: (root: string, tree: TreeNode[]) => void;
  openFile: (filePath: string, content: string) => void;
  closeFile: (filePath: string) => void;
  setActiveFile: (filePath: string | null) => void;
  updateContent: (filePath: string, content: string) => void;
  /** Mark a file as saved (synced with disk). */
  markSaved: (filePath: string) => void;
  setTreeLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
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

      setTree: (root, tree) =>
        set({ projectRoot: root, tree, treeLoading: false, error: null }),

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
    }),
    {
      name: 'wrongstack-file-store',
      version: 1,
      // Only persist open tabs and the active file — tree, loading, and
      // error are transient state that's re-fetched on WebSocket reconnect.
      partialize: (state) => ({
        openFiles: state.openFiles,
        activeFilePath: state.activeFilePath,
      }),
    },
  ),
);
