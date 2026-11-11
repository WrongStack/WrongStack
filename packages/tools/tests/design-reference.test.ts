import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { type DesignDnaRaw, summarizeDesignDna } from '@wrongstack/core/design';
import { ToolRegistry } from '@wrongstack/core/registry';
import { ToolCapabilities } from '@wrongstack/core/security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { designTool as designKitTool } from '../src/design.js';
import { designReferenceTool as designTool } from '../src/design-reference.js';

// Browser-free contract tests. The measuring path itself (a real Chromium
// against a local page) is proven outside the unit suite; here extract,
// compare and inspect must validate input before any browser work, and
// compare must score saved references without one.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-ref-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: root, tools: [], projectRoot: root, meta: {} }) as any;
const opts = { signal: new AbortController().signal };

function raw(primary: string, radius: string): DesignDnaRaw {
  return {
    v: 1,
    url: 'https://example.com/',
    title: 'Example',
    vw: 1440,
    vh: 900,
    docH: 1800,
    screens: 2,
    rootBg: '#ffffff',
    colorScheme: 'normal',
    themeColor: null,
    generator: null,
    samples: { points: 100, media: 0, gradient: 0, area: [['#ffffff', 95]] },
    text: [['16|400|24|0|Inter||p', 500]],
    textColor: [['#111111', 500]],
    families: [['Inter', 500]],
    fontsLoaded: ['Inter'],
    padding: [['16', 10]],
    gap: [['8', 5]],
    vmargin: [],
    radius: [[radius, 5]],
    shadow: [],
    borderW: [],
    borderColor: [],
    duration: [['200', 3]],
    easing: [['ease', 3]],
    gradients: [],
    effects: {},
    grids: [],
    buttons: [
      {
        h: 40,
        w: 100,
        padX: 16,
        r: 6,
        bg: primary,
        fg: '#ffffff',
        border: null,
        fw: '500',
        fs: 14,
        tt: 'none',
        y: 100,
      },
    ],
    inputs: [],
    nav: null,
    sections: [],
    images: 0,
    imgRatios: [],
    icons: [],
    vars: {},
    elements: 10,
  };
}

async function saveReference(slug: string, dnaRaw: DesignDnaRaw): Promise<void> {
  const dir = path.join(root, '.design', 'references', slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'dna.json'), JSON.stringify(summarizeDesignDna([dnaRaw])));
}

describe('design_reference extract / compare / inspect', () => {
  it('compares two saved references without a browser and writes the fidelity record', async () => {
    await saveReference('ref-a', raw('#e11d48', '12'));
    await saveReference('ref-b', raw('#2563eb', '4'));
    const ctx = makeCtx();
    const same = await designTool.execute(
      { action: 'compare', reference: 'ref-a', against: 'ref-a' },
      ctx,
      opts,
    );
    expect(same.score).toBe(1);
    const res = await designTool.execute(
      { action: 'compare', reference: 'ref-a', against: 'ref-b' },
      ctx,
      opts,
    );
    expect(res.action).toBe('compare');
    expect(res.score).toBeLessThan(1);
    expect(res.output).toMatch(/\| color \| off \| role primary/);
    expect(res.output).toMatch(/\| shape \| off \| dominant radius \| 12 \| 4 \|/);
    expect(res.path).toBe('.design/references/ref-a/fidelity.md');
    expect(await fs.readFile(path.join(root, res.path as string), 'utf8')).toContain('# Fidelity');
  });

  it('rejects a reference name that could leave .design/references', async () => {
    await expect(
      designTool.execute(
        { action: 'compare', reference: '../../etc', against: 'ref-a' },
        makeCtx(),
        opts,
      ),
    ).rejects.toThrow(/not a reference name/);
  });

  it('names the missing reference and how to create it', async () => {
    await expect(
      designTool.execute(
        { action: 'compare', reference: 'nope', against: 'ref-a' },
        makeCtx(),
        opts,
      ),
    ).rejects.toThrow(/no extracted reference "nope".*action:"extract"/s);
  });

  it('requires a reference for compare', async () => {
    await expect(designTool.execute({ action: 'compare' }, makeCtx(), opts)).rejects.toThrow(
      /needs reference/,
    );
  });

  it('validates the URL and viewports before opening a browser', async () => {
    const ctx = makeCtx();
    await expect(designTool.execute({ action: 'extract' }, ctx, opts)).rejects.toThrow(
      /http\(s\) URL/,
    );
    await expect(
      designTool.execute({ action: 'extract', url: 'file:///etc/passwd' }, ctx, opts),
    ).rejects.toThrow(/http\(s\) URL/);
    await expect(
      designTool.execute(
        { action: 'extract', url: 'https://example.com', viewports: [100] },
        ctx,
        opts,
      ),
    ).rejects.toThrow(/viewports/);
    await expect(
      designTool.execute(
        { action: 'extract', url: 'https://example.com', name: 'Bad Name' },
        ctx,
        opts,
      ),
    ).rejects.toThrow(/not a reference name/);
    await expect(
      designTool.execute(
        { action: 'extract', url: 'https://example.com', maxPages: 20 },
        ctx,
        opts,
      ),
    ).rejects.toThrow(/maxPages/);
    await expect(
      designTool.execute(
        { action: 'extract', url: 'https://example.com', pages: ['ftp://bad.url'] },
        ctx,
        opts,
      ),
    ).rejects.toThrow(/http\(s\) URL/);
  });

  it('validates inspect input before opening a browser', async () => {
    const ctx = makeCtx();
    await expect(designTool.execute({ action: 'inspect' }, ctx, opts)).rejects.toThrow(
      /http\(s\) URL/,
    );
    await expect(
      designTool.execute(
        { action: 'inspect', url: 'https://example.com', surface: 'poster' as never },
        ctx,
        opts,
      ),
    ).rejects.toThrow(/"surface" is "page"/);
  });

  it('validates a project file before serving it', async () => {
    const ctx = makeCtx();
    await fs.writeFile(path.join(root, 'page.html'), '<h1>x</h1>');
    await fs.writeFile(path.join(root, 'notes.txt'), 'x');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-ref-out-'));
    await fs.writeFile(path.join(outside, 'other.html'), '<h1>x</h1>');
    try {
      await expect(
        designTool.execute(
          { action: 'inspect', file: 'page.html', url: 'https://example.com' },
          ctx,
          opts,
        ),
      ).rejects.toThrow(/url or file, not both/);
      await expect(
        designTool.execute({ action: 'inspect', file: 'notes.txt' }, ctx, opts),
      ).rejects.toThrow(/\.html file inside the project root/);
      await expect(
        designTool.execute({ action: 'inspect', file: 'missing.html' }, ctx, opts),
      ).rejects.toThrow(/does not exist/);
      await expect(
        designTool.execute(
          { action: 'inspect', file: path.join(outside, 'other.html') },
          ctx,
          opts,
        ),
      ).rejects.toThrow(/inside the project root/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects an unknown action', async () => {
    await expect(
      designTool.execute({ action: 'verify' as never }, makeCtx(), opts),
    ).rejects.toThrow(/unknown action "verify"/);
  });

  it('streams progress and file_changed events before final output via executeStream', async () => {
    await saveReference('stream-a', raw('#533afd', '6'));
    await saveReference('stream-b', raw('#0a2540', '4'));
    expect(typeof designTool.executeStream).toBe('function');
    const events: unknown[] = [];
    for await (const ev of designTool.executeStream!(
      { action: 'compare', reference: 'stream-a', against: 'stream-b' },
      makeCtx(),
      opts,
    )) {
      events.push(ev);
    }
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'log',
          text: expect.stringContaining('Scoring per-axis fidelity'),
        }),
        expect.objectContaining({
          type: 'file_changed',
          operation: 'write',
          path: '.design/references/stream-a/fidelity.md',
        }),
        expect.objectContaining({
          type: 'final',
          output: expect.objectContaining({
            action: 'compare',
            path: '.design/references/stream-a/fidelity.md',
          }),
        }),
      ]),
    );
  });
});

describe('design_reference capability gates', () => {
  // Capability gates (--restricted, subagent capability sets, auto-approve)
  // are decided per tool before input is known. The network must therefore
  // be declared on the tool itself, and the offline design tool must not be.
  const registry = new ToolRegistry();
  registry.register(designTool);
  registry.register(designKitTool);
  // The same capability denial `--restricted` applies.
  registry.setSessionRestriction({ denyCapabilities: [ToolCapabilities.NET_OUTBOUND] });

  it('declares outbound network so a network-denying restriction hides it', () => {
    expect(designTool.capabilities).toContain(ToolCapabilities.NET_OUTBOUND);
    expect(registry.isRestricted(designTool.name)).toBe(true);
  });

  it('leaves the offline design tool available under the same restriction', () => {
    expect(designKitTool.capabilities).not.toContain(ToolCapabilities.NET_OUTBOUND);
    expect(registry.isRestricted(designKitTool.name)).toBe(false);
  });

  it('keys trust rules on the URL being opened, not the action', () => {
    expect(designTool.permission).toBe('confirm');
    expect(designTool.subjectKey).toBe('url');
  });
});
