import { act, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '../../src/stores/file-store';
import { useFileStore } from '../../src/stores/file-store';
import { useGitChangesStore, useSessionStore } from '../../src/stores';
import { useFileReferenceStore } from '../../src/stores/file-reference-store';

// The tree is virtualized with virtua; jsdom has no layout, so windowing
// would render an unpredictable subset. Mock VList as a passthrough — these
// tests cover the flatten/expand/keyboard logic, not virtua's windowing.
vi.mock('virtua', () => ({
  VList: forwardRef(function MockVList(
    { children, ...rest }: { children: React.ReactNode; className?: string },
    ref: React.Ref<{ scrollToIndex: (i: number, opts?: unknown) => void }>,
  ) {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <div {...rest}>{children}</div>;
  }),
}));

// Mock the view-navigation module so showPanel('chat') is a no-op.
vi.mock('@/lib/view-navigation', () => ({
  showPanel: vi.fn(),
}));

import { FileExplorer } from '../../src/components/FileExplorer';

const makeTree = (): TreeNode[] => [
  {
    name: 'src',
    path: '/proj/src',
    type: 'directory',
    children: [
      { name: 'app.ts', path: '/proj/src/app.ts', type: 'file' },
      {
        name: 'lib',
        path: '/proj/src/lib',
        type: 'directory',
        children: [{ name: 'util.ts', path: '/proj/src/lib/util.ts', type: 'file' }],
      },
    ],
  },
  { name: 'empty-dir', path: '/proj/empty-dir', type: 'directory', children: [] },
  { name: 'readme.md', path: '/proj/readme.md', type: 'file' },
];

beforeEach(() => {
  useFileStore.getState().setTree('/proj', makeTree());
  useSessionStore.setState({ cwd: '/proj', projectName: 'proj' });
});

describe('FileExplorer (virtualized tree)', () => {
  it('starts collapsed by default — only root-level items visible', () => {
    render(<FileExplorer />);
    // Root-level items are visible…
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('empty-dir')).toBeTruthy();
    expect(screen.getByText('readme.md')).toBeTruthy();
    // …but directory children are NOT visible until expanded.
    expect(screen.queryByText('app.ts')).toBeNull();
    expect(screen.queryByText('lib')).toBeNull();
    expect(screen.queryByText('util.ts')).toBeNull();
  });

  it('maps git badges through repoPrefix when the project root is a repo subdirectory', () => {
    // Regression (chimera): porcelain paths are REPO-root-relative while
    // tree paths are PROJECT-root-relative. Opening packages/webui of a
    // monorepo as the project makes git keys carry a `packages/webui/`
    // prefix the tree never emits — every badge used to silently miss.
    // The server now sends repoPrefix; the lookup must prepend it.
    useSessionStore.setState({ cwd: '/subproj', projectName: 'subproj' });
    useFileStore.getState().setTree(
      '/subproj',
      makeTree().map((n) => ({
        ...n,
        path: n.path.replace('/proj', '/subproj'),
        children: n.children?.map((c) => ({
          ...c,
          path: c.path.replace('/proj', '/subproj'),
          children: c.children?.map((g) => ({ ...g, path: g.path.replace('/proj', '/subproj') })),
        })),
      })),
    );
    useGitChangesStore.getState().setFiles(
      [
        {
          path: 'subproj/src/app.ts',
          status: 'M',
          added: 1,
          deleted: 0,
          staged: false,
        },
        {
          path: 'subproj/src/lib/util.ts',
          status: 'M',
          added: 3,
          deleted: 1,
          staged: false,
        },
      ],
      null,
      'subproj/',
    );

    render(<FileExplorer />);
    fireEvent.click(screen.getByText('src')); // expand to reveal files

    // Direct file match through the prefix…
    expect(screen.getByText('app.ts')).toBeTruthy();
    const badges = screen
      .getAllByRole('img')
      .filter((el) => el.getAttribute('aria-label') === 'Modified');
    // app.ts (direct) + src and lib (directory aggregation through the
    // prefixed key) all resolve with repoPrefix present.
    expect(badges.length).toBeGreaterThanOrEqual(1);

    // Negative control: with NO prefix, the same repo-relative paths must
    // NOT match project-relative tree keys (proves the prefix is what
    // closes the gap, not a coincidental substring).
    act(() => {
      useGitChangesStore.getState().setFiles(
        [{ path: 'subproj/src/app.ts', status: 'M', added: 1, deleted: 0, staged: false }],
        null,
        '',
      );
    });
    expect(
      screen
        .queryAllByRole('img')
        .filter((el) => el.getAttribute('aria-label') === 'Modified'),
    ).toHaveLength(0);
  });

  it('expands and collapses a directory on click', () => {
    render(<FileExplorer />);
    // Expand src first, then click lib to expand it
    fireEvent.click(screen.getByText('src'));
    fireEvent.click(screen.getByText('lib'));
    expect(screen.getByText('util.ts')).toBeTruthy();
    // Collapse lib
    fireEvent.click(screen.getByText('lib'));
    expect(screen.queryByText('util.ts')).toBeNull();
  });

  it('shows the empty placeholder under an expanded empty directory', () => {
    render(<FileExplorer />);
    // Root dirs start collapsed, so click on empty-dir to expand it first
    expect(screen.queryByText('empty')).toBeNull();
    fireEvent.click(screen.getByText('empty-dir'));
    // Now the placeholder is visible…
    expect(screen.getByText('empty')).toBeTruthy();
    // …and collapsing the dir removes it.
    fireEvent.click(screen.getByText('empty-dir'));
    expect(screen.queryByText('empty')).toBeNull();
  });

  it('expand-all reveals nested files; collapse-all hides everything', () => {
    render(<FileExplorer />);
    fireEvent.click(screen.getByText('Expand all'));
    expect(screen.getByText('util.ts')).toBeTruthy();
    fireEvent.click(screen.getByText('Collapse'));
    expect(screen.queryByText('util.ts')).toBeNull();
    expect(screen.queryByText('app.ts')).toBeNull();
    // Root rows stay visible.
    expect(screen.getByText('src')).toBeTruthy();
  });

  it('supports arrow-key navigation: focus, expand, collapse', () => {
    render(<FileExplorer />);
    const tree = screen.getByRole('tree');

    // Tab into the tree highlights the first row (src).
    fireEvent.focus(tree);
    // ArrowRight on the collapsed `src` expands it.
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    // ArrowDown twice: src → app.ts → lib.
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    // ArrowRight on the collapsed `lib` dir expands it.
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(screen.getByText('util.ts')).toBeTruthy();
    // ArrowLeft collapses it again.
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(screen.queryByText('util.ts')).toBeNull();
  });

  it('Enter on a file dispatches the open-file event', () => {
    const seen: string[] = [];
    const onOpen = (e: Event) => {
      seen.push((e as CustomEvent<{ filePath: string }>).detail.filePath);
    };
    window.addEventListener('wrongstack:open-file', onOpen);
    try {
      render(<FileExplorer />);
      const tree = screen.getByRole('tree');
      fireEvent.focus(tree); // focus row 0 (src)
      fireEvent.keyDown(tree, { key: 'ArrowRight' }); // expand src → app.ts becomes row 1
      fireEvent.keyDown(tree, { key: 'ArrowDown' }); // app.ts
      fireEvent.keyDown(tree, { key: 'Enter' });
      expect(seen).toEqual(['/proj/src/app.ts']);
    } finally {
      window.removeEventListener('wrongstack:open-file', onOpen);
    }
  });

  it('keeps user expansion when the tree refreshes for the same cwd', () => {
    render(<FileExplorer />);
    // Expand src first so lib is visible, then expand lib.
    fireEvent.click(screen.getByText('src'));
    fireEvent.click(screen.getByText('lib'));
    expect(screen.getByText('util.ts')).toBeTruthy();
    // Watcher-style refresh: same cwd, new tree objects.
    act(() => {
      useFileStore.getState().setTree('/proj', makeTree());
    });
    // User's expansion of lib should persist.
    expect(screen.getByText('util.ts')).toBeTruthy();
  });

  it('right-click menu → Mention in chat adds a file reference to the store', () => {
    useFileReferenceStore.setState({ refs: [] });
    render(<FileExplorer />);

    // Expand src so app.ts becomes visible.
    fireEvent.click(screen.getByText('src'));

    // Right-click on a file node (app.ts).
    const fileNode = screen.getByText('app.ts');
    fireEvent.contextMenu(fileNode);

    // Context menu should appear with "Mention in chat".
    const menuItem = screen.getByText('Mention in chat');
    expect(menuItem).toBeTruthy();

    // Click it.
    fireEvent.click(menuItem);

    // The store should now have a file ref for this path.
    const refs = useFileReferenceStore.getState().refs;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'file', path: '/proj/src/app.ts' });
  });

  it('right-click menu on a directory does not show Mention in chat', () => {
    useFileReferenceStore.setState({ refs: [] });
    render(<FileExplorer />);

    // Right-click on a directory node.
    const dirNode = screen.getByText('src');
    fireEvent.contextMenu(dirNode);

    // "Mention in chat" should NOT be in the context menu for directories.
    expect(screen.queryByText('Mention in chat')).toBeNull();
  });

  it('sort-by-size toggle reorders file rows by size descending', () => {
    // Build a tree with files of different sizes.
    const sizedTree: TreeNode[] = [
      { name: 'small.txt', path: '/proj/small.txt', type: 'file', size: 100 },
      { name: 'large.ts', path: '/proj/large.ts', type: 'file', size: 5000 },
      { name: 'medium.json', path: '/proj/medium.json', type: 'file', size: 800 },
      { name: 'dir', path: '/proj/dir', type: 'directory' },
    ];
    useFileStore.getState().setTree('/proj', sizedTree);

    render(<FileExplorer />);

    // Default order is alphabetical (server order): dir, large.ts, medium.json, small.txt.
    // Directories always come first.
    const rowsBefore = screen.getAllByRole('treeitem').map((el) => el.textContent ?? '');
    const filesBefore = rowsBefore.filter((r) => !r.includes('dir'));
    // In default order, the files should appear in their original array order.
    expect(filesBefore[0]).toContain('small.txt');
    expect(filesBefore[1]).toContain('large.ts');
    expect(filesBefore[2]).toContain('medium.json');

    // Click the sort-by-size toggle button.
    const sortBtn = screen.getByTitle('Sort by file size (largest first)');
    fireEvent.click(sortBtn);

    // After sort-by-size: directory still first, then files largest → smallest.
    const rowsAfter = screen.getAllByRole('treeitem').map((el) => el.textContent ?? '');
    const filesAfter = rowsAfter.filter((r) => !r.includes('dir'));
    expect(filesAfter[0]).toContain('large.ts');
    expect(filesAfter[1]).toContain('medium.json');
    expect(filesAfter[2]).toContain('small.txt');
  });

  // ── Fuzzy search filter ─────────────────────────────────────────────

  it('search filter scores and ranks files by basename match', () => {
    const searchTree: TreeNode[] = [
      {
        name: 'src',
        path: '/proj/src',
        type: 'directory',
        children: [
          { name: 'app.ts', path: '/proj/src/app.ts', type: 'file' },
          { name: 'config.ts', path: '/proj/src/config.ts', type: 'file' },
        ],
      },
      { name: 'app.test.ts', path: '/proj/app.test.ts', type: 'file' },
      { name: 'readme.md', path: '/proj/readme.md', type: 'file' },
    ];
    useFileStore.getState().setTree('/proj', searchTree);

    render(<FileExplorer />);

    // Type "app" in the search input — should match app.test.ts (exact basename
    // prefix, score 60) and src/app.ts (basename prefix, score 60, deeper path
    // so penalized more). readme.md and config.ts should NOT appear.
    const input = screen.getByLabelText('Search files');
    fireEvent.change(input, { target: { value: 'app' } });

    const rows = screen.getAllByRole('treeitem').map((el) => el.textContent ?? '');
    // Both "app" files should be visible.
    expect(rows.some((r) => r.includes('app.test.ts'))).toBe(true);
    expect(rows.some((r) => r.includes('app.ts'))).toBe(true);
    // Non-matching files should be filtered out.
    expect(rows.every((r) => !r.includes('readme.md'))).toBe(true);
    expect(rows.every((r) => !r.includes('config.ts'))).toBe(true);
  });

  it('search filter ranks exact basename match above prefix match', () => {
    const searchTree: TreeNode[] = [
      { name: 'app.ts', path: '/proj/app.ts', type: 'file' },
      {
        name: 'src',
        path: '/proj/src',
        type: 'directory',
        children: [{ name: 'app-helper.ts', path: '/proj/src/app-helper.ts', type: 'file' }],
      },
    ];
    useFileStore.getState().setTree('/proj', searchTree);

    render(<FileExplorer />);

    const input = screen.getByLabelText('Search files');
    fireEvent.change(input, { target: { value: 'app' } });

    // Both files match "app" as a basename prefix (score 60), but
    // /proj/app.ts is penalized less (depth 1) than
    // /proj/src/app-helper.ts (depth 2), so it ranks first.
    const rows = screen.getAllByRole('treeitem').map((el) => el.textContent ?? '');
    const matching = rows.filter((r) => r.includes('app'));
    expect(matching[0]).toContain('app.ts');
    expect(matching.some((r) => r.includes('app-helper.ts'))).toBe(true);
  });

  it('search filter caps results at 200 entries', () => {
    // Build a tree with 250 files all matching "file", plus one directory
    // so the toolbar (and search input) renders.
    const files: TreeNode[] = [
      { name: 'src', path: '/proj/src', type: 'directory' },
    ];
    for (let i = 0; i < 250; i++) {
      files.push({
        name: `file-${i}.ts`,
        path: `/proj/file-${i}.ts`,
        type: 'file',
      });
    }
    useFileStore.getState().setTree('/proj', files);

    render(<FileExplorer />);

    const input = screen.getByLabelText('Search files');
    fireEvent.change(input, { target: { value: 'file' } });

    const rows = screen.getAllByRole('treeitem');
    expect(rows.length).toBe(200);
  });

  it('clearing the search restores the normal tree view', () => {
    const searchTree: TreeNode[] = [
      { name: 'alpha.ts', path: '/proj/alpha.ts', type: 'file' },
      { name: 'beta.ts', path: '/proj/beta.ts', type: 'file' },
      { name: 'src', path: '/proj/src', type: 'directory' },
    ];
    useFileStore.getState().setTree('/proj', searchTree);

    render(<FileExplorer />);

    // Filter to "alpha" — only alpha.ts visible.
    const input = screen.getByLabelText('Search files');
    fireEvent.change(input, { target: { value: 'alpha' } });
    expect(screen.queryByText('beta.ts')).toBeNull();
    expect(screen.getByText('alpha.ts')).toBeTruthy();

    // Clear the search — both files should be visible again.
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('alpha.ts')).toBeTruthy();
    expect(screen.getByText('beta.ts')).toBeTruthy();
  });

  it('search input has a clear button that resets the query', () => {
    useFileStore.getState().setTree('/proj', [
      { name: 'alpha.ts', path: '/proj/alpha.ts', type: 'file' },
      { name: 'src', path: '/proj/src', type: 'directory' },
    ]);

    render(<FileExplorer />);

    const input = screen.getByLabelText('Search files') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alpha' } });
    expect(input.value).toBe('alpha');

    // Click the clear (✕) button.
    const clearBtn = screen.getByLabelText('Clear');
    fireEvent.click(clearBtn);
    expect(input.value).toBe('');
  });

  it('renders git status badge and propagates modified status to parent directories', () => {
    useGitChangesStore.setState({
      files: [
        { path: 'src/app.ts', status: 'M', added: 5, deleted: 2, staged: false },
        { path: 'readme.md', status: 'A', added: 10, deleted: 0, staged: true },
      ],
    });

    render(<FileExplorer />);

    expect(screen.getByText('readme.md')).toBeTruthy();
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('M')).toBeTruthy();
  });
});
