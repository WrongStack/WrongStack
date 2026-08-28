import { beforeEach, describe, expect, it } from 'vitest';
import {
  type FileStoreState,
  mergePersistedFileStore,
  useFileStore,
} from '../../src/stores/file-store';

// ── helpers ──────────────────────────────────────────────────────────

function resetStore() {
  useFileStore.setState({
    projectRoot: '',
    tree: [],
    openFiles: [],
    activeFilePath: null,
    treeLoading: false,
    error: null,
    projectIdentity: '',
    hydratingPaths: new Set<string>(),
    fileSessionId: null,
    filesBySession: {},
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

describe('session file lanes', () => {
  beforeEach(() => resetStore());

  it('keeps open editor tabs and active file per session', () => {
    useFileStore.getState().bindSessionFiles('sess-a');
    useFileStore.getState().openFile('/project/a.ts', 'a');
    useFileStore.getState().jumpToLine(7);

    useFileStore.getState().bindSessionFiles('sess-b');
    expect(useFileStore.getState()).toMatchObject({
      fileSessionId: 'sess-b',
      openFiles: [],
      activeFilePath: null,
      targetLine: null,
    });

    useFileStore.getState().openFile('/project/b.ts', 'b');
    useFileStore.getState().bindSessionFiles('sess-a');
    expect(useFileStore.getState()).toMatchObject({
      fileSessionId: 'sess-a',
      activeFilePath: '/project/a.ts',
      targetLine: { line: 7 },
    });
    expect(useFileStore.getState().openFiles.map((file) => file.path)).toEqual(['/project/a.ts']);

    useFileStore.getState().bindSessionFiles('sess-b');
    expect(useFileStore.getState()).toMatchObject({
      fileSessionId: 'sess-b',
      activeFilePath: '/project/b.ts',
    });
    expect(useFileStore.getState().openFiles.map((file) => file.path)).toEqual(['/project/b.ts']);
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

  it('persists tab paths, active file, and project identity — never content', () => {
    useFileStore.getState().setTree('/proj', []);
    // Identity comes from the server env (absolute root), not the tree
    // display label — setTree's root can be a cwd-relative label.
    useFileStore.getState().setProjectIdentity('/proj');
    useFileStore.getState().openFile('/proj/a.ts', 'content-a');
    useFileStore.getState().openFile('/proj/b.ts', 'content-b');
    useFileStore.getState().setActiveFile('/proj/b.ts');

    const raw = localStorage.getItem('wrongstack-file-store');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.openFilePaths).toEqual(['/proj/a.ts', '/proj/b.ts']);
    expect(parsed.state.activeFilePath).toBe('/proj/b.ts');
    expect(parsed.state.projectIdentity).toBe('/proj');
    expect(parsed.state.openFiles).toBeUndefined();
    expect(parsed.state.projectRoot).toBeUndefined();
    // Cached content must never reach localStorage — restoring it after a
    // reload would silently overwrite on-disk changes on the next save.
    expect(raw).not.toContain('content-a');
    expect(raw).not.toContain('content-b');
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

  it('includes version: 2 in the persisted payload', () => {
    useFileStore.getState().openFile('/proj/a.ts', 'content');
    const raw = localStorage.getItem('wrongstack-file-store');
    const parsed = JSON.parse(raw!);
    expect(parsed.version).toBe(2);
  });
});

// ── mergePersistedFileStore (rehydration) ───────────────────────────

describe('mergePersistedFileStore', () => {
  beforeEach(() => resetStore());

  function current(): FileStoreState {
    return useFileStore.getState();
  }

  it('restores v2 path-only payloads as empty-content stubs', () => {
    const merged = mergePersistedFileStore(
      {
        openFilePaths: ['/proj/a.ts', '/proj/b.ts'],
        activeFilePath: '/proj/b.ts',
        projectIdentity: '/proj',
      },
      current(),
    );
    expect(merged.openFiles).toEqual([
      { path: '/proj/a.ts', content: '', dirty: false, savedContent: '' },
      { path: '/proj/b.ts', content: '', dirty: false, savedContent: '' },
    ]);
    expect(merged.activeFilePath).toBe('/proj/b.ts');
    expect(merged.projectIdentity).toBe('/proj');
  });

  it('never restores legacy v1 payloads carrying file content', () => {
    // v1 stored full content + dirty flags. Both the migrate step (version
    // bump) and the merge itself must refuse to resurrect that content.
    const merged = mergePersistedFileStore(
      {
        openFiles: [{ path: '/proj/a.ts', content: 'stale', dirty: true, savedContent: 'old' }],
        activeFilePath: '/proj/a.ts',
      },
      current(),
    );
    expect(merged.openFiles).toEqual([]);
    expect(merged.activeFilePath).toBeNull();
  });

  it('falls back to the first tab when activeFilePath is not among persisted paths', () => {
    const merged = mergePersistedFileStore(
      {
        openFilePaths: ['/proj/a.ts', '/proj/b.ts'],
        activeFilePath: '/proj/gone.ts',
        projectIdentity: '/proj',
      },
      current(),
    );
    expect(merged.activeFilePath).toBe('/proj/a.ts');
  });

  it('ignores malformed path entries and non-string projectIdentity', () => {
    const merged = mergePersistedFileStore(
      { openFilePaths: ['/proj/a.ts', '', 42, null], projectIdentity: 7 },
      current(),
    );
    expect(merged.openFiles.map((f) => f.path)).toEqual(['/proj/a.ts']);
    expect(merged.activeFilePath).toBe('/proj/a.ts');
    expect(merged.projectIdentity).toBe('');
  });

  it('handles missing persisted state', () => {
    const merged = mergePersistedFileStore(undefined, current());
    expect(merged.openFiles).toEqual([]);
    expect(merged.activeFilePath).toBeNull();
  });
});

// ── hydrateFileContent (rehydration race guards) ─────────────────────

describe('hydrateFileContent', () => {
  beforeEach(() => resetStore());

  function stubTabs(paths: string[]) {
    useFileStore.setState({
      openFiles: paths.map((path) => ({ path, content: '', dirty: false, savedContent: '' })),
      activeFilePath: paths[0] ?? null,
      hydratingPaths: new Set(paths),
    });
  }

  it('fills a pristine stub without changing the active tab', () => {
    stubTabs(['/proj/a.ts', '/proj/b.ts']);
    useFileStore.getState().setActiveFile('/proj/b.ts');
    const applied = useFileStore.getState().hydrateFileContent('/proj/a.ts', 'disk-content');
    expect(applied).toBe(true);
    const file = useFileStore.getState().openFiles.find((f) => f.path === '/proj/a.ts');
    expect(file?.content).toBe('disk-content');
    expect(file?.savedContent).toBe('disk-content');
    // Hydration must never steal focus from the persisted active tab.
    expect(useFileStore.getState().activeFilePath).toBe('/proj/b.ts');
    expect(useFileStore.getState().hydratingPaths.has('/proj/a.ts')).toBe(false);
  });

  it('does not overwrite a tab the user has started editing', () => {
    stubTabs(['/proj/a.ts']);
    useFileStore.getState().updateContent('/proj/a.ts', 'user typing');
    const applied = useFileStore.getState().hydrateFileContent('/proj/a.ts', 'late-read');
    expect(applied).toBe(false);
    expect(useFileStore.getState().openFiles[0].content).toBe('user typing');
    expect(useFileStore.getState().hydratingPaths.has('/proj/a.ts')).toBe(false);
  });

  it('is a no-op for paths that are not hydrating', () => {
    stubTabs(['/proj/a.ts']);
    useFileStore.setState({ hydratingPaths: new Set<string>() });
    const applied = useFileStore.getState().hydrateFileContent('/proj/a.ts', 'late-read');
    expect(applied).toBe(false);
    expect(useFileStore.getState().openFiles[0].content).toBe('');
  });
});

// ── hydrateFileFailed (vanished-file handling) ───────────────────────

describe('hydrateFileFailed', () => {
  beforeEach(() => resetStore());

  function stubTabs(paths: string[]) {
    useFileStore.setState({
      openFiles: paths.map((path) => ({ path, content: '', dirty: false, savedContent: '' })),
      activeFilePath: paths[0] ?? null,
      hydratingPaths: new Set(paths),
    });
  }

  it('closes a pristine stub whose file vanished on disk', () => {
    stubTabs(['/proj/a.ts', '/proj/b.ts']);
    useFileStore.getState().hydrateFileFailed('/proj/a.ts');
    const state = useFileStore.getState();
    // The dead stub is dropped so the next save cannot resurrect the file.
    expect(state.openFiles.map((f) => f.path)).toEqual(['/proj/b.ts']);
    expect(state.hydratingPaths.has('/proj/a.ts')).toBe(false);
  });

  it('keeps a dirty tab open when its hydration read fails', () => {
    stubTabs(['/proj/a.ts']);
    useFileStore.getState().updateContent('/proj/a.ts', 'user typing');
    useFileStore.getState().hydrateFileFailed('/proj/a.ts');
    const state = useFileStore.getState();
    expect(state.openFiles).toHaveLength(1);
    expect(state.openFiles[0].content).toBe('user typing');
    expect(state.hydratingPaths.has('/proj/a.ts')).toBe(false);
  });

  it('is a no-op for paths that are not hydrating', () => {
    stubTabs(['/proj/a.ts']);
    useFileStore.setState({ hydratingPaths: new Set<string>() });
    useFileStore.getState().hydrateFileFailed('/proj/a.ts');
    expect(useFileStore.getState().openFiles).toHaveLength(1);
  });
});

// ── clearOpenTabs ────────────────────────────────────────────────────

describe('clearOpenTabs', () => {
  beforeEach(() => resetStore());

  it('drops all tabs and the active file', () => {
    useFileStore.getState().openFile('/proj/a.ts', 'a');
    useFileStore.getState().openFile('/proj/b.ts', 'b');
    useFileStore.getState().clearOpenTabs();
    const state = useFileStore.getState();
    expect(state.openFiles).toEqual([]);
    expect(state.activeFilePath).toBeNull();
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
