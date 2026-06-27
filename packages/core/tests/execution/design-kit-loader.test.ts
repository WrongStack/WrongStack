import { describe, expect, it } from 'vitest';
import {
  DefaultDesignKitLoader,
  resolveBundledDesignKitsDir,
} from '../../src/execution/design-kit-loader.js';

function bundledLoader(): DefaultDesignKitLoader {
  const bundledDir = resolveBundledDesignKitsDir();
  expect(bundledDir, 'bundled design-kits dir should resolve').toBeTruthy();
  return new DefaultDesignKitLoader({
    inProjectDir: '/nonexistent/project/.wrongstack/design-kits',
    globalDir: '/nonexistent/global/design-kits',
    bundledDir,
  });
}

describe('DefaultDesignKitLoader', () => {
  it('discovers the bundled kits and excludes _foundations from the menu', async () => {
    const loader = bundledLoader();
    const all = await loader.list();
    const ids = all.map((k) => k.id);
    expect(ids).toContain('minimal-clarity');
    expect(ids).toContain('neo-brutalist');
    expect(ids).toContain('material-expressive');
    expect(ids).toContain('_foundations'); // present in list()

    const entries = await loader.listEntries();
    const entryIds = entries.map((e) => e.id);
    expect(entryIds).not.toContain('_foundations'); // excluded from selectable menu
    expect(entryIds.length).toBeGreaterThanOrEqual(10);
  });

  it('parses frontmatter (name, aesthetic, stacks) for a kit', async () => {
    const loader = bundledLoader();
    const kit = await loader.find('minimal-clarity');
    expect(kit).toBeDefined();
    expect(kit?.name).toBe('Minimal Clarity');
    expect(kit?.aesthetic).toMatch(/minimal/i);
    expect(kit?.stacks).toContain('web');
    expect(kit?.source).toBe('bundled');
  });

  it('renders a compact menu listing kit ids + best-for', async () => {
    const loader = bundledLoader();
    const menu = await loader.menuText();
    expect(menu).toMatch(/Design kits/i);
    expect(menu).toContain('minimal-clarity');
    expect(menu).not.toContain('_foundations');
  });

  it('readBody narrows to the requested stack section', async () => {
    const loader = bundledLoader();
    const web = await loader.readBody('minimal-clarity', 'web');
    expect(web).toContain('## Stack: web');
    expect(web).not.toContain('## Stack: flutter');
    // Cross-cutting sections survive narrowing.
    expect(web).toMatch(/## Overview/);

    const all = await loader.readBody('minimal-clarity');
    expect(all).toContain('## Stack: web');
    expect(all).toContain('## Stack: flutter');
  });

  it('readTokens returns light + dark token snapshots', async () => {
    const loader = bundledLoader();
    const tokens = await loader.readTokens('minimal-clarity');
    expect(tokens?.light?.['primary']).toMatch(/oklch/);
    expect(tokens?.dark?.['bg']).toMatch(/oklch/);
  });

  it('foundationsText returns the baseline doc', async () => {
    const loader = bundledLoader();
    const text = await loader.foundationsText('web');
    expect(text).toMatch(/WCAG/i);
    expect(text).toMatch(/responsive/i);
  });

  it('throws for an unknown kit id', async () => {
    const loader = bundledLoader();
    await expect(loader.readBody('does-not-exist')).rejects.toThrow(/not found/i);
  });
});
