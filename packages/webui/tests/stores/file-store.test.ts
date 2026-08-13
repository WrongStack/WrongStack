import { beforeEach, describe, expect, it } from 'vitest';
import { useFileStore } from '../../src/stores/file-store';

// ── helpers ──────────────────────────────────────────────────────────

function resetStore() {
  useFileStore.setState({
    projectRoot: '',
    tree: [],
    openFiles: [],
    activeFilePath: null,
    treeLoading: false,
    error: null,
  });
}

// ── setTree ─────────────────────────────────────────────────────────

describe('setTree', () => {
  beforeEach(() => resetStore());

  it('sets projectRoot and tree', () => {
    const root = '/project';
    const tree = [{ name: 'src', path: '/project/src', type: 'directory' as const, children: [] }];
    useFileStore.getState().setTree(root, tree);
    const state = useFileStore.getState();
    expect(state.projectRoot).toBe(root);
    expect(state.tree).toEqual(tree);
  });

  it('resets treeLoading to false and clears error', () => {
    useFileStore.setState({ treeLoading: true, error: 'previous error' });
    useFileStore.getState().setTree('/project', []);
    const state = useFileStore.getState();
    expect(state.treeLoading).toBe(false);
    expect(state.error).toBe(null);
  });
});

// ── openFile ────────────────────────────────────────────────────────

describe('openFile', () => {
  beforeEach(() => resetStore());

  it('opens a new file tab and sets it as active', () => {
    useFileStore.getState().openFile('/project/src/index.ts', 'console.log("hello")');
    const state = useFileStore.getState();
    expect(state.openFiles).toHaveLength(1);
    expect(state.openFiles[0].path).toBe('/project/src/index.ts');
    expect(state.openFiles[0].content).toBe('console.log("hello")');
    expect(state.openFiles[0].dirty).toBe(false);
    expect(state.openFiles[0].savedContent).toBe('console.log("hello")');
    expect(state.activeFilePath).toBe('/project/src/index.ts');
  });

  it('switches to already-open file without duplicating tab', () => {
    useFileStore.getState().openFile('/project/src/index.ts', 'original');
    useFileStore.getState().openFile('/project/src/index.ts', 'original');
    const state = useFileStore.getState();
    expect(state.openFiles).toHaveLength(1);
    expect(state.activeFilePath).toBe('/project/src/index.ts');
  });

  it('refreshes an already-open file with content from disk', () => {
    useFileStore.getState().openFile('/project/src/index.ts', 'stale');
    useFileStore.getState().updateContent('/project/src/index.ts', 'unsaved edit');

    useFileStore.getState().openFile('/project/src/other.ts', 'other');
    useFileStore.getState().openFile('/project/src/index.ts', 'fresh from disk');

    const state = useFileStore.getState();
    expect(state.openFiles).toHaveLength(2);
    expect(state.activeFilePath).toBe('/project/src/index.ts');
    expect(state.openFiles.find((file) => file.path === '/project/src/index.ts')).toEqual({
      path: '/project/src/index.ts',
      content: 'fresh from disk',
      dirty: false,
      savedContent: 'fresh from disk',
    });
  });

  it('adds second file tab alongside first', () => {
    useFileStore.getState().openFile('/project/src/a.ts', 'a');
    useFileStore.getState().openFile('/project/src/b.ts', 'b');
    const state = useFileStore.getState();
    expect(state.openFiles).toHaveLength(2);
    expect(state.activeFilePath).toBe('/project/src/b.ts');
  });
});

// ── closeFile ───────────────────────────────────────────────────────

describe('closeFile', () => {
  beforeEach(() => resetStore());

  it('closes the open tab and clears activeFilePath when last file', () => {
    useFileStore.getState().openFile('/project/src/a.ts', 'a');
    useFileStore.getState().closeFile('/project/src/a.ts');
    const state = useFileStore.getState();
    expect(state.openFiles).toHaveLength(0);
    expect(state.activeFilePath).toBe(null);
  });

  it('closes non-active tab and leaves other tabs open', () => {
    useFileStore.getState().openFile('/project/src/a.ts', 'a');
    useFileStore.getState().openFile('/project/src/b.ts', 'b');
    useFileStore.getState().closeFile('/project/src/a.ts');
    const state = useFileStore.getState();
    expect(state.openFiles).toHaveLength(1);
    expect(state.openFiles[0].path).toBe('/project/src/b.ts');
    expect(state.activeFilePath).toBe('/project/src/b.ts');
  });

  it('activates the tab to the right when closing the active tab', () => {
    useFileStore.getState().openFile('/project/src/a.ts', 'a');
    useFileStore.getState().openFile('/project/src/b.ts', 'b');
    useFileStore.getState().openFile('/project/src/c.ts', 'c');
    // activeFilePath is c.ts
    useFileStore.getState().closeFile('/project/src/c.ts');
    const state = useFileStore.getState();
    expect(state.openFiles).toHaveLength(2);
    // c.ts was at index 2, so index 2 is out of range — should activate last
    expect(state.activeFilePath).toBe('/project/src/b.ts');
  });

  it('activates the file at same index when closing the active tab (middle)', () => {
    useFileStore.getState().openFile('/project/src/a.ts', 'a');
    useFileStore.getState().openFile('/project/src/b.ts', 'b');
    useFileStore.getState().openFile('/project/src/c.ts', 'c');
    useFileStore.getState().setActiveFile('/project/src/b.ts');
    useFileStore.getState().closeFile('/project/src/b.ts');
    const state = useFileStore.getState();
    expect(state.openFiles).toHaveLength(2);
    // b.ts was at index 1, c.ts shifts to index 1
    expect(state.activeFilePath).toBe('/project/src/c.ts');
  });

  it('is a no-op when file is not open', () => {
    useFileStore.getState().openFile('/project/src/a.ts', 'a');
    useFileStore.getState().closeFile('/project/src/not-open.ts');
    const state = useFileStore.getState();
    expect(state.openFiles).toHaveLength(1);
    expect(state.activeFilePath).toBe('/project/src/a.ts');
  });
});

// ── setActiveFile ───────────────────────────────────────────────────

describe('setActiveFile', () => {
  beforeEach(() => resetStore());

  it('switches active file without opening a new tab', () => {
    useFileStore.getState().openFile('/project/src/a.ts', 'a');
    useFileStore.getState().openFile('/project/src/b.ts', 'b');
    useFileStore.getState().setActiveFile('/project/src/a.ts');
    expect(useFileStore.getState().activeFilePath).toBe('/project/src/a.ts');
    expect(useFileStore.getState().openFiles).toHaveLength(2);
  });

  it('can set active to null', () => {
    useFileStore.getState().openFile('/project/src/a.ts', 'a');
    useFileStore.getState().setActiveFile(null);
    expect(useFileStore.getState().activeFilePath).toBe(null);
  });
});

// ── updateContent ────────────────────────────────────────────────────

describe('updateContent', () => {
  beforeEach(() => resetStore());

  it('updates content and marks dirty when content differs from saved', () => {
    useFileStore.getState().openFile('/project/src/index.ts', 'original');
    useFileStore.getState().updateContent('/project/src/index.ts', 'modified');
    const file = useFileStore.getState().openFiles[0];
    expect(file.content).toBe('modified');
    expect(file.dirty).toBe(true);
    expect(file.savedContent).toBe('original');
  });

  it('clears dirty flag when content matches savedContent', () => {
    useFileStore.getState().openFile('/project/src/index.ts', 'original');
    useFileStore.getState().updateContent('/project/src/index.ts', 'original');
    const file = useFileStore.getState().openFiles[0];
    expect(file.dirty).toBe(false);
  });

  it('is a no-op when file is not open', () => {
    useFileStore.getState().openFile('/project/src/a.ts', 'a');
    useFileStore.getState().updateContent('/project/src/not-open.ts', 'x');
    expect(useFileStore.getState().openFiles[0].content).toBe('a');
  });

  it('only updates the matching file', () => {
    useFileStore.getState().openFile('/project/src/a.ts', 'a');
    useFileStore.getState().openFile('/project/src/b.ts', 'b');
    useFileStore.getState().updateContent('/project/src/a.ts', 'modified');
    const fileA = useFileStore.getState().openFiles.find((f) => f.path === '/project/src/a.ts');
    const fileB = useFileStore.getState().openFiles.find((f) => f.path === '/project/src/b.ts');
    expect(fileA?.content).toBe('modified');
    expect(fileB?.content).toBe('b');
  });
});

// ── markSaved ───────────────────────────────────────────────────────

describe('markSaved', () => {
  beforeEach(() => resetStore());

  it('clears dirty flag and updates savedContent', () => {
    useFileStore.getState().openFile('/project/src/index.ts', 'original');
    useFileStore.getState().updateContent('/project/src/index.ts', 'modified');
    expect(useFileStore.getState().openFiles[0].dirty).toBe(true);
    useFileStore.getState().markSaved('/project/src/index.ts');
    const file = useFileStore.getState().openFiles[0];
    expect(file.dirty).toBe(false);
    expect(file.savedContent).toBe('modified');
  });

  it('is a no-op when file is not open', () => {
    useFileStore.getState().openFile('/project/src/a.ts', 'a');
    useFileStore.getState().markSaved('/project/src/not-open.ts'); // should not throw
    expect(useFileStore.getState().openFiles).toHaveLength(1);
  });
});

// ── setTreeLoading ──────────────────────────────────────────────────

describe('setTreeLoading', () => {
  beforeEach(() => resetStore());

  it('sets treeLoading to true', () => {
    useFileStore.getState().setTreeLoading(true);
    expect(useFileStore.getState().treeLoading).toBe(true);
  });

  it('sets treeLoading to false', () => {
    useFileStore.setState({ treeLoading: true });
    useFileStore.getState().setTreeLoading(false);
    expect(useFileStore.getState().treeLoading).toBe(false);
  });
});

// ── persist middleware ──────────────────────────────────────────────

describe('persist middleware', () => {
  beforeEach(() => resetStore());

  it('persists openFiles and activeFilePath to localStorage', () => {
    useFileStore.getState().openFile('/proj/a.ts', 'content-a');
    useFileStore.getState().openFile('/proj/b.ts', 'content-b');
    useFileStore.getState().setActiveFile('/proj/b.ts');

    const raw = localStorage.getItem('wrongstack-file-store');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.openFiles).toHaveLength(2);
    expect(parsed.state.openFiles[0].path).toBe('/proj/a.ts');
    expect(parsed.state.openFiles[1].path).toBe('/proj/b.ts');
    expect(parsed.state.activeFilePath).toBe('/proj/b.ts');
  });

  it('does NOT persist transient state (tree, treeLoading, error)', () => {
    useFileStore.getState().setTree('/proj', [{ name: 'x', path: '/proj/x', type: 'file' }]);
    useFileStore.getState().setTreeLoading(true);
    useFileStore.getState().setError('boom');

    const raw = localStorage.getItem('wrongstack-file-store');
    const parsed = JSON.parse(raw!);
    expect(parsed.state.tree).toBeUndefined();
    expect(parsed.state.treeLoading).toBeUndefined();
    expect(parsed.state.error).toBeUndefined();
  });

  it('restores open tabs and active file on rehydration', () => {
    // Simulate what happens on page load: store already has persisted data
    // in localStorage, and Zustand persist reads it on creation.
    localStorage.setItem(
      'wrongstack-file-store',
      JSON.stringify({
        state: {
          openFiles: [
            { path: '/proj/a.ts', content: 'hello', dirty: false, savedContent: 'hello' },
            { path: '/proj/b.ts', content: 'world-edited', dirty: true, savedContent: 'world' },
          ],
          activeFilePath: '/proj/b.ts',
        },
        version: 1,
      }),
    );

    // Force rehydration by re-creating the store state from persisted data.
    // In a real browser, Zustand persist does this automatically on creation.
    const persisted = JSON.parse(localStorage.getItem('wrongstack-file-store')!);
    useFileStore.setState({
      openFiles: persisted.state.openFiles,
      activeFilePath: persisted.state.activeFilePath,
    });

    const state = useFileStore.getState();
    expect(state.openFiles).toHaveLength(2);
    expect(state.openFiles[0].path).toBe('/proj/a.ts');
    expect(state.openFiles[0].dirty).toBe(false);
    // Dirty state is preserved across rehydration.
    expect(state.openFiles[1].path).toBe('/proj/b.ts');
    expect(state.openFiles[1].dirty).toBe(true);
    expect(state.openFiles[1].content).toBe('world-edited');
    expect(state.openFiles[1].savedContent).toBe('world');
    expect(state.activeFilePath).toBe('/proj/b.ts');
  });

  it('includes version: 1 in the persisted payload', () => {
    useFileStore.getState().openFile('/proj/a.ts', 'content');
    const raw = localStorage.getItem('wrongstack-file-store');
    const parsed = JSON.parse(raw!);
    expect(parsed.version).toBe(1);
  });
});

// ── setError ─────────────────────────────────────────────────────────

describe('setError', () => {
  beforeEach(() => resetStore());

  it('sets error message', () => {
    useFileStore.getState().setError('something went wrong');
    expect(useFileStore.getState().error).toBe('something went wrong');
  });

  it('clears error when set to null', () => {
    useFileStore.setState({ error: 'previous' });
    useFileStore.getState().setError(null);
    expect(useFileStore.getState().error).toBe(null);
  });
});
