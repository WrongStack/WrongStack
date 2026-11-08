// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseAppearance } from '../src/appearance';
import {
  applyFontAppearance,
  codeFontStack,
  currentCodeFont,
  DEFAULT_CODE_STACK,
  fontFamilyName,
  parseFontAppearance,
  stepTextSize,
  subscribeCodeFont,
  textSizeStep,
  textZoom,
  uiFontStack,
} from '../src/appearance-fonts';

describe('appearance typography', () => {
  it('keeps only valid typography from a stored appearance', () => {
    expect(
      parseFontAppearance({
        uiFont: 'system',
        codeFont: 'custom',
        codeFontFamily: '  JetBrains   Mono ',
        uiFontFamily: 'Evil", serif; x',
        textSize: 125,
        ligatures: 'off',
      }),
    ).toEqual({
      uiFont: 'system',
      codeFont: 'custom',
      codeFontFamily: 'JetBrains Mono',
      textSize: 125,
      ligatures: 'off',
    });
    expect(
      parseFontAppearance({ uiFont: 'comic', codeFont: 1, textSize: 300, ligatures: 'on' }),
    ).toEqual({});
    expect(parseAppearance(JSON.stringify({ mode: 'dark', codeFont: 'consolas' }))).toMatchObject({
      mode: 'dark',
      codeFont: 'consolas',
    });
  });

  it('accepts plain font names only', () => {
    expect(fontFamilyName('Fira Code')).toBe('Fira Code');
    expect(fontFamilyName('Source Code Pro 2.0')).toBe('Source Code Pro 2.0');
    expect(fontFamilyName('Noto Sans Türkçe')).toBe('Noto Sans Türkçe');
    for (const bad of ['', ' ', '"Quoted"', 'a;b', 'url(x)', 'x'.repeat(65), 7])
      expect(fontFamilyName(bad)).toBeUndefined();
  });

  it('builds stacks that keep the defaults behind a chosen font', () => {
    expect(uiFontStack({})).toBeNull();
    expect(codeFontStack({})).toBeNull();
    expect(uiFontStack({ uiFont: 'system' })).toContain('Segoe UI');
    expect(codeFontStack({ codeFont: 'custom', codeFontFamily: 'Fira Code' })).toBe(
      `"Fira Code", ${DEFAULT_CODE_STACK}`,
    );
    // A custom choice without a usable name keeps the default.
    expect(codeFontStack({ codeFont: 'custom' })).toBeNull();
    expect(textZoom({})).toBe(1);
    expect(textZoom({ textSize: 110 })).toBe(1.1);
  });

  it('offers sizes large enough for a 4K screen and steps through them with the zoom keys', () => {
    expect(parseFontAppearance({ textSize: 200 })).toEqual({ textSize: 200 });
    expect(textZoom({ textSize: 175 })).toBe(1.75);
    // 90 → 100 (unset) → 110 → … → 200, clamped at both ends; 0 resets.
    expect(stepTextSize(undefined, 1)).toBe(110);
    expect(stepTextSize(125, 1)).toBe(150);
    expect(stepTextSize(200, 1)).toBe(200);
    expect(stepTextSize(110, -1)).toBeUndefined();
    expect(stepTextSize(undefined, -1)).toBe(90);
    expect(stepTextSize(90, -1)).toBe(90);
    expect(stepTextSize(175, 0)).toBeUndefined();
    expect(textSizeStep('=')).toBe(1);
    expect(textSizeStep('+')).toBe(1);
    expect(textSizeStep('-')).toBe(-1);
    expect(textSizeStep('0')).toBe(0);
    expect(textSizeStep('a')).toBeNull();
  });

  it('writes the choice onto the document and tells the editors', () => {
    const root = document.documentElement;
    let changes = 0;
    const stop = subscribeCodeFont(() => changes++);
    applyFontAppearance(root, {
      uiFont: 'custom',
      uiFontFamily: 'Inter',
      codeFont: 'consolas',
      textSize: 90,
      ligatures: 'off',
    });
    expect(root.style.getPropertyValue('--user-font-ui')).toContain('"Inter"');
    expect(root.style.getPropertyValue('--user-font-code')).toContain('Consolas');
    expect(root.dataset).toMatchObject({
      uiFont: 'custom',
      codeFont: 'consolas',
      ligatures: 'off',
      textSize: '90',
    });
    expect(currentCodeFont()).toEqual({
      family: codeFontStack({ codeFont: 'consolas' }),
      ligatures: false,
    });
    applyFontAppearance(root, {});
    expect(root.style.getPropertyValue('--user-font-ui')).toBe('');
    expect(root.style.getPropertyValue('--user-font-code')).toBe('');
    expect(root.dataset['uiFont']).toBeUndefined();
    expect(root.dataset['codeFont']).toBeUndefined();
    expect(root.dataset['ligatures']).toBeUndefined();
    expect(root.dataset['textSize']).toBeUndefined();
    expect(currentCodeFont()).toEqual({ family: null, ligatures: true });
    applyFontAppearance(root, {});
    stop();
    expect(changes).toBe(2);
  });
});
