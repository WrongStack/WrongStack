import { afterEach, describe, expect, it } from 'vitest';
import { useGitInfoStore } from '../../src/stores/git-info-store';

describe('git info store', () => {
  afterEach(() => {
    useGitInfoStore.setState({ info: null });
  });

  it('setInfo stores the git info object', () => {
    useGitInfoStore.getState().setInfo({
      branch: 'main',
      added: 5,
      deleted: 3,
      untracked: 2,
      behind: 0,
      ahead: 1,
      fetchedAt: 1_700_000_000_000,
    });
    const info = useGitInfoStore.getState().info;
    expect(info?.branch).toBe('main');
    expect(info?.ahead).toBe(1);
    expect(info?.behind).toBe(0);
  });

  it('clear resets info to null', () => {
    useGitInfoStore.getState().setInfo({
      branch: 'main',
      added: 0,
      deleted: 0,
      untracked: 0,
      behind: 0,
      ahead: 0,
      fetchedAt: 0,
    });
    useGitInfoStore.getState().clear();
    expect(useGitInfoStore.getState().info).toBeNull();
  });
});
