import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  type DesignDnaRaw,
  deltaE,
  hexToOklchString,
  summarizeDesignDna,
} from '../../src/execution/design-dna.js';
import {
  compareDesignDna,
  dnaToTokenOverrides,
  renderDesignDnaMarkdown,
} from '../../src/execution/design-dna-compare.js';
import { DESIGN_DNA_EXTRACTOR } from '../../src/execution/design-dna-extractor.js';

/**
 * A light page with a half-height dark band, a rose primary button, 12px
 * cards, 150ms ease-out transitions and a three-column grid that reflows to
 * one column — the shape the in-page extractor returned for the fixture
 * this module was proven on in a real Chromium.
 */
function raw(overrides: Partial<DesignDnaRaw> = {}): DesignDnaRaw {
  return {
    v: 1,
    url: 'http://127.0.0.1/',
    title: 'Fixture',
    vw: 1440,
    vh: 900,
    docH: 1974,
    screens: 3,
    rootBg: '#fafaf9',
    colorScheme: 'normal',
    themeColor: null,
    generator: null,
    samples: {
      points: 1000,
      media: 0,
      gradient: 0,
      area: [
        ['#1c1917', 520],
        ['#fafaf9', 390],
        ['#ffffff', 85],
        ['#e11d48', 5],
      ],
    },
    text: [
      ['16|400|24|0|Georgia||p', 900],
      ['56|700|61.6|-1|Arial||h1', 21],
      ['36|700|43.2|0|Arial||h2', 20],
      ['13|400|16|0|Arial||button', 5],
    ],
    textColor: [
      ['#1c1917', 850],
      ['#fafaf9', 70],
      ['#ffffff', 60],
    ],
    families: [
      ['Georgia', 900],
      ['Arial', 46],
    ],
    fontsLoaded: [],
    padding: [
      ['24', 18],
      ['96', 6],
      ['12', 4],
      ['20', 4],
      ['32', 2],
    ],
    gap: [['24', 2]],
    vmargin: [['16', 10]],
    radius: [
      ['12', 3],
      ['full', 2],
    ],
    shadow: [['rgba(0, 0, 0, 0.06) 0px 1px 2px 0px', 3]],
    borderW: [['1', 3]],
    borderColor: [['#e7e5e4', 3]],
    duration: [['150', 2]],
    easing: [['ease-out', 2]],
    gradients: [],
    effects: { backdrop: 0, blur: 0, clipText: 0, blend: 0, animated: 0, sticky: 1, fixed: 0 },
    grids: [[3, 24, 3, 1120, 680]],
    buttons: [
      {
        h: 48,
        w: 118,
        padX: 20,
        r: 'full',
        bg: '#e11d48',
        fg: '#ffffff',
        border: null,
        fw: '600',
        fs: 16,
        tt: 'none',
        y: 337,
      },
    ],
    inputs: [],
    nav: { h: 64, pos: 'sticky', bg: '#ffffff', backdrop: false, links: 2, buttons: 1 },
    sections: [
      {
        tag: 'header',
        y: 0,
        h: 64,
        bg: '#ffffff',
        padY: [0, 0],
        cols: 3,
        media: null,
        container: 0,
        align: null,
        sticky: true,
      },
      {
        tag: 'section',
        y: 64,
        h: 417,
        bg: null,
        padY: [96, 96],
        cols: 1,
        media: 'right',
        container: 1168,
        align: 'start',
        sticky: false,
      },
      {
        tag: 'section',
        y: 481,
        h: 401,
        bg: null,
        padY: [96, 96],
        cols: 1,
        media: 'left',
        container: 1168,
        align: 'start',
        sticky: false,
      },
      {
        tag: 'section',
        y: 882,
        h: 1092,
        bg: '#1c1917',
        padY: [96, 96],
        cols: 1,
        media: 'right',
        container: 1168,
        align: 'start',
        sticky: false,
      },
    ],
    images: 0,
    imgRatios: [],
    icons: [],
    vars: { '--brand': '#e11d48', '--radius': '12px', '--sx-ab12cd34': '6px', '--label': 'hello' },
    elements: 40,
    ...overrides,
  };
}

const narrow = (): DesignDnaRaw => raw({ vw: 390, grids: [[1, 24, 3, 342, 900]] });

describe('design DNA extractor script', () => {
  it('fits browser_evaluate and parses as a single expression', () => {
    expect(DESIGN_DNA_EXTRACTOR.length).toBeLessThanOrEqual(16_384);
    // It lives in a template string: an interpolation would be evaluated node-side.
    expect(DESIGN_DNA_EXTRACTOR).not.toContain('${');
    // Compile only — vm.Script parses without running the page code.
    expect(() => new vm.Script(DESIGN_DNA_EXTRACTOR)).not.toThrow();
  });
});

describe('summarizeDesignDna', () => {
  const dna = summarizeDesignDna([narrow(), raw()], '2026-10-19T00:00:00.000Z');

  it('keeps the page background when an inverted band covers more area', () => {
    expect(dna.theme).toBe('light');
    expect(dna.color.roles.bg).toBe('#fafaf9');
    expect(dna.color.roles.fg).toBe('#1c1917');
    expect(dna.color.roles.surface).toBe('#ffffff');
    expect(dna.signals).toContain('inverted-bands');
  });

  it('takes the primary from filled buttons, not from area or text', () => {
    expect(dna.color.roles.primary).toBe('#e11d48');
    expect(dna.color.roles.border).toBe('#e7e5e4');
  });

  it('prefers an achromatic filled button over a colored link for primary', () => {
    const mono = summarizeDesignDna([
      raw({
        samples: { points: 100, media: 0, gradient: 0, area: [['#fafaf9', 90]] },
        textColor: [
          ['#1c1917', 850],
          ['#2563eb', 40],
        ],
        buttons: [{ ...raw().buttons[0]!, bg: '#171717' }],
      }),
    ]);
    expect(mono.color.roles.primary).toBe('#171717');
    expect(mono.color.roles.accent).toBe('#2563eb');

    const monoRose = summarizeDesignDna([
      raw({
        samples: { points: 100, media: 0, gradient: 0, area: [['#ffffff', 95]] },
        textColor: [
          ['#111111', 850],
          ['#e11d48', 40],
        ],
        buttons: [{ ...raw().buttons[0]!, bg: '#000000' }],
      }),
    ]);
    expect(monoRose.color.roles.primary).toBe('#000000');
    expect(monoRose.color.roles.accent).toBe('#e11d48');
  });

  it('picks the strongest-contrast color among near-equal text weights as fg', () => {
    const dark = summarizeDesignDna([
      raw({
        rootBg: '#08090a',
        samples: { points: 100, media: 0, gradient: 0, area: [['#08090a', 90]] },
        textColor: [
          ['#8a8f98', 350],
          ['#d0d6e0', 340],
          ['#62666d', 80],
        ],
        buttons: [],
      }),
    ]);
    expect(dna.theme).toBe('light');
    expect(dark.theme).toBe('dark');
    expect(dark.color.roles.fg).toBe('#d0d6e0');
    expect(dark.color.roles.muted).toBe('#8a8f98');
  });

  it('measures the type system and labels the display pairing', () => {
    expect(dna.type.text).toBe('Georgia');
    expect(dna.type.display).toBe('Arial');
    expect(dna.type.base).toEqual({ size: 16, weight: 400, lineHeight: 1.5 });
    expect(dna.type.scale).toEqual([16, 36, 56]);
    expect(dna.type.ratio).toBeCloseTo(1.871, 2);
    expect(dna.type.headingWeight).toBe(700);
    expect(dna.signals).toContain('display-type-pairing');
  });

  it('infers spacing, shape and motion', () => {
    // 24/96/32/16 dominate; 12 and 20 are the only off-grid values (83% fit).
    expect(dna.space.unit).toBe(8);
    expect(dna.space.sectionPadY).toBe(96);
    expect(dna.shape.radius).toBe(12);
    expect(dna.shape.shadowStyle).toBe('soft');
    expect(dna.motion).toMatchObject({ duration: 150, easing: 'ease-out' });
    expect(dna.components.button).toMatchObject({ h: 48, radius: 'full' });
  });

  it('keeps layout per viewport, widest first, and sees reflow and alternation', () => {
    expect(dna.source.viewports).toEqual([1440, 390]);
    // A one-column grid is not a multi-column grid: the narrow viewport reads 0.
    expect(dna.layout.map((l) => l.maxGridCols)).toEqual([3, 0]);
    expect(dna.layout[0]?.container).toBe(1168);
    // the 64px header is chrome, not a section
    expect(dna.layout[0]?.sections).toHaveLength(3);
    expect(dna.signals).toEqual(
      expect.arrayContaining([
        'sticky-nav',
        'grid-reflows-on-narrow',
        'alternating-media-rows',
        'pill-buttons',
      ]),
    );
  });

  it('keeps meaningful declared tokens and drops hashed or non-token vars', () => {
    expect(dna.declaredTokens).toEqual({ '--brand': '#e11d48', '--radius': '12px' });
  });

  it('records what the measurement could not see', () => {
    expect(dna.notes.join(' ')).toMatch(/declared but not seen in document\.fonts/);
  });

  it('refuses to summarize nothing', () => {
    expect(() => summarizeDesignDna([])).toThrow(/no measurements/);
  });
});

describe('spacing unit inference', () => {
  // Padding is one of the three spacing inputs; gap and margins are emptied.
  const space = (padding: Array<[string, number]>) =>
    summarizeDesignDna([raw({ padding, gap: [], vmargin: [] })]).space;

  it('returns the largest unit that fits most values', () => {
    expect(
      space([
        ['8', 5],
        ['16', 5],
        ['24', 5],
        ['32', 2],
      ]),
    ).toMatchObject({ unit: 8, unitFit: 1 });
    expect(
      space([
        ['8', 5],
        ['12', 5],
        ['4', 5],
        ['20', 2],
      ]).unit,
    ).toBe(4);
    expect(space([])).toMatchObject({ unit: null, unitFit: 0 });
  });

  it('ignores hairline values that every unit would miss', () => {
    expect(
      space([
        ['1', 40],
        ['2', 40],
        ['8', 5],
        ['16', 5],
      ]).unit,
    ).toBe(8);
  });
});

describe('color helpers', () => {
  it('measures OKLab distance and formats oklch', () => {
    expect(deltaE('#ffffff', '#ffffff')).toBe(0);
    expect(deltaE('#000000', '#ffffff')).toBeCloseTo(1, 2);
    expect(hexToOklchString('#ffffff')).toBe('oklch(100.0% 0.000 0.0)');
  });
});

describe('compareDesignDna', () => {
  const ref = summarizeDesignDna([narrow(), raw()]);

  it('scores an identical measurement 100% on every axis', () => {
    const cmp = compareDesignDna(ref, ref);
    expect(cmp.overall).toBe(1);
    expect(cmp.findings.every((f) => f.status === 'match')).toBe(true);
    expect(cmp.viewports).toEqual([1440, 390]);
  });

  it('reports each drifted axis and scores the lowest one overall', () => {
    const drifted = summarizeDesignDna([
      narrow(),
      raw({
        buttons: [{ ...raw().buttons[0]!, bg: '#2563eb' }],
        radius: [['4', 5]],
        duration: [['300', 2]],
        easing: [['linear', 2]],
      }),
    ]);
    const cmp = compareDesignDna(ref, drifted);
    const off = cmp.findings.filter((f) => f.status !== 'match').map((f) => f.what);
    expect(off).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^role primary/),
        'dominant radius',
        'dominant transition duration',
        'dominant easing',
      ]),
    );
    expect(cmp.axes.type).toBe(1);
    expect(cmp.weakest).toBe('motion');
    expect(cmp.overall).toBe(0);
  });

  it('treats a missing role as a miss, not a match', () => {
    const plain = {
      ...ref,
      color: { ...ref.color, roles: { ...ref.color.roles, surface: undefined } },
    };
    const cmp = compareDesignDna(ref, plain);
    expect(cmp.findings.find((f) => f.what === 'role surface')?.status).toBe('missing');
    expect(cmp.overall).toBeLessThan(1);
  });

  it('handles zero reference sectionPadY, motion.duration, and display scale without 0/0 NaN false-mismatch (F106)', () => {
    const zeroRef = {
      ...ref,
      type: { ...ref.type, scale: [0] },
      space: { ...ref.space, sectionPadY: 0 },
      motion: { ...ref.motion, duration: 0, durations: [0] },
    };
    const cmp = compareDesignDna(zeroRef, zeroRef);
    expect(cmp.findings.find((f) => f.what === 'section vertical padding')?.status).toBe('match');
    expect(cmp.findings.find((f) => f.what === 'dominant transition duration')?.status).toBe(
      'match',
    );
    expect(cmp.findings.find((f) => f.what === 'largest display size')?.status).toBe('match');
  });
});

describe('dnaToTokenOverrides', () => {
  it('scopes colors to the measured theme and maps scales to Design Studio names', () => {
    const out = dnaToTokenOverrides(summarizeDesignDna([raw()]));
    expect(out['light.primary']).toMatch(/^oklch\(/);
    expect(out['light.ring']).toBe(out['light.primary']);
    expect(out['dark.primary']).toBeUndefined();
    expect(out).toMatchObject({
      'font-sans': 'Georgia, system-ui, sans-serif',
      'font-display': 'Arial, system-ui, sans-serif',
      'text-base': '1rem',
      'radius-md': '12px',
      'duration-base': '150ms',
      'ease-standard': 'ease-out',
    });
  });

  it('does not emit an undefined ring override when primary is not a hex color (F106)', () => {
    const dna = summarizeDesignDna([raw()]);
    const nonHexPrimary = {
      ...dna,
      color: { ...dna.color, roles: { ...dna.color.roles, primary: 'var(--brand)' } },
    };
    const out = dnaToTokenOverrides(nonHexPrimary);
    expect('light.ring' in out).toBe(false);
  });

  it('flattens every radius step for a square-cornered reference', () => {
    const square = dnaToTokenOverrides(summarizeDesignDna([raw({ radius: [['0', 5]] })]));
    expect(['radius-sm', 'radius-md', 'radius-lg', 'radius-xl'].map((k) => square[k])).toEqual([
      '0',
      '0',
      '0',
      '0',
    ]);
    // Nothing measured means nothing to carry over — the kit keeps its own ramp.
    const unknown = dnaToTokenOverrides(summarizeDesignDna([raw({ radius: [] })]));
    expect(unknown['radius-md']).toBeUndefined();
  });
});

describe('renderDesignDnaMarkdown', () => {
  it('separates measured from inferred values', () => {
    const md = renderDesignDnaMarkdown(
      summarizeDesignDna([narrow(), raw()], '2026-10-19T00:00:00.000Z'),
    );
    expect(md).toContain('Theme (inferred): light');
    expect(md).toContain('Body (measured): 16px / 400 / line-height 1.5');
    expect(md).toContain('@390px');
    expect(md).toContain('## Limits of this measurement');
  });
});

describe('multi-page and 5-breakpoint synthesis', () => {
  it('merges multi-page measurements per viewport and builds the 5-breakpoint matrix', () => {
    const viewports = [1440, 1280, 1024, 768, 375];
    const homeRaws = viewports.map((vw) =>
      raw({
        url: 'https://stripe.com/',
        vw,
        grids: vw >= 1024 ? [[4, 16, 4, vw - 64, 600]] : [[1, 16, 4, vw - 24, 600]],
      }),
    );
    const pricingRaw = raw({
      url: 'https://stripe.com/pricing',
      vw: 1440,
      fullGradients: [
        {
          context: 'section',
          kind: 'radial',
          value: 'radial-gradient(circle, rgb(127, 125, 252), rgb(244, 75, 204))',
        },
      ],
      states: {
        'button-hover': { target: 'button', state: 'hover', opacity: 0.6 },
      },
      statesFound: 12,
    });
    const docsRaw = raw({
      url: 'https://stripe.com/docs',
      vw: 1440,
      statesFound: 8,
    });

    const dna = summarizeDesignDna([...homeRaws, pricingRaw, docsRaw], '2026-11-08T00:00:00.000Z');
    expect(dna.source.pagesAnalyzed).toBe(3);
    expect(dna.source.viewports).toEqual([1440, 1280, 1024, 768, 375]);
    expect(dna.breakpoints?.map((b) => b.width)).toEqual([375, 768, 1024, 1280, 1440]);
    expect(dna.coverage?.statesFound).toBe(20);
    expect(dna.gradients?.[0]?.kind).toBe('radial');
    expect(dna.color.palette?.primary).toBe('#e11d48');
    expect(dna.type.roles?.['display-lg']?.fontSize).toBe('56px');
  });
});
