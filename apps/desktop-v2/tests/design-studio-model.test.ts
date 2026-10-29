import { applyTokenOverrides } from '@wrongstack/core/design';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DesignThemePreview } from '../src/DesignThemePreview';
import {
  designColorValue,
  designOverrideConflict,
  designOverrideExpectation,
  designTheme,
  designTokens,
  designValuesMatch,
} from '../src/design-studio-model';

describe('Desktop project design themes', () => {
  it('renders the same scoped overrides as the canonical engine', () => {
    const tokens = {
      light: { bg: '#ffffff', primary: '#112233' },
      dark: { bg: '#000000', primary: '#223344' },
    };
    const overrides = {
      primary: '#334455',
      'light.primary': '#445566',
      'dark.bg': '#101010',
      'radius-md': '1rem',
    };
    const canonical = applyTokenOverrides(tokens, overrides);
    expect(designTheme(tokens.light, overrides, 'light')).toEqual(canonical.light);
    expect(designTheme(tokens.dark, overrides, 'dark')).toEqual(canonical.dark);
    expect(tokens.light.primary).toBe('#112233');
  });
  it('preserves unrelated edits while detecting a changed color baseline', () => {
    expect(
      designOverrideConflict(
        { 'light.primary': '#112233' },
        { 'light.primary': '#112233', 'dark.bg': '#000000' },
        { 'light.primary': '#223344' },
      ),
    ).toBe(false);
    expect(
      designOverrideConflict(
        { 'light.primary': '#112233' },
        { 'light.primary': '#334455' },
        { 'light.primary': '#223344' },
      ),
    ).toBe(true);
    expect(
      designOverrideConflict({}, { 'light.primary': '#223344' }, { 'light.primary': '#223344' }),
    ).toBe(false);
  });
  it('confirms only reported saved token values without dropping other overrides', () => {
    expect(designValuesMatch({ primary: '#112233', bg: '#000000' }, { primary: '#112233' })).toBe(
      true,
    );
    expect(designValuesMatch({}, { primary: '#112233' })).toBe(false);
    expect(designTokens({ bg: '#fff', numeric: 4, nested: { primary: '#111' } })).toEqual({
      bg: '#fff',
    });
  });
  it('allows literal palette colors and excludes token references from editable colors', () => {
    expect(designColorValue('#123abc')).toBe(true);
    expect(designColorValue('oklch(56% 0.16 264)')).toBe(true);
    expect(designColorValue('var(--arbitrary)')).toBe(false);
    expect(designColorValue('not-a-color')).toBe(false);
  });
  it('renders an isolated theme sample with actual shape, typography and palette values', () => {
    const markup = renderToStaticMarkup(
      createElement(DesignThemePreview, {
        tokens: {
          bg: '#112233',
          primary: '#445566',
          'radius-md': '1rem',
          'font-sans': 'Example Sans',
          'space-4': '2rem',
        },
        label: 'Dark',
      }),
    );
    expect(markup).toContain('Dark theme sample');
    expect(markup).toContain('THEME SAMPLE');
    expect(markup).toContain('--design-primary:#445566');
    expect(markup).toContain('--design-radius:1rem');
    expect(markup).toContain('--design-space:2rem');
    expect(markup).not.toContain('<main>');
    expect(markup).not.toContain('[object Object]');
  });
});
it('expects the values just read for exactly the keys being written', () => {
  expect(
    designOverrideExpectation(
      'soft-glass',
      { primary: '#111111', accent: '#222222' },
      {
        primary: '#333333',
        border: '#444444',
      },
    ),
  ).toEqual({ kit: 'soft-glass', values: { primary: '#111111', border: '' } });
});
