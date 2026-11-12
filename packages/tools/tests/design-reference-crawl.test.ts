import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { designReferenceTool, selectReferenceSubpages } from '../src/design-reference.js';

// Browser-free crawl tests: the browser manager is replaced by a fake so the
// subpage selection, the abort propagation and the failure reporting can be
// proven without Chromium.

const fake = vi.hoisted(() => {
  const state = {
    opened: [] as string[],
    sessions: new Map<string, string>(),
    /** Path of the PNG the fake screenshot returns. */
    shotPath: '',
    /** URL -> error thrown by manager.open (simulates a failing subpage). */
    openError: null as null | ((url: string) => Error | undefined),
    /** Called with the url before a session is opened. */
    onOpen: null as null | ((url: string) => void),
  };

  const raw = (url: string) => ({
    v: 1 as const,
    url,
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
    radius: [['6', 5]],
    shadow: [],
    borderW: [],
    borderColor: [],
    duration: [['200', 3]],
    easing: [['ease', 3]],
    gradients: [],
    effects: {},
    grids: [],
    buttons: [],
    inputs: [],
    nav: null,
    sections: [],
    images: 0,
    imgRatios: [],
    icons: [],
    vars: {},
    elements: 10,
    internalLinks: ['https://example.com/pricing', 'https://evil.test/pwn'],
  });

  return { state, raw };
});

vi.mock('../src/browser/tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/tools.js')>();
  return {
    ...actual,
    managerFor: () => ({
      async open(
        _ownerId: string,
        opts: { url: string },
        signal: AbortSignal,
      ): Promise<{ id: string }> {
        if (signal.aborted) throw signal.reason ?? new Error('aborted');
        fake.state.opened.push(opts.url);
        fake.state.onOpen?.(opts.url);
        const err = fake.state.openError?.(opts.url);
        if (err) throw err;
        const id = `session-${fake.state.opened.length}`;
        fake.state.sessions.set(id, opts.url);
        return { id };
      },
      async evaluate(sessionId: string): Promise<unknown> {
        return fake.raw(fake.state.sessions.get(sessionId) ?? '');
      },
      async snapshot(): Promise<{ console: unknown[]; network: unknown[] }> {
        return { console: [], network: [] };
      },
      async screenshot(): Promise<{ path: string }> {
        return { path: fake.state.shotPath };
      },
      async close(): Promise<void> {},
    }),
  };
});

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-ref-crawl-'));
  const shotPath = path.join(root, 'shot.png');
  await fs.writeFile(shotPath, 'png');
  fake.state.shotPath = shotPath;
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: root, tools: [], projectRoot: root, meta: {} }) as unknown as Context;

function reset(): void {
  fake.state.opened.length = 0;
  fake.state.sessions.clear();
  fake.state.openError = null;
  fake.state.onOpen = null;
}

describe('design_reference subpage selection', () => {
  it('drops discovered links that leave the measured origin', () => {
    const subpages = selectReferenceSubpages({
      url: 'https://example.com/',
      extraPages: [],
      discovered: [
        'https://example.com/pricing',
        'https://evil.test/pwn',
        // Prefix look-alike origin: same string start, different origin.
        'https://example.com.evil.test/pwn',
      ],
      maxPages: 8,
    });
    expect(subpages).toEqual(['https://example.com/pricing']);
  });

  it('keeps explicitly requested pages even on another origin', () => {
    const subpages = selectReferenceSubpages({
      url: 'https://example.com/',
      extraPages: ['https://other.test/page'],
      discovered: [],
      maxPages: 2,
    });
    expect(subpages).toEqual(['https://other.test/page']);
  });

  it('bounds the total page count by maxPages', () => {
    const subpages = selectReferenceSubpages({
      url: 'https://example.com/',
      extraPages: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
      discovered: [],
      maxPages: 2,
    });
    // One page is the measured page itself, so maxPages 2 allows one subpage.
    expect(subpages).toEqual(['https://example.com/a']);
  });

  it('measures no subpage when maxPages is one', () => {
    const subpages = selectReferenceSubpages({
      url: 'https://example.com/',
      extraPages: ['https://example.com/a'],
      discovered: ['https://example.com/b'],
      maxPages: 1,
    });
    expect(subpages).toEqual([]);
  });
});

describe('design_reference extract crawl', () => {
  it('never opens a cross-origin discovered link', async () => {
    reset();
    await designReferenceTool.execute(
      { action: 'extract', url: 'https://example.com/', name: 'origin-check', maxPages: 8 },
      makeCtx(),
      { signal: new AbortController().signal },
    );
    expect(fake.state.opened.filter((u) => u.startsWith('https://evil.test'))).toEqual([]);
    expect([...new Set(fake.state.opened)]).toEqual([
      'https://example.com/',
      'https://example.com/pricing',
    ]);
  });

  it('propagates an abort during the crawl instead of writing artifacts', async () => {
    reset();
    const controller = new AbortController();
    fake.state.onOpen = (url) => {
      if (url !== 'https://example.com/') controller.abort(new Error('cancelled by user'));
    };
    fake.state.openError = (url) =>
      url === 'https://example.com/pricing' ? new Error('subpage exploded') : undefined;
    await expect(
      designReferenceTool.execute(
        { action: 'extract', url: 'https://example.com/', name: 'aborted', maxPages: 8 },
        makeCtx(),
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/subpage exploded/);
    const dir = path.join(root, '.design', 'references', 'aborted');
    await expect(fs.readFile(path.join(dir, 'DESIGN.md'), 'utf8')).rejects.toThrow();
    await expect(fs.readFile(path.join(dir, 'dna.json'), 'utf8')).rejects.toThrow();
  });

  it('reports a failing subpage and still writes the reference', async () => {
    reset();
    fake.state.openError = (url) =>
      url === 'https://example.com/pricing' ? new Error('subpage exploded') : undefined;
    const logs: string[] = [];
    for await (const event of designReferenceTool.executeStream!(
      { action: 'extract', url: 'https://example.com/', name: 'skipped', maxPages: 8 },
      makeCtx(),
      { signal: new AbortController().signal },
    )) {
      if (event.type === 'log' && event.text !== undefined) logs.push(event.text);
    }
    expect(logs.some((t) => t.includes('subpage skipped') && t.includes('subpage exploded'))).toBe(
      true,
    );
    const dna = await fs.readFile(
      path.join(root, '.design', 'references', 'skipped', 'dna.json'),
      'utf8',
    );
    expect(dna).toContain('"source"');
  });
});
