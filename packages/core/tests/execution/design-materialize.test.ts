import { describe, expect, it } from 'vitest';
import { materializeTokens } from '../../src/execution/design-materialize.js';
import type { DesignKitTokens } from '../../src/types/design-kit.js';

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
    expect(r.content).toMatch(
      /static let primary = Color\(red: 1\.0000, green: 0\.0000, blue: 0\.0000/,
    );
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

const scaleTokens: DesignKitTokens = {
  light: {
    primary: 'oklch(62.79% 0.2577 29.23)',
    'radius-md': '0.5rem',
    'space-4': '1rem',
    'text-base': '1rem',
    'font-sans': 'Inter, sans-serif',
    'shadow-1': '0 1px 2px oklch(0% 0 0 / 0.06)',
    'duration-fast': '120ms',
  },
  dark: {
    primary: 'oklch(62.79% 0.2577 29.23)',
    'radius-md': '0.5rem',
    'space-4': '1rem',
    'text-base': '1rem',
    'font-sans': 'Inter, sans-serif',
    'shadow-1': '0 1px 2px oklch(0% 0 0 / 0.4)', // flips
    'duration-fast': '120ms',
  },
};

describe('materializeTokens — scale axes', () => {
  it('web → maps scales onto Tailwind v4 @theme namespaces + flips shadows', () => {
    const r = materializeTokens({ tokens: scaleTokens, stack: 'web', kitId: 'scale' });
    // Scale tokens are NOT in the raw :root loop (they drive @theme utilities).
    expect(r.content).toContain('@theme {');
    expect(r.content).toContain('--radius-md: 0.5rem;');
    expect(r.content).toContain('--spacing-4: 1rem;'); // space-* → --spacing-*
    expect(r.content).toContain('--text-base: 1rem;');
    expect(r.content).toContain('--font-sans: Inter, sans-serif;');
    // Shadow differs light/dark → a .dark override of the same @theme var.
    expect(r.content).toMatch(/\.dark \{\n\s*--shadow-1: 0 1px 2px oklch\(0% 0 0 \/ 0\.4\);/);
    // Colors still use the inline indirection.
    expect(r.content).toContain('--color-primary: var(--primary);');
  });

  it('react-native → numeric scale export (rem→px, ms)', () => {
    const r = materializeTokens({ tokens: scaleTokens, stack: 'react-native', kitId: 'scale' });
    expect(r.content).toContain('export const scale');
    expect(r.content).toContain('"radiusMd": 8'); // 0.5rem → 8px
    expect(r.content).toContain('"space4": 16');
    expect(r.content).toContain('"durationFast": 120');
    // Scale keys are not duplicated into the color theme object.
    expect(r.content).not.toContain('"radius-md"');
  });

  it('flutter/swiftui/compose → AppScale numeric constants', () => {
    const dart = materializeTokens({ tokens: scaleTokens, stack: 'flutter', kitId: 'scale' });
    expect(dart.content).toContain('class AppScale');
    expect(dart.content).toContain('static const double radiusMd = 8;');
    const swift = materializeTokens({ tokens: scaleTokens, stack: 'swiftui', kitId: 'scale' });
    expect(swift.content).toContain('static let radiusMd: CGFloat = 8');
    const kt = materializeTokens({ tokens: scaleTokens, stack: 'compose', kitId: 'scale' });
    expect(kt.content).toContain('val RadiusMd = 8f');
  });
});
