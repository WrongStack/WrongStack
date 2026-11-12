import { describe, expect, it } from 'vitest';
import { currentTreeListing, rememberTreeListing, treeListingKey } from '../src/file-tree-cache';

describe('window file tree listing', () => {
  it('stands in for a read until a change event, its age or another filter says otherwise', () => {
    const key = treeListingKey('p1', 'D:/repo', false);
    const tree = [{ name: 'src', path: 'src', type: 'directory' }];
    const before = { at: 1 };
    expect(currentTreeListing(key, before, 0)).toBeUndefined();
    rememberTreeListing(key, tree, before, 1000);
    expect(currentTreeListing(key, before, 2000)).toBe(tree);
    expect(currentTreeListing(key, { at: 2 }, 2000), 'a newer change event').toBeUndefined();
    expect(currentTreeListing(key, before, 1000 + 10 * 60_000 + 1), 'too old').toBeUndefined();
    expect(currentTreeListing(treeListingKey('p1', 'D:/repo', true), before, 2000)).toBeUndefined();
    expect(
      currentTreeListing(treeListingKey('p2', 'D:/repo', false), before, 2000),
    ).toBeUndefined();
  });

  it('a listing read before any change event matches while none has arrived', () => {
    const key = treeListingKey('p3', 'D:/repo', false);
    rememberTreeListing(key, [], undefined, 0);
    expect(currentTreeListing(key, undefined, 10)).toEqual([]);
  });

  it('keeps only the most recently read listings', () => {
    for (let i = 0; i < 8; i++)
      rememberTreeListing(treeListingKey(`lru${i}`, 'r', false), i, null, 0);
    expect(currentTreeListing(treeListingKey('lru0', 'r', false), null, 1)).toBeUndefined();
    expect(currentTreeListing(treeListingKey('lru7', 'r', false), null, 1)).toBe(7);
  });
});
