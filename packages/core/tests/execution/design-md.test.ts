import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { captureProjectTokens } from '../../src/execution/design-capture.js';
import { summarizeDesignDna } from '../../src/execution/design-dna.js';
import { getDesignKitLoader } from '../../src/execution/design-kit-loader.js';
import {
  designMdToTokens,
  parseDesignMd,
  renderDesignMd,
  renderDesignMdFromDna,
  resolveDesignMdRef,
} from '../../src/execution/design-md.js';

/** Shaped after the google-labs-code/design.md spec example (alpha, 2026-10). */
const SPEC_LIKE = `---
version: alpha
name: Heritage
colors:
  primary: "#1A1C1E"
  secondary: "#6C7278"
  neutral: "#F7F5F2"
typography:
  h1:
    fontFamily: Public Sans
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: -0.02em
  body-md:
    fontFamily: Public Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: 4px
  md: 8px
spacing:
  base: 16px
  gutter: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.md}"
    padding: 12px
---

## Overview
Architectural minimalism.

## Colors
Ink and paper.
`;

const rules = (text: string) => parseDesignMd(text).issues.map((i) => `${i.severity} ${i.rule}`);

describe('parseDesignMd', () => {
  it('reads a spec-shaped file without issues', () => {
    const parsed = parseDesignMd(SPEC_LIKE);
    expect(parsed.issues).toEqual([]);
    expect(parsed.doc?.name).toBe('Heritage');
    expect(parsed.doc?.typography.h1).toMatchObject({ fontWeight: 600, lineHeight: 1.1 });
    expect(parsed.doc?.components['button-primary']?.rounded).toBe('{rounded.md}');
    expect(parsed.sections).toEqual(['Overview', 'Colors']);
  });

  it('rejects duplicate keys and duplicate sections, as the spec requires', () => {
    expect(rules(SPEC_LIKE.replace('name: Heritage', 'name: Heritage\nname: Again'))).toContain(
      'error duplicate-key',
    );
    expect(rules(`${SPEC_LIKE}\n## Colors\nAgain.\n`)).toContain('error duplicate-section');
  });

  it('warns on section order, accepting the spec aliases', () => {
    expect(rules(SPEC_LIKE.replace('## Overview', '## Shapes'))).toContain('warning section-order');
    expect(rules(SPEC_LIKE.replace('## Overview', '## Brand & Style'))).toEqual([]);
  });

  it('lints broken references, missing primary and component contrast', () => {
    expect(rules(SPEC_LIKE.replace('{colors.neutral}', '{colors.paper}'))).toContain(
      'error broken-ref',
    );
    expect(
      rules(
        SPEC_LIKE.replace('  primary: "#1A1C1E"', '  ink: "#1A1C1E"').replace(
          '{colors.primary}',
          '{colors.ink}',
        ),
      ),
    ).toContain('warning missing-primary');
    expect(rules(SPEC_LIKE.replace('"#F7F5F2"', '"#3A3C3E"'))).toContain('warning contrast-ratio');
  });

  it('reports a file without front matter', () => {
    expect(rules('# Just prose')).toEqual(['error front-matter']);
  });

  it('resolves chained token references and rejects circular or prototype references (F106)', () => {
    const parsed = parseDesignMd(`---
colors:
  primary: "#1A1C1E"
  brand: "{colors.primary}"
  cycleA: "{colors.cycleB}"
  cycleB: "{colors.cycleA}"
---
## Overview
`);
    expect(resolveDesignMdRef(parsed.doc!, '{colors.brand}')).toBe('#1A1C1E');
    expect(resolveDesignMdRef(parsed.doc!, '{colors.cycleA}')).toBeUndefined();
    expect(resolveDesignMdRef(parsed.doc!, '{colors.toString}')).toBeUndefined();
  });
});

describe('DESIGN.md round trip', () => {
  it('keeps both themes through dark-<role> colors', () => {
    const tokens = {
      light: { primary: 'oklch(56% 0.16 264)', bg: 'oklch(99% 0 0)', 'radius-md': '0.5rem' },
      dark: { primary: 'oklch(68% 0.15 264)', bg: 'oklch(18% 0.01 260)', 'radius-md': '0.5rem' },
    };
    const md = renderDesignMd({ name: 'Probe', tokens });
    const parsed = parseDesignMd(md);
    expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const back = designMdToTokens(parsed.doc!);
    expect(back.light).toMatchObject({
      primary: tokens.light.primary,
      bg: tokens.light.bg,
      'radius-md': '0.5rem',
    });
    expect(back.dark).toMatchObject({ primary: tokens.dark.primary, bg: tokens.dark.bg });
  });

  it('renders a real kit as a lint-clean, spec-ordered file', async () => {
    const tokens = await getDesignKitLoader(process.cwd()).readTokens('minimal-clarity');
    const md = renderDesignMd({ name: 'Minimal Clarity', tokens: tokens! });
    const parsed = parseDesignMd(md);
    expect(parsed.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(parsed.sections).toEqual([
      'Overview',
      'Colors',
      'Typography',
      'Layout',
      'Shapes',
      'Components',
    ]);
    expect(Object.keys(parsed.doc!.typography)).toEqual(
      expect.arrayContaining(['display', 'body-md']),
    );
  });
});

describe('capture from DESIGN.md', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('prefers a DESIGN.md over inferred CSS, and refuses a broken one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-md-'));
    dirs.push(root);
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'index.css'), ':root { --primary: #ff0000; }');
    await fs.writeFile(path.join(root, 'DESIGN.md'), SPEC_LIKE);
    const ok = await captureProjectTokens(root);
    expect(ok.files[0]).toBe('DESIGN.md');
    expect(ok.tokens.light?.secondary).toBe('#6C7278');

    await fs.writeFile(
      path.join(root, 'DESIGN.md'),
      SPEC_LIKE.replace('{colors.neutral}', '{colors.gone}'),
    );
    const broken = await captureProjectTokens(root);
    expect(broken.files).not.toContain('DESIGN.md');
    expect(broken.notes.join(' ')).toMatch(/DESIGN\.md: not used — \[broken-ref\]/);
  });
});

describe('renderDesignMdFromDna (designmd.me engine)', () => {
  it('generates the full 10-section designmd.me prompt specification and parses cleanly', () => {
    const dna = summarizeDesignDna(
      [
        {
          v: 1,
          url: 'https://stripe.com/',
          title: 'Stripe | Financial Infrastructure',
          vw: 1440,
          vh: 900,
          docH: 3600,
          screens: 4,
          rootBg: '#f6f9fc',
          colorScheme: 'light',
          themeColor: '#533afd',
          generator: null,
          samples: {
            points: 1000,
            media: 50,
            gradient: 120,
            area: [
              ['#f6f9fc', 650],
              ['#e5edf5', 200],
              ['#0a2540', 80],
              ['#533afd', 30],
            ],
          },
          text: [
            ['56|500|67.76|-1.12|sohne-var||h1', 45],
            ['38|500|47.88|-0.2|sohne-var||h2', 80],
            ['15|300|22.5|0|sohne-var||p', 1200],
            ['12|500|15|0.2|sohne-var|uppercase|span', 60],
          ],
          textColor: [
            ['#000000', 400],
            ['#3f4b66', 900],
            ['#4f5b76', 200],
          ],
          families: [['sohne-var', 1385]],
          fontsLoaded: ['sohne-var'],
          padding: [
            ['16', 20],
            ['24', 18],
            ['40', 8],
          ],
          gap: [['16', 10]],
          vmargin: [['24', 10]],
          radius: [
            ['4', 12],
            ['6', 8],
            ['8', 4],
          ],
          shadow: [
            ['rgba(50, 50, 93, 0.25) 0px 13px 27px -5px, rgba(0, 0, 0, 0.3) 0px 8px 16px -8px', 6],
          ],
          borderW: [['1', 8]],
          borderColor: [['#d8dbde', 8]],
          duration: [['200', 5]],
          easing: [['ease-out', 5]],
          gradients: [['radial-gradient', 2]],
          fullGradients: [
            {
              context: 'hero',
              kind: 'radial',
              value: 'radial-gradient(circle, rgb(127, 125, 252), rgb(244, 75, 204) 33%)',
            },
          ],
          effects: { animated: 2 },
          grids: [[4, 16, 4, 1248, 600]],
          buttons: [
            {
              h: 48,
              w: 148,
              padX: 24,
              pad: '15.5px 24px 16.5px 24px',
              r: 4,
              bg: '#533afd',
              fg: '#ffffff',
              border: null,
              fw: '400',
              fs: 16,
              lh: 1,
              ff: 'sohne-var',
              tt: 'none',
              y: 320,
            },
          ],
          cards: [
            {
              h: 220,
              w: 400,
              pad: '24px 24px 24px 24px',
              r: 6,
              bg: '#e5edf5',
              fg: '#000000',
              border: null,
              fw: '400',
              fs: 16,
              ff: 'sohne-var',
            },
          ],
          links: [
            {
              h: 20,
              w: 80,
              r: 0,
              bg: null,
              fg: '#0000ee',
              border: null,
              fw: '400',
              fs: 16,
              ff: 'sohne-var',
            },
          ],
          badges: [
            {
              h: 36,
              w: 150,
              pad: '7px 10px 7px 10px',
              r: 6,
              bg: '#ffffff',
              fg: '#0a2540',
              border: '#e5edf5',
              bw: 1,
              fw: '425',
              fs: 13,
              lh: 1.15,
              ff: 'sohne-var',
            },
          ],
          inputs: [],
          nav: {
            h: 64,
            w: 1262,
            pos: 'sticky',
            bg: null,
            fg: '#000000',
            pad: '10px 16px 10px 16px',
            r: 6,
            fs: 16,
            ff: 'sohne-var',
            fw: '400',
            backdrop: false,
            links: 4,
            linksVis: 4,
            menuToggle: false,
            buttons: 2,
          },
          footer: {
            h: 320,
            w: 1248,
            bg: '#f8fafd',
            fg: '#000000',
            pad: '0px 16px 0px 16px',
            fs: 16,
            ff: 'sohne-var',
            fw: '400',
          },
          sections: [
            {
              tag: 'section',
              y: 64,
              h: 600,
              bg: null,
              padY: [40, 40],
              padX: [16, 16],
              cols: 2,
              media: 'right',
              container: 1248,
              align: 'start',
              sticky: false,
            },
          ],
          states: {
            'button-hover': { target: 'button', state: 'hover', opacity: 0.6 },
          },
          statesFound: 14,
          sheetsBlocked: 1,
          images: 3,
          imgRatios: [],
          icons: [],
          vars: {},
          elements: 250,
        },
      ],
      '2026-11-08T00:00:00.000Z',
    );

    const md = renderDesignMdFromDna(dna);
    expect(md).toContain('# Design System Inspired by Stripe');
    expect(md).toContain('## 1. Visual Theme & Atmosphere');
    expect(md).toContain('## 2. Color Palette & Roles');
    expect(md).toContain('## 3. Typography Rules');
    expect(md).toContain('## 4. Component Stylings');
    expect(md).toContain('## 5. Layout Principles');
    expect(md).toContain('## 6. Depth & Elevation');
    expect(md).toContain("## 7. Do's and Don'ts");
    expect(md).toContain('## 8. Responsive Behavior');
    expect(md).toContain('## 9. Agent Prompt Guide');
    expect(md).toContain('## 10. Known Gaps');

    const parsed = parseDesignMd(md);
    expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(parsed.doc?.source).toMatchObject({
      url: 'https://stripe.com/',
      pagesAnalyzed: 1,
      extractedAt: '2026-11-08',
      tokensMeasured: true,
    });
    expect(parsed.doc?.colors.primary).toBe('#533AFD');
    expect(parsed.doc?.colors.canvas).toBe('#F6F9FC');
    expect(parsed.doc?.themes?.derived).toBe('dark');
    expect(parsed.doc?.gradients?.[0]).toMatchObject({ context: 'hero', kind: 'radial' });
    expect(parsed.doc?.coverage?.statesFound).toBe(14);

    // Verify designMdToTokens maps canvas->bg, ink->fg, themes, shadows, and typography roles
    const tokens = designMdToTokens(parsed.doc!);
    expect(tokens.light?.bg).toBe('#F6F9FC');
    expect(tokens.light?.fg).toBe('#000000');
    expect(tokens.light?.['on-primary']).toBe('#FFFFFF');
    expect(tokens.light?.ring).toBe('#533AFD');
    expect(tokens.dark?.bg).toBe('#0B0B14');
    expect(tokens.dark?.surface).toBe('#1A1A22');
    expect(tokens.dark?.raised).toBe('#26262E');
    expect(tokens.light?.['text-5xl']).toBe('56px');
    expect(tokens.light?.['text-3xl']).toBe('38px');
    expect(tokens.light?.['text-base']).toBe('15px');
    expect(tokens.light?.['text-xs']).toBe('12px');
    expect(Object.keys(tokens.light ?? {}).some((k) => k.startsWith('shadow-'))).toBe(true);
  });

  it('resolves {typography.*} component references without broken-ref errors', () => {
    const md = `---
version: alpha
name: Stripe
colors:
  primary: "#533AFD"
typography:
  body-sm-2:
    fontFamily: sohne-var
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1
rounded:
  sm: 4px
spacing:
  md: 16px
components:
  button-primary-sm:
    typography: "{typography.body-sm-2}"
    textColor: "rgb(255, 255, 255)"
    rounded: "{rounded.sm}"
    backgroundColor: "{colors.primary}"
---

## 1. Visual Theme & Atmosphere
Modern financial infrastructure.

## 2. Color Palette & Roles
Primary purple.

## 3. Typography Rules
Sohne variable.

## 4. Component Stylings
Buttons and cards.

## 5. Layout Principles
8px scale.
`;
    const parsed = parseDesignMd(md);
    expect(parsed.issues).toEqual([]);
    expect(resolveDesignMdRef(parsed.doc!, '{typography.body-sm-2}')).toContain('sohne-var');
  });

  it('preserves explicit themes.light and dark base colors when round-tripping dark-first DESIGN.md (F179)', () => {
    const darkDna = summarizeDesignDna([
      {
        v: 1,
        url: 'https://linear.example/',
        title: 'Linear',
        vw: 1440,
        vh: 900,
        docH: 1800,
        screens: 2,
        rootBg: '#08090a',
        colorScheme: 'dark',
        themeColor: '#5e6ad2',
        generator: null,
        samples: {
          points: 1000,
          media: 0,
          gradient: 0,
          area: [
            ['#08090a', 700],
            ['#141517', 250],
            ['#5e6ad2', 50],
          ],
        },
        text: [['16|400|24|0|Inter||p', 800]],
        textColor: [
          ['#f8f7ff', 600],
          ['#8a8f98', 300],
        ],
        families: [['Inter', 900]],
        fontsLoaded: ['Inter'],
        padding: [['16', 10]],
        gap: [['12', 6]],
        vmargin: [['24', 6]],
        radius: [['8', 8]],
        shadow: [],
        borderW: [['1', 6]],
        borderColor: [['#2c2e33', 6]],
        duration: [['150', 4]],
        easing: [['ease-out', 4]],
        gradients: [],
        effects: {},
        grids: [],
        buttons: [
          {
            h: 40,
            w: 120,
            padX: 16,
            r: 8,
            bg: '#5e6ad2',
            fg: '#ffffff',
            border: null,
            fw: '500',
            fs: 14,
            tt: 'none',
            y: 200,
          },
        ],
        inputs: [],
        nav: null,
        sections: [],
        images: 0,
        imgRatios: [],
        icons: [],
        vars: {},
        elements: 60,
      },
    ]);

    const parsed = parseDesignMd(renderDesignMdFromDna(darkDna));
    const tokens = designMdToTokens(parsed.doc!);
    expect(tokens.light?.bg).toBe('#F6F9FC');
    expect(tokens.light?.surface).toBe('#E5EDF5');
    expect(tokens.light?.fg).toBe('#000000');
    expect(tokens.dark?.bg).toBe('#08090A');
    expect(tokens.dark?.surface).toBe('#141517');
    expect(tokens.dark?.fg).toBe('#F8F7FF');
  });
});
