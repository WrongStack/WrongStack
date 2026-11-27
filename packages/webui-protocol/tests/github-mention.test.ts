import { describe, expect, it } from 'vitest';
import {
  detectGitHubMention,
  insertGitHubMention,
  matchGitHubMentions,
} from '../src/github-mention.js';

const items = [
  {
    kind: 'pull' as const,
    number: 128,
    title: 'Add GitHub view',
    author: 'octocat',
    url: 'https://github.com/o/r/pull/128',
  },
  {
    kind: 'issue' as const,
    number: 12,
    title: 'Crash on start',
    author: 'alice',
    url: 'https://github.com/o/r/issues/12',
  },
  {
    kind: 'pull' as const,
    number: 1200,
    title: 'Speed up boot',
    author: null,
    url: 'https://github.com/o/r/pull/1200',
  },
];

describe('detectGitHubMention', () => {
  it.each([
    ['#', 1, { start: 0, end: 1, query: '' }],
    ['review #12', 10, { start: 7, end: 10, query: '12' }],
    ['see (#cra', 9, { start: 5, end: 9, query: 'cra' }],
    ['fix #12 now', 6, { start: 4, end: 7, query: '1' }],
  ])('finds the mention in %j at %i', (text, cursor, expected) => {
    expect(detectGitHubMention(text, cursor)).toEqual(expected);
  });

  it.each([
    ['color#12', 8],
    ['`#12`', 4],
    ['```\n#12', 7],
    ['!echo #12', 9],
    ['## heading', 2],
    ['#12/path', 3],
    ['# heading', 9],
  ])('ignores %j at %i', (text, cursor) => {
    expect(detectGitHubMention(text, cursor)).toBeNull();
  });
});

describe('matchGitHubMentions', () => {
  it('puts the exact number before longer numbers that start with it', () => {
    expect(matchGitHubMentions(items, '12').map((item) => item.number)).toEqual([12, 128, 1200]);
    expect(matchGitHubMentions(items, '128').map((item) => item.number)).toEqual([128]);
  });
  it('matches every dash-separated word in the title or author', () => {
    expect(matchGitHubMentions(items, 'github-view').map((item) => item.number)).toEqual([128]);
    expect(matchGitHubMentions(items, 'alice').map((item) => item.number)).toEqual([12]);
    expect(matchGitHubMentions(items, '').map((item) => item.number)).toEqual([128, 12, 1200]);
    expect(matchGitHubMentions(items, 'nothing')).toEqual([]);
  });
});

describe('insertGitHubMention', () => {
  it('replaces the #query with the URL and one space', () => {
    expect(
      insertGitHubMention(
        'review #12   please',
        { start: 7, end: 10, query: '12' },
        'https://github.com/o/r/issues/12',
      ),
    ).toEqual({ text: 'review https://github.com/o/r/issues/12 please', cursor: 40 });
  });
});
