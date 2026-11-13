import { describe, expect, it } from 'vitest';
import {
  DefaultDesignKitLoader,
  resolveBundledDesignKitsDir,
} from '../../src/execution/design-kit-loader.js';
import {
  compilePhotoTreatmentCss,
  formatKitAxesTriple,
  inferKitAxesFromTokens,
  parseKitAxesFrontmatter,
  validateKitMaterial,
} from '../../src/execution/design-material.js';
import { materializeTokens } from '../../src/execution/design-materialize.js';

function bundledLoader(): DefaultDesignKitLoader {
  const bundledDir = resolveBundledDesignKitsDir();
  expect(bundledDir, 'bundled design-kits dir should resolve').toBeTruthy();
  return new DefaultDesignKitLoader({
    inProjectDir: '/nonexistent/project/.wrongstack/design-kits',
    globalDir: '/nonexistent/global/design-kits',
    bundledDir,
  });
}

describe('design-material — axes, photo treatment, and mechanical kit validator', () => {
  it('parses shorthand triple and split axis fields', () => {
    expect(parseKitAxesFrontmatter({ axes: 'light/roman-serif/warm' })).toEqual({
      paper: 'light',
      display: 'roman-serif',
      accent: 'warm',
    });
    expect(
      parseKitAxesFrontmatter({
        paper: 'dark 16 250',
        display: 'mono JetBrains Mono',
        accent: 'chromatic-green 145',
      }),
    ).toEqual({
      paper: 'dark',
      display: 'mono',
      accent: 'chromatic-green',
      paperL: 16,
      paperHue: 250,
      displayFace: 'JetBrains Mono',
      accentHue: 145,
    });
    expect(parseKitAxesFrontmatter({ axes: 'invalid/roman-serif/warm' })).toBeUndefined();
  });

  it('infers 3D visual coordinates from tokens when frontmatter omits axes', () => {
    const inferred = inferKitAxesFromTokens({
      light: {
        bg: 'oklch(97% 0.02 80)',
        primary: 'oklch(52% 0.16 36)',
        'font-display': "'Fraunces', Georgia, serif",
      },
      dark: {
        bg: 'oklch(14% 0.015 65)',
        primary: 'oklch(72% 0.15 42)',
      },
    });
    expect(inferred).toBeDefined();
    expect(inferred?.paper).toBe('light');
    expect(inferred?.display).toBe('roman-serif');
    expect(formatKitAxesTriple(inferred!)).toBe('light/roman-serif/warm');
  });

  it('compiles [data-slot] photo treatments including duotone OKLab mix and filter chains', () => {
    const riso = compilePhotoTreatmentCss('duotone fg surface con=18');
    expect(riso.errors).toEqual([]);
    expect(riso.css).toContain('[data-slot]:has(> img)');
    expect(riso.css).toContain('[data-slot] > img');
    expect(riso.css).toContain('grayscale(1) contrast(1.18)');
    expect(riso.css).toContain('mix-blend-mode: multiply;');
    expect(riso.css).toContain('mix-blend-mode: lighten;');

    const tint = compilePhotoTreatmentCss('tint accent exp=-8');
    expect(tint.errors).toEqual([]);
    expect(tint.css).toContain('color-mix(in oklab, var(--accent)');
    expect(tint.filter).toContain('brightness(0.92)');
  });

  it('emits font links and compiled photo CSS during web materializeTokens', async () => {
    const loader = bundledLoader();
    const riso = await loader.find('riso');
    const tokens = await loader.readTokens('riso');
    expect(riso).toBeDefined();
    expect(tokens).toBeDefined();

    const out = materializeTokens({
      tokens: tokens!,
      stack: 'web',
      kitId: 'riso',
      photo: riso?.photo,
      fontLinks: riso?.fontLinks,
      darkPaper: riso?.axes?.paper === 'dark',
    });
    expect(out.content).toContain('fonts.googleapis.com');
    expect(out.content).toContain('[data-slot]:has(> img)');
    expect(out.content).toContain('mix-blend-mode: lighten;');
  });

  it('validates all 61 bundled kits (including the 8 Hallmark-adapted Material kits) with zero errors', async () => {
    const loader = bundledLoader();
    const entries = await loader.listEntries();
    expect(entries.length).toBeGreaterThanOrEqual(61);

    const flagshipIds = [
      'atelier',
      'cobalt',
      'riso',
      'dusk',
      'kiln',
      'almanac',
      'terrazzo',
      'vellum',
    ];
    for (const id of flagshipIds) {
      const m = await loader.find(id);
      expect(m, `flagship kit ${id} must exist`).toBeDefined();
      expect(m?.axes, `${id} must declare axes`).toBeDefined();
      expect(m?.posture, `${id} must declare posture`).toBeDefined();
      expect(m?.material, `${id} must declare material`).toBeTruthy();
      expect(m?.photo, `${id} must declare photo treatment`).toBeTruthy();
      expect(m?.stacks).toHaveLength(5);
    }

    for (const entry of entries) {
      const manifest = await loader.find(entry.id);
      const tokens = await loader.readTokens(entry.id);
      const body = await loader.readBody(entry.id);
      expect(manifest).toBeDefined();
      expect(tokens).toBeDefined();
      expect(entry.axes, `${entry.id} entry should expose 3D axes`).toBeDefined();
      const issues = validateKitMaterial(manifest!, tokens!, body);
      const errors = issues.filter((i) => i.severity === 'error');
      expect(errors, `${entry.id} material validation errors`).toEqual([]);
    }
  });
});
