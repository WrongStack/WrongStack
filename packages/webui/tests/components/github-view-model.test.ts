import type { GitHubIssueSummary, GitHubPullSummary } from '@wrongstack/webui-protocol';
import { describe, expect, it } from 'vitest';
import {
  agentPrompt,
  anchorKey,
  checkTone,
  filterGitHubItems,
  labelColor,
  numberPatch,
  pullIntents,
  relativeGitHubTime,
  rowAnchor,
  safeGitHubUrl,
} from '../../src/components/GitHubView/github-view-model';

const base = {
  url: 'https://github.com/o/r/issues/1',
  comments: 0,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};
const issue: GitHubIssueSummary = {
  ...base,
  number: 41,
  title: 'Crash on Start',
  author: 'alice',
  labels: [{ name: 'bug', color: 'd73a4a' }],
};
const pull: GitHubPullSummary = {
  ...base,
  number: 42,
  title: 'Add view',
  author: null,
  labels: [],
  draft: false,
  headRef: 'feat/github-view',
  baseRef: 'main',
};

describe('filterGitHubItems', () => {
  const items = [issue, pull];
  it.each([
    ['', [41, 42]],
    ['crash', [41]],
    ['ALICE', [41]],
    ['bug', [41]],
    ['#42', [42]],
    ['github-view', [42]],
    ['nothing', []],
  ])('matches %j', (query, expected) => {
    expect(filterGitHubItems(items, query).map((item) => item.number)).toEqual(expected);
  });
});

describe('relativeGitHubTime', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  it('words the distance in the UI language', () => {
    expect(relativeGitHubTime('2026-11-27T09:00:00Z', 'en', now)).toBe('3 hours ago');
    expect(relativeGitHubTime('2026-11-26T12:00:00Z', 'en', now)).toBe('yesterday');
    expect(relativeGitHubTime('2026-11-27T11:59:50Z', 'en', now)).toBe('this minute');
  });
  it('returns a non-date unchanged', () => {
    expect(relativeGitHubTime('soon', 'en', now)).toBe('soon');
  });
});

describe('link and colour guards', () => {
  it('only links github.com', () => {
    expect(safeGitHubUrl('https://github.com/o/r/pull/1')).toBe('https://github.com/o/r/pull/1');
    expect(safeGitHubUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeGitHubUrl('https://github.com.evil.example/x')).toBeUndefined();
  });
  it('only accepts six-digit hex label colours', () => {
    expect(labelColor('0e8a16')).toBe('#0e8a16');
    expect(labelColor('red;x:y')).toBeUndefined();
  });
});

describe('agent hand-off', () => {
  it.each(['review', 'checkout', 'fix-checks', 'address-review', 'issue'] as const)(
    '%s names only the repository and number, and marks the content untrusted',
    (intent) => {
      const prompt = agentPrompt(intent, 'octo/repo', 12);
      expect(prompt).toContain('#12 in octo/repo');
      expect(prompt).toContain('--repo octo/repo');
      expect(prompt).toContain('untrusted input');
    },
  );

  it('never offers to run a fork or a merged branch', () => {
    const failing = {
      checks: [{ conclusion: 'failure' }],
      reviews: [{ state: 'CHANGES_REQUESTED' }],
    };
    expect(pullIntents({ ...failing, fromFork: false, merged: false })).toEqual([
      'review',
      'checkout',
      'fix-checks',
      'address-review',
    ]);
    expect(pullIntents({ ...failing, fromFork: true, merged: false })).toEqual(['review']);
    expect(pullIntents({ ...failing, fromFork: false, merged: true })).toEqual(['review']);
    expect(pullIntents({ checks: null, reviews: null, fromFork: false, merged: false })).toEqual([
      'review',
      'checkout',
    ]);
  });

  it.each([
    [{ status: 'completed', conclusion: 'success' }, 'pass'],
    [{ status: 'completed', conclusion: 'failure' }, 'fail'],
    [{ status: 'completed', conclusion: 'timed_out' }, 'fail'],
    [{ status: 'completed', conclusion: 'skipped' }, 'neutral'],
    [{ status: 'in_progress', conclusion: null }, 'pending'],
  ] as const)('%j reads as %s', (check, tone) => {
    expect(checkTone(check)).toBe(tone);
  });
});

describe('numberPatch', () => {
  it('numbers each hunk from its own header', () => {
    const rows = numberPatch('@@ -10,3 +20,3 @@ fn\n a\n-b\n+B\n c\n@@ -50,1 +60,2 @@\n x\n+y');
    expect(rows.map((row) => [row.kind, row.oldLine ?? null, row.newLine ?? null])).toEqual([
      ['meta', null, null],
      ['ctx', 10, 20],
      ['del', 11, null],
      ['add', null, 21],
      ['ctx', 12, 22],
      ['meta', null, null],
      ['ctx', 50, 60],
      ['add', null, 61],
    ]);
    expect(rows.map(rowAnchor).map((anchor) => (anchor ? anchorKey(anchor) : null))).toEqual([
      null,
      'RIGHT:20',
      'LEFT:11',
      'RIGHT:21',
      'RIGHT:22',
      null,
      'RIGHT:60',
      'RIGHT:61',
    ]);
  });
});

describe('checkout hand-off', () => {
  it('asks the agent to stop on a dirty or shared checkout', () => {
    const prompt = agentPrompt('checkout', 'octo/repo', 12);
    expect(prompt).toContain('gh pr checkout 12 --repo octo/repo');
    expect(prompt).toContain('git status');
    expect(prompt).toContain('stop and ask me');
  });
});
