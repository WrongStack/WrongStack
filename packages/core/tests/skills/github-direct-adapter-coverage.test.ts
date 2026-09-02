/**
 * Coverage for core/src/skills/registry/github-direct-adapter.ts
 */
import { describe, expect, it } from 'vitest';
import { githubDirectAdapter } from '../../src/skills/registry/github-direct-adapter.js';

describe('githubDirectAdapter', () => {
  it('has correct id', () => {
    expect(githubDirectAdapter.id).toBe('github');
  });

  it('has correct displayName', () => {
    expect(githubDirectAdapter.displayName).toBe('GitHub (direct)');
  });

  it('search returns empty results', async () => {
    const result = await githubDirectAdapter.search('test');
    expect(result.adapterId).toBe('github');
    expect(result.results).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('search with options also returns empty', async () => {
    const result = await githubDirectAdapter.search('anything', { pageSize: 5 });
    expect(result.results).toEqual([]);
  });

  it('resolveInstallRef returns trimmed ref when it contains slash', () => {
    expect(githubDirectAdapter.resolveInstallRef('  user/repo  ')).toBe('user/repo');
  });

  it('resolveInstallRef returns ref without slash as-is (deferred to parser)', () => {
    expect(githubDirectAdapter.resolveInstallRef('noslash')).toBe('noslash');
  });

  it('resolveInstallRef trims whitespace', () => {
    expect(githubDirectAdapter.resolveInstallRef('  user/repo@main  ')).toBe('user/repo@main');
  });

  it('resolveInstallRef handles empty string', () => {
    expect(githubDirectAdapter.resolveInstallRef('')).toBe('');
  });

  it('resolveInstallRef handles whitespace-only string', () => {
    expect(githubDirectAdapter.resolveInstallRef('   ')).toBe('');
  });

  it('resolveInstallRef preserves complex refs with @', () => {
    expect(githubDirectAdapter.resolveInstallRef('owner/repo@feature-branch')).toBe(
      'owner/repo@feature-branch',
    );
  });
});
