import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { captureProjectTokens } from '../../src/execution/design-capture.js';
import { getDesignKitLoader } from '../../src/execution/design-kit-loader.js';
import {
  designMdToTokens,
  parseDesignMd,
  renderDesignMd,
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
