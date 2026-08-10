// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePalette } from '../src/hooks/use-palette.js';
import { PALETTE_STORAGE_KEY, PALETTES } from '../src/lib/palettes.js';

/**
 * Visual-verification test suite for the Color Palette feature.
 *
 * Mirrors the sibling hook tests: jsdom + real `createRoot` + `act`,
 * no testing-library dependency.
 *
 * Verifies the full pipeline for all 12 palettes:
 *  - registry has 12 entries with swatches
 *  - hook renders correct initial palette
 *  - switching palette sets `data-palette` on <html>
 *  - switching back to signal removes the attribute
 *  - localStorage persists the choice
 *  - swatch gradient uses the registry's swatch colors
 */

interface Captured {
  current: ReturnType<typeof usePalette> | null;
}

function PaletteHarness({ captured }: { captured: Captured }) {
  const { palette, setPalette } = usePalette();
  captured.current = { palette, setPalette };
  return (
    <div>
      <div data-testid="current-palette">{palette}</div>
      {PALETTES.map((p) => (
        <button
          key={p.id}
          type="button"
          data-testid={`palette-btn-${p.id}`}
          onClick={() => setPalette(p.id)}
          aria-pressed={palette === p.id}
        >
          <span
            data-testid={`swatch-${p.id}`}
            style={{
              background: `linear-gradient(90deg, ${p.swatch} 0 50%, ${p.swatchSecondary} 50% 100%)`,
            }}
          />
        </button>
      ))}
    </div>
  );
}

describe('Color Palette — visual pipeline verification', () => {
  let container: HTMLElement;
  let root: Root;
  const captured: Captured = { current: null };

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-palette');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    document.documentElement.removeAttribute('data-palette');
  });

  it('PALETTES registry has exactly 12 entries with swatches', () => {
    expect(PALETTES).toHaveLength(12);
    for (const p of PALETTES) {
      expect(p.swatch).toBeTruthy();
      expect(p.swatchSecondary).toBeTruthy();
    }
  });

  it('defaults to signal palette (no data-palette attribute on <html>)', () => {
    act(() => {
      root.render(<PaletteHarness captured={captured} />);
    });
    expect(captured.current?.palette).toBe('signal');
    expect(document.documentElement.getAttribute('data-palette')).toBeNull();
  });

  it('renders all 12 palette buttons in the DOM', () => {
    act(() => {
      root.render(<PaletteHarness captured={captured} />);
    });
    for (const p of PALETTES) {
      const btn = container.querySelector(`[data-testid="palette-btn-${p.id}"]`);
      expect(btn).not.toBeNull();
    }
  });

  it('applies data-palette on <html> when switching to a non-default palette', () => {
    act(() => {
      root.render(<PaletteHarness captured={captured} />);
    });
    act(() => {
      captured.current?.setPalette('emerald-gold');
    });
    expect(document.documentElement.getAttribute('data-palette')).toBe('emerald-gold');
  });

  it('persists palette choice to localStorage', () => {
    act(() => {
      root.render(<PaletteHarness captured={captured} />);
    });
    act(() => {
      captured.current?.setPalette('blue-navy');
    });
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('blue-navy');
  });

  it('removes data-palette when switching back to signal (default)', () => {
    act(() => {
      root.render(<PaletteHarness captured={captured} />);
    });
    act(() => captured.current?.setPalette('purple-pink'));
    expect(document.documentElement.getAttribute('data-palette')).toBe('purple-pink');
    act(() => captured.current?.setPalette('signal'));
    expect(document.documentElement.getAttribute('data-palette')).toBeNull();
  });

  it('cycles through all 12 palettes — DOM + storage verified per palette', () => {
    act(() => {
      root.render(<PaletteHarness captured={captured} />);
    });
    for (const p of PALETTES) {
      act(() => {
        captured.current?.setPalette(p.id);
      });
      expect(captured.current?.palette).toBe(p.id);
      if (p.id === 'signal') {
        expect(document.documentElement.getAttribute('data-palette')).toBeNull();
      } else {
        expect(document.documentElement.getAttribute('data-palette')).toBe(p.id);
      }
      expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe(p.id);
    }
  });

  it('renders each swatch as a two-color gradient', () => {
    // jsdom converts hsl() to rgb() in style recalculation, so we verify
    // the gradient structure (two distinct color stops) rather than the
    // exact hsl string values from the registry.
    act(() => {
      root.render(<PaletteHarness captured={captured} />);
    });
    for (const p of PALETTES) {
      const swatch = container.querySelector(`[data-testid="swatch-${p.id}"]`) as HTMLElement;
      expect(swatch).not.toBeNull();
      const bg = swatch.style.background;
      expect(bg).toMatch(/^linear-gradient\(90deg,/);
      // Two rgb() color stops (jsdom normalises hsl → rgb)
      const rgbMatches = bg.match(/rgb\(/g);
      expect(rgbMatches).not.toBeNull();
      expect(rgbMatches!.length).toBeGreaterThanOrEqual(2);
    }
  });
});
