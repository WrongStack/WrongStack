// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseAppearance } from '../src/appearance';
import {
  applyStatusAppearance,
  parseStatusAppearance,
  toggleStatusChip,
} from '../src/appearance-status';

describe('status bar chips', () => {
  it('keeps known hidden chips once each, in the bar order', () => {
    expect(parseStatusAppearance({ statusHidden: ['cost', 'bogus', 'git', 'cost', 3] })).toEqual({
      statusHidden: ['git', 'cost'],
    });
    expect(parseStatusAppearance({ statusHidden: [] })).toEqual({});
    expect(parseStatusAppearance({ statusHidden: 'git' })).toEqual({});
    expect(parseAppearance(JSON.stringify({ statusHidden: ['tokens'] }))).toMatchObject({
      statusHidden: ['tokens'],
    });
  });

  it('toggles a chip and forgets the list once everything shows', () => {
    expect(toggleStatusChip(undefined, 'git', false)).toEqual(['git']);
    expect(toggleStatusChip(['git'], 'cache', false)).toEqual(['cache', 'git']);
    expect(toggleStatusChip(['git'], 'git', true)).toBeUndefined();
  });

  it('marks hidden chips on the document for the stylesheet', () => {
    const root = document.documentElement;
    applyStatusAppearance(root, { statusHidden: ['cache', 'cost'] });
    expect(root.dataset['statusHidden']).toBe('cache cost');
    applyStatusAppearance(root, {});
    expect(root.dataset['statusHidden']).toBeUndefined();
  });
});
