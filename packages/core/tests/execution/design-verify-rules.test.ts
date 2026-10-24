import type { DesignKitTokens } from '@wrongstack/contracts/types/design-kit';
import { describe, expect, it } from 'vitest';
import { verifyFiles } from '../../src/execution/design-verify.js';

/**
 * The catalogue additions: every rule is shown catching its pattern and
 * staying quiet on the legitimate neighbour that the corpus measurement
 * (824 repository UI files) turned up, plus the waiver scopes.
 */

const kit: DesignKitTokens = {
  light: { bg: 'oklch(99% 0 0)', fg: 'oklch(20% 0.02 260)', primary: 'oklch(56% 0.16 264)' },
  dark: { bg: 'oklch(18% 0.01 260)', fg: 'oklch(95% 0.01 260)', primary: 'oklch(68% 0.15 264)' },
};

function ids(text: string, tokens: DesignKitTokens = kit): string[] {
  return verifyFiles(tokens, [{ path: 'src/App.tsx', text }]).violations.map(
    (v) => `${v.severity} ${v.id}`,
  );
}

describe('catalogue rules', () => {
  it('flags transition-all and lets named transitions through', () => {
    expect(ids('<div className="transition-all duration-200" />')).toEqual([
      'WARN motion.transition-all',
    ]);
    expect(ids('.x { transition: all 200ms; }')).toEqual(['WARN motion.transition-all']);
    expect(ids('<div className="transition-colors duration-200" />')).toEqual([]);
  });

  it('flags overshooting easing literals only', () => {
    expect(ids('.x { transition-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }')).toEqual([
      'WARN motion.overshoot-easing',
    ]);
    expect(ids('.x { transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); }')).toEqual([]);
  });

  it('flags a blurred decorative glow blob unless the kit has a gradient idiom', () => {
    const blob =
      '<div className="pointer-events-none absolute -top-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />';
    expect(ids(blob)).toEqual(['WARN composition.glow-blob']);
    const aurora: DesignKitTokens = {
      ...kit,
      light: { ...kit.light, 'hero-wash': 'linear-gradient(90deg, #fff, #eee)' },
    };
    expect(ids(blob, aurora)).toEqual([]);
    // A blurred surface that is not an absolutely positioned circle is not a blob.
    expect(ids('<div className="rounded-full blur-3xl" />')).toEqual([]);
  });

  it('flags a tiny uppercase eyebrow directly above a main heading', () => {
    const eyebrow = [
      '<p className="text-xs uppercase tracking-widest text-primary">New</p>',
      '<h1 className="text-5xl">Ship faster</h1>',
    ].join('\n');
    expect(ids(eyebrow)).toEqual(['WARN composition.eyebrow-label']);
    const label = [
      '<p className="text-xs uppercase tracking-widest">Status</p>',
      '<p className="text-sm">Healthy</p>',
    ].join('\n');
    expect(ids(label)).toEqual([]);
  });

  it('flags forced-contrast copy', () => {
    expect(ids("<p>It's not just a tool, it's a platform.</p>")).toEqual(['WARN copy.not-x-but-y']);
    expect(ids('<p>Not only for teams.</p>')).toEqual([]);
  });

  it('flags an unsized img but not one sized by attributes or classes', () => {
    expect(ids('<img src="/hero.png" alt="Product" />')).toEqual(['WARN media.img-unsized']);
    expect(ids('<img src="/hero.png" alt="" width={640} height={400} />')).toEqual([]);
    expect(ids('<img src="/logo.svg" alt="" className="size-5" />')).toEqual([]);
  });

  it('flags a clickable div without a role', () => {
    expect(ids('<div className="p-2" onClick={open}>Open</div>')).toEqual(['WARN a11y.div-click']);
    expect(ids('<div role="button" tabIndex={0} onClick={open}>Open</div>')).toEqual([]);
  });

  it('fails an icon-only button with no accessible name', () => {
    expect(ids('<button className="p-1"><XIcon className="size-4" /></button>')).toEqual([
      'FAIL a11y.icon-button-unlabeled',
    ]);
    expect(
      ids('<button aria-label="Close" className="p-1"><XIcon className="size-4" /></button>'),
    ).toEqual([]);
  });

  it('fails a viewport that disables zoom', () => {
    expect(ids('<meta name="viewport" content="width=device-width, user-scalable=no" />')).toEqual([
      'FAIL a11y.zoom-disabled',
    ]);
    expect(ids('<meta name="viewport" content="width=device-width, initial-scale=1" />')).toEqual(
      [],
    );
  });

  it('flags justified text', () => {
    expect(ids('<p className="text-justify">Long copy</p>')).toEqual(['WARN type.justify']);
  });

  it('flags em-dash density in visible copy, once per file', () => {
    const dashes = Array.from({ length: 6 }, (_, i) => `<p>Step ${i} — then more</p>`).join('\n');
    expect(ids(dashes)).toEqual(['WARN copy.em-dash-density']);
    expect(ids(dashes.split('\n').slice(0, 5).join('\n'))).toEqual([]);
  });

  it('gives legacy rules their ids too', () => {
    expect(ids('<div className="shadow-lg" />')).toEqual(['WARN composition.stock-elevation']);
    expect(ids('<div className="bg-blue-500" />')).toEqual(['WARN color.generic-utility']);
  });
});

describe('waivers', () => {
  it('waives on the same line, the next line, or the whole file', () => {
    expect(
      ids('<div className="transition-all" /> {/* design-ignore: motion.transition-all */}'),
    ).toEqual([]);
    expect(
      ids(
        [
          '{/* design-ignore-next-line: motion.transition-all */}',
          '<div className="transition-all" />',
        ].join('\n'),
      ),
    ).toEqual([]);
    expect(
      ids(
        [
          '// design-ignore-file: motion.transition-all',
          '<div className="transition-all" />',
          '<div className="transition-all" />',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('waives only the named rule, and * waives all', () => {
    const line = '<div className="transition-all shadow-lg" />';
    expect(ids(`${line} {/* design-ignore: motion.transition-all */}`)).toEqual([
      'WARN composition.stock-elevation',
    ]);
    expect(ids(`${line} {/* design-ignore: * */}`)).toEqual([]);
    // A waiver without an id waives nothing.
    expect(ids(`${line} {/* design-ignore: */}`)).toHaveLength(2);
    // Nor does a misspelt one.
    expect(ids(`${line} {/* design-ignore: motion.transition-al */}`)).toHaveLength(2);
  });
});
