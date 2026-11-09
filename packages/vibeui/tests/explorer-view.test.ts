import { describe, expect, it } from 'vitest';
import { fileGroup, filterResources, memoryKindLabel } from '../src/lib/explorer-view';

describe('file discovery', () => {
  it.each([
    ['notes/PLAN.MD', 'documents'],
    ['README', 'documents'],
    ['D:\\project\\cover.JPG', 'images'],
    ['assets/icon.svg', 'images'],
    ['src/main.tsx', 'code'],
    ['.env.local', 'code'],
    ['bun.lock', 'code'],
    ['Dockerfile', 'code'],
    ['backup.zip', 'other'],
    ['', 'other'],
  ])('classifies %s as %s', (path, category) => {
    expect(fileGroup(path)).toBe(category);
  });
});
it('combines library search, categories and favorites without mutating the catalog', () => {
  const items = [
    { title: 'Review interface', category: 'design', favorite: true },
    { title: 'Review code', category: 'quality', favorite: true },
    { title: 'Make an interface', category: 'design', favorite: false },
  ];
  expect(filterResources(items, 'INTERFACE', 'design', true)).toEqual([items[0]]);
  expect(filterResources(items, '', '', true)).toEqual(items.slice(0, 2));
  expect(filterResources(items, 'no matches', '', false)).toEqual([]);
  expect(filterResources(items, '', 'absent', false)).toEqual([]);
  expect(items).toHaveLength(3);
});
it('gives memory types readable labels and preserves unknown server kinds', () => {
  expect(memoryKindLabel('bug_root_cause')).toBe('Solved issue');
  expect(memoryKindLabel('custom_kind')).toBe('custom kind');
  expect(memoryKindLabel(undefined)).toBe('Knowledge');
  expect(memoryKindLabel('toString')).toBe('toString');
  expect(memoryKindLabel('___')).toBe('Knowledge');
});
