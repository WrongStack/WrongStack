import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DESIGN_INSPECT_EXTRACTOR } from '../../src/execution/design-inspect-extractor.js';
import {
  type DesignInspectRaw,
  type InspectRuntimeEvidence,
  type InspectSurface,
  inspectDesign,
  renderInspectMarkdown,
} from '../../src/execution/design-inspect.js';

/** One viewport through the public entry point. */
const inspectViewport = (
  raw: DesignInspectRaw,
  surface: InspectSurface,
  runtime?: InspectRuntimeEvidence,
) => inspectDesign([{ raw, runtime }], surface).findings;

/** A clean single-viewport measurement; each test plants one defect. */
function clean(overrides: Partial<DesignInspectRaw> = {}): DesignInspectRaw {
  return {
    v: 1,
    url: 'http://127.0.0.1/',
    vw: 1440,
    vh: 900,
    docH: 1800,
    scrollW: 1440,
    overflow: [],
    edgeText: [],
    edgeCount: 0,
    longLines: [],
    longCount: 0,
    sizes: { '16': 900, '36': 40, '56': 20 },
    families: { Inter: 960 },
    loaded: ['Inter'],
    headings: [
      { l: 1, lines: 1, fs: 56, t: 'Title', y: 100 },
      { l: 2, lines: 1, fs: 36, t: 'Section', y: 600 },
    ],
    contrast: [],
    contrastCount: 0,
    contrastChecked: 40,
    smallTargets: [],
    smallCount: 0,
    targetsChecked: 10,
    brokenImages: [],
    unsizedImages: 0,
    hiddenText: [],
    hiddenCount: 0,
    blankBands: [],
    bodySizes: { '16': 900 },
    justified: 0,
    elements: 120,
    ...overrides,
  };
}

const ids = (raw: DesignInspectRaw, surface: 'page' | 'app' = 'page') =>
  inspectViewport(raw, surface).map((f) => `${f.severity} ${f.id}`);

describe('design inspect extractor script', () => {
  it('fits browser_evaluate and parses as a single expression', () => {
    expect(DESIGN_INSPECT_EXTRACTOR.length).toBeLessThanOrEqual(16_384);
    expect(DESIGN_INSPECT_EXTRACTOR).not.toContain('${');
    expect(() => new vm.Script(DESIGN_INSPECT_EXTRACTOR)).not.toThrow();
  });
});

describe('inspectViewport', () => {
  it('reports nothing for a clean page', () => {
    expect(ids(clean())).toEqual([]);
  });

  it('fails real defects', () => {
    expect(ids(clean({ scrollW: 1800, overflow: [{ sel: 'div.wide', right: 1800 }] }))).toEqual([
      'FAIL layout.horizontal-overflow',
    ]);
    expect(ids(clean({ contrastCount: 1, contrast: [{ sel: 'p.low', ratio: 1.9 }] }))).toEqual([
      'FAIL a11y.text-contrast',
    ]);
    expect(ids(clean({ smallCount: 2 }))).toEqual(['FAIL a11y.target-size']);
    expect(ids(clean({ brokenImages: [{ sel: 'img' }] }))).toEqual(['FAIL media.broken-image']);
  });

  it('fails text at the edge only on a phone width', () => {
    expect(ids(clean({ edgeCount: 2 }))).toEqual(['WARN layout.text-at-edge']);
    expect(ids(clean({ vw: 390, scrollW: 390, edgeCount: 2 }))).toEqual([
      'FAIL layout.text-at-edge',
    ]);
  });

  it('holds a content page and a dense app screen to different type minimums', () => {
    const small = clean({ bodySizes: { '14': 900 }, sizes: { '14': 900, '20': 40 } });
    expect(ids(small, 'page')).toEqual(['WARN type.body-size']);
    expect(ids(small, 'app')).toEqual([]);
    expect(ids(clean({ bodySizes: { '10': 900 } }), 'app')).toEqual(['FAIL type.body-size']);
    const sizes = { '11': 50, '12': 50, '13': 50, '14': 50, '16': 500, '20': 50, '28': 50 };
    expect(ids(clean({ sizes }), 'page')).toEqual(['WARN type.size-count']);
    expect(ids(clean({ sizes }), 'app')).toEqual([]);
  });

  it('counts only families that carry text, and never monospace', () => {
    const families = { Inter: 500, Lora: 200, Oswald: 100, 'JetBrains Mono': 100, Rare: 1 };
    expect(ids(clean({ families }))).toEqual([]);
    expect(ids(clean({ families: { ...families, Caveat: 100 } }))).toEqual([
      'WARN type.family-count',
    ]);
  });

  it('checks heading order and the single h1 a page needs', () => {
    const skip = clean({
      headings: [
        { l: 1, lines: 1, fs: 56, t: 'Title', y: 100 },
        { l: 3, lines: 1, fs: 24, t: 'Jump', y: 400 },
      ],
    });
    expect(ids(skip)).toEqual(['WARN type.heading-order']);
    const noH1 = clean({ headings: [{ l: 2, lines: 1, fs: 36, t: 'S', y: 100 }] });
    expect(ids(noH1, 'page')).toEqual(['WARN type.heading-order']);
    expect(ids(noH1, 'app')).toEqual([]);
  });

  it('warns on long lines, wrapped headlines, unsized media and stuck-hidden text', () => {
    expect(ids(clean({ longCount: 1, longLines: [{ sel: 'p', ch: 140 }] }))).toEqual([
      'WARN type.line-length',
    ]);
    expect(ids(clean({ headings: [{ l: 1, lines: 5, fs: 56, t: 'Very long', y: 100 }] }))).toEqual([
      'WARN type.headline-wrap',
    ]);
    expect(ids(clean({ unsizedImages: 3 }))).toEqual(['WARN media.unsized-image']);
    expect(ids(clean({ hiddenCount: 2 }))).toEqual([]);
    expect(ids(clean({ hiddenCount: 3 }))).toEqual(['WARN content.stuck-hidden']);
  });

  it('ignores a short blank tail but warns on a blank full viewport', () => {
    // docH 1800 / vh 900 → bands 0 and 1; band 1 is a full viewport.
    expect(ids(clean({ blankBands: [1] }))).toEqual(['WARN layout.blank-band']);
    // docH 1000 → band 1 is a 100px tail.
    expect(ids(clean({ docH: 1000, blankBands: [1] }))).toEqual([]);
  });

  it('turns runtime evidence into warnings', () => {
    const found = inspectViewport(clean(), 'page', {
      consoleErrors: ['TypeError: x is undefined'],
      failedRequests: ['404 https://example.com/a.png'],
    }).map((f) => f.id);
    expect(found).toEqual(['runtime.console-error', 'runtime.failed-request']);
  });

  it('checks rendered hero fold, hero dead bands, heading proximity, and ultrawide bounds', () => {
    const belowFold = clean({
      vw: 1280,
      vh: 800,
      scrollW: 1280,
      heroFold: { h1Bottom: 420, ctaBottom: 880 },
    });
    expect(ids(belowFold, 'page')).toEqual(['WARN layout.hero-fold']);
    expect(
      inspectDesign([{ raw: belowFold }], 'page', { stage: 'hero' }).findings.map(
        (f) => `${f.severity} ${f.id}`,
      ),
    ).toEqual(['FAIL layout.hero-fold']);

    expect(ids(clean({ heroDeadBand: 210 }), 'page')).toEqual(['WARN layout.hero-dead-band']);
    expect(
      ids(
        clean({
          headingProximity: [{ sel: 'h2.sec', above: 12, below: 32, t: 'Pricing' }],
        }),
      ),
    ).toEqual(['WARN layout.heading-proximity']);
    expect(
      ids(
        clean({
          vw: 1920,
          scrollW: 1920,
          unboundedCount: 1,
          unbounded: [{ sel: 'section.prose', w: 1840 }],
        }),
        'page',
      ),
    ).toEqual(['WARN layout.unbounded-ultrawide']);
  });
});

describe('inspectDesign', () => {
  it('orders viewports widest first, totals severities and states its coverage', () => {
    const report = inspectDesign([
      { raw: clean({ vw: 390, scrollW: 600 }) },
      { raw: clean({ contrastCount: 1 }) },
    ]);
    expect(report.viewports).toEqual([1440, 390]);
    expect(report.fails).toBe(2);
    expect(report.warns).toBe(0);
    // Every rule id that can fire is listed as checked.
    expect(report.checked).toHaveLength(21);
    expect(report.checked).toEqual(
      expect.arrayContaining([
        'layout.horizontal-overflow',
        'a11y.text-contrast',
        'runtime.failed-request',
      ]),
    );
    expect(report.notCovered.join(' ')).toMatch(/focus visibility/);
  });

  it('renders one line per rule with every viewport it fired at', () => {
    const md = renderInspectMarkdown(
      inspectDesign([
        { raw: clean({ scrollW: 1800 }) },
        { raw: clean({ vw: 390, scrollW: 1800 }) },
      ]),
    );
    expect(md).toContain('Gate: FAIL');
    expect(md.match(/\[layout\.horizontal-overflow\]/g)).toHaveLength(1);
    expect(md).toContain('1440: scrollWidth 1800px · 390: scrollWidth 1800px');
    expect(renderInspectMarkdown(inspectDesign([{ raw: clean() }]))).toContain('Gate: PASS');
  });
});
