import { afterEach, describe, expect, it } from 'vitest';
import { useGitChangesStore } from '../../src/stores/git-changes-store';

const FILE = { path: 'a/b.ts', status: 'M', added: 3, deleted: 1, staged: false };

describe('git changes store', () => {
  afterEach(() => {
    useGitChangesStore.getState().clear();
    useGitChangesStore.setState({ gitChangesSessionId: null, gitChangesBySession: {} });
  });

  it('setFiles stores the list, clears the error and stops the spinner', () => {
    useGitChangesStore.getState().setListLoading(true);
    useGitChangesStore.getState().setFiles([FILE], null);
    const s = useGitChangesStore.getState();
    expect(s.files).toEqual([FILE]);
    expect(s.error).toBeNull();
    expect(s.loadingList).toBe(false);
  });

  it('setFiles propagates an error string (e.g. not a repo)', () => {
    useGitChangesStore.getState().setFiles([], 'not a git repo');
    expect(useGitChangesStore.getState().error).toBe('not a git repo');
  });

  it('select sets the path, clears the prior diff, and arms the diff spinner', () => {
    useGitChangesStore.getState().setDiff({ path: 'old', oldText: 'x', newText: 'y' });
    useGitChangesStore.getState().select('a/b.ts');
    const s = useGitChangesStore.getState();
    expect(s.selectedPath).toBe('a/b.ts');
    expect(s.diff).toBeNull();
    expect(s.loadingDiff).toBe(true);
  });

  it('select(null) clears the selection without arming the spinner', () => {
    useGitChangesStore.getState().select('a/b.ts');
    useGitChangesStore.getState().select(null);
    const s = useGitChangesStore.getState();
    expect(s.selectedPath).toBeNull();
    expect(s.loadingDiff).toBe(false);
  });

  it('setDiff stores content and stops the diff spinner', () => {
    useGitChangesStore.getState().select('a/b.ts');
    useGitChangesStore.getState().setDiff({ path: 'a/b.ts', oldText: 'o', newText: 'n' });
    const s = useGitChangesStore.getState();
    expect(s.diff?.newText).toBe('n');
    expect(s.loadingDiff).toBe(false);
  });

  it('setDiffLoading toggles the spinner independently', () => {
    useGitChangesStore.getState().setDiffLoading(true);
    expect(useGitChangesStore.getState().loadingDiff).toBe(true);
    useGitChangesStore.getState().setDiffLoading(false);
    expect(useGitChangesStore.getState().loadingDiff).toBe(false);
  });

  it('clear resets every field', () => {
    useGitChangesStore.getState().setFiles([FILE], 'err');
    useGitChangesStore.getState().select('a/b.ts');
    useGitChangesStore.getState().setDiff({ path: 'a/b.ts', oldText: 'o', newText: 'n' });
    useGitChangesStore.getState().clear();
    const s = useGitChangesStore.getState();
    expect(s.files).toEqual([]);
    expect(s.error).toBeNull();
    expect(s.selectedPath).toBeNull();
    expect(s.diff).toBeNull();
    expect(s.loadingDiff).toBe(false);
  });

  it('keeps the selected diff per session while the file list stays global', () => {
    useGitChangesStore.getState().setFiles([FILE], null);
    useGitChangesStore.getState().bindSessionGitChanges('sess-a');
    useGitChangesStore.getState().select('a/b.ts');
    useGitChangesStore.getState().setDiff({ path: 'a/b.ts', oldText: 'a-old', newText: 'a-new' });

    useGitChangesStore.getState().bindSessionGitChanges('sess-b');
    expect(useGitChangesStore.getState()).toMatchObject({
      gitChangesSessionId: 'sess-b',
      files: [FILE],
      selectedPath: null,
      diff: null,
      loadingDiff: false,
    });

    useGitChangesStore.getState().select('c/d.ts');
    useGitChangesStore.getState().bindSessionGitChanges('sess-a');
    expect(useGitChangesStore.getState()).toMatchObject({
      gitChangesSessionId: 'sess-a',
      files: [FILE],
      selectedPath: 'a/b.ts',
      diff: { path: 'a/b.ts', newText: 'a-new' },
      loadingDiff: false,
    });

    useGitChangesStore.getState().bindSessionGitChanges('sess-b');
    expect(useGitChangesStore.getState()).toMatchObject({
      selectedPath: 'c/d.ts',
      diff: null,
      loadingDiff: true,
    });
  });
});
