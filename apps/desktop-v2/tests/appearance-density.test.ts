// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyAppearance, defaultAppearance, parseAppearance } from '../src/appearance';

describe('conversation density', () => {
  it('keeps compact density and drops anything else', () => {
    expect(parseAppearance('{"mode":"dark","density":"compact"}')).toMatchObject({
      mode: 'dark',
      density: 'compact',
    });
    expect(parseAppearance('{"mode":"dark","density":"loose"}')).not.toHaveProperty('density');
    expect(parseAppearance(null)).not.toHaveProperty('density');
  });

  it('marks the document so the compact rules apply, and clears it again', () => {
    applyAppearance({ ...defaultAppearance, density: 'compact' }, false);
    expect(document.documentElement.dataset['density']).toBe('compact');
    applyAppearance(defaultAppearance, false);
    expect(document.documentElement.dataset['density']).toBeUndefined();
  });
});
