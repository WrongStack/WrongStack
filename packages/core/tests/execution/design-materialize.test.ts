import { describe, expect, it } from 'vitest';
import { materializeTokens } from '../../src/execution/design-materialize';
import type { DesignKitTokens } from '../../src/types/design-kit';

const tokens: DesignKitTokens = {
  light: {
    bg: 'oklch(100% 0 0)',
    fg: 'oklch(0% 0 0)',
    primary: 'oklch(62.79% 0.2577 29.23)', // sRGB red
    radius: '0.5rem',
    fontSans: 'Inter, sans-serif',
  },
  dark: {
    bg: 'oklch(0% 0 0)',
    fg: 'oklch(100% 0 0)',
    primary: 'oklch(62.79% 0.2577 29.23)',
    radius: '0.5rem',
    fontSans: 'Inter, sans-serif',
  },
};

describe('materializeTokens', () => {
  it('web → CSS vars + @theme inline, keeps OKLCH verbatim', () => {
    const r = materializeTokens({ tokens, stack: 'web', kitId: 'test' });
    expect(r.path).toMatch(/\.css$/);
    expect(r.content).toContain(':root {');
    expect(r.content).toContain('.dark {');
    expect(r.content).toContain('@theme inline');
    expect(r.content).toContain('--primary: oklch(62.79% 0.2577 29.23);');
    expect(r.content).toContain('--color-primary: var(--primary);');
    // non-color token preserved as a var
    expect(r.content).toContain('--radius: 0.5rem;');
  });

  it('react-native → TS theme with hex colors', () => {
    const r = materializeTokens({ tokens, stack: 'react-native', kitId: 'test' });
    expect(r.path).toMatch(/\.ts$/);
    expect(r.content).toContain('export const lightTheme');
    expect(r.content).toContain('"primary": "#ff0000"');
    // non-color kept verbatim
    expect(r.content).toContain('"fontSans": "Inter, sans-serif"');
  });

  it('flutter → Dart Color(0xAARRGGBB)', () => {
    const r = materializeTokens({ tokens, stack: 'flutter', kitId: 'test' });
    expect(r.path).toMatch(/\.dart$/);
    expect(r.content).toContain('class AppColorsLight');
    expect(r.content).toContain('Color(0xFFFF0000)');
  });

  it('swiftui → Color(red:green:blue:)', () => {
    const r = materializeTokens({ tokens, stack: 'swiftui', kitId: 'test' });
    expect(r.path).toMatch(/\.swift$/);
    expect(r.content).toContain('import SwiftUI');
    expect(r.content).toMatch(/static let primary = Color\(red: 1\.0000, green: 0\.0000, blue: 0\.0000/);
  });

  it('compose → Color(0xAARRGGBB)', () => {
    const r = materializeTokens({ tokens, stack: 'compose', kitId: 'test' });
    expect(r.path).toMatch(/\.kt$/);
    expect(r.content).toContain('import androidx.compose.ui.graphics.Color');
    expect(r.content).toContain('Color(0xFFFF0000)');
  });

  it('honors a custom outPath', () => {
    const r = materializeTokens({ tokens, stack: 'web', kitId: 'test', outPath: 'a/b/theme.css' });
    expect(r.path).toBe('a/b/theme.css');
  });
});
