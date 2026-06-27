/**
 * End-to-end Design Studio smoke against the BUILT packages (resolved to dist
 * via the workspace), not source mocks. Exercises the real runtime path:
 * detection → menu injection → tool load → `.design/` persistence → reminder.
 */
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDesignKitLoader,
  getDesignState,
  makeDesignDetectUserInputMiddleware,
  makeDesignStudioRequestMiddleware,
} from '@wrongstack/core';
import { designTool } from '@wrongstack/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-e2e-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('Design Studio — end-to-end (built packages)', () => {
  it('loader discovers the full bundled kit set (foundations excluded)', async () => {
    const loader = getDesignKitLoader(root);
    const entries = await loader.listEntries();
    expect(entries.length).toBeGreaterThanOrEqual(50);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('cyberpunk-neon');
    expect(ids).toContain('luxury-serif');
    expect(ids).toContain('minimal-clarity');
    expect(ids).toContain('linear-dark');
    expect(ids).toContain('solarpunk');
    expect(ids).not.toContain('_foundations');
    // Every kit parses (name + aesthetic) and loads body + tokens cleanly.
    for (const e of entries) {
      expect(e.name, `${e.id} name`).toBeTruthy();
      expect(e.aesthetic, `${e.id} aesthetic`).toBeTruthy();
      expect(e.stacks.length, `${e.id} stacks`).toBeGreaterThan(0);
      const body = await loader.readBody(e.id, 'web');
      expect(body, `${e.id} body`).toMatch(/## Stack: web/);
      const tokens = await loader.readTokens(e.id);
      const themed = tokens?.light ?? tokens?.dark;
      expect(themed, `${e.id} tokens`).toBeTruthy();
    }
  });

  it('detection → menu injection → tool load → .design/ persistence → reminder', async () => {
    const ctx = { projectRoot: root, meta: {} } as any;
    const loader = getDesignKitLoader(root);

    // Detection from user intent.
    await makeDesignDetectUserInputMiddleware().handler(
      { text: 'build me a landing page hero section', content: [], ctx },
      async (p) => p,
    );
    expect(getDesignState(ctx)?.active).toBe(true);
    expect(getDesignState(ctx)?.stack).toBe('web');

    // Request middleware injects the menu (fresh array, base preserved).
    const inject = makeDesignStudioRequestMiddleware({ ctx, loader });
    const baseReq = { model: 'm', system: [{ type: 'text', text: 'BASE' }], messages: [] } as any;
    const out = await inject.handler(baseReq, async (r) => r);
    expect(out.system).toHaveLength(2);
    expect(out.system[0].text).toBe('BASE');
    const injected = out.system[1].text as string;
    expect(injected).toMatch(/Design Studio/);
    expect(injected).toContain('cyberpunk-neon');
    expect(injected).toMatch(/WCAG/);

    // Tool loads the chosen kit for a stack and pins it.
    const res = await designTool.execute(
      { action: 'use', kit: 'cyberpunk-neon', stack: 'web' },
      ctx,
      { signal: new AbortController().signal },
    );
    expect(res.kit).toBe('cyberpunk-neon');
    expect(res.stack).toBe('web');
    expect(res.output).toContain('## Stack: web');
    expect(res.output).not.toContain('## Stack: flutter');
    expect(res.output).toMatch(/oklch/);
    expect(getDesignState(ctx)?.activeKit).toBe('cyberpunk-neon');

    // .design/ persistence (gitignored + self-ignoring).
    expect(existsSync(path.join(root, '.design', 'active.json'))).toBe(true);
    expect(existsSync(path.join(root, '.design', '.gitignore'))).toBe(true);
    const active = JSON.parse(await fs.readFile(path.join(root, '.design', 'active.json'), 'utf8'));
    expect(active.kit).toBe('cyberpunk-neon');
    const decisions = await fs.readFile(path.join(root, '.design', 'decisions.md'), 'utf8');
    expect(decisions).toContain('kit=cyberpunk-neon');

    // After a pin the injector shrinks to a one-line reminder.
    const out2 = await inject.handler(baseReq, async (r) => r);
    expect(out2.system[1].text).toMatch(/Active design kit: cyberpunk-neon/);
  });

  it('set override → materialize writes a real theme file → verify flags drift', async () => {
    const sigCtx = { signal: new AbortController().signal };
    const ctx = { projectRoot: root, meta: {} } as any;

    // Pin a kit for web.
    await designTool.execute({ action: 'use', kit: 'minimal-clarity', stack: 'web' }, ctx, sigCtx);

    // Override the primary color (structured).
    const setRes = await designTool.execute(
      { action: 'set', set: { primary: 'oklch(62.79% 0.2577 29.23)' } },
      ctx,
      sigCtx,
    );
    expect(setRes.output).toMatch(/primary=/);

    // Materialize → writes a CSS file carrying the overridden token.
    const mat = await designTool.execute(
      { action: 'materialize', stack: 'web', out: 'src/styles/tokens.css' },
      ctx,
      sigCtx,
    );
    expect(mat.path).toBe('src/styles/tokens.css');
    const css = await fs.readFile(path.join(root, 'src/styles/tokens.css'), 'utf8');
    expect(css).toContain(':root');
    expect(css).toContain('@theme inline');
    expect(css).toContain('--primary: oklch(62.79% 0.2577 29.23)'); // override won

    // Verify: an off-palette file is flagged; the materialized vars are clean.
    await fs.writeFile(path.join(root, 'bad.css'), '.x { color: #123456; background: #abcdef; }');
    const ver = await designTool.execute({ action: 'verify', files: ['bad.css'] }, ctx, sigCtx);
    expect(ver.violations).toBeGreaterThanOrEqual(2);
    expect((ver.score ?? 1) < 1).toBe(true);
    expect(ver.output).toMatch(/off-palette/);
  });
});
