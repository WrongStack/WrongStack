import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadActiveKit, loadCapturedTokens } from '@wrongstack/core/design';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { designTool } from '../src/design.js';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-tool-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: root, tools: [], projectRoot: root, meta: {} }) as any;
const opts = { signal: new AbortController().signal };

describe('designTool', () => {
  it('is confirmation-gated because some actions persist project design state', () => {
    expect(designTool.permission).toBe('confirm');
    expect(designTool.mutating).toBe(true);
    expect(designTool.capabilities).toEqual(['fs.write']);
  });

  it('lists the bundled kit menu by default', async () => {
    const ctx = makeCtx();
    const res = await designTool.execute({}, ctx, opts);
    expect(res.action).toBe('list');
    expect(res.output).toContain('minimal-clarity');
    expect(res.output).not.toContain('_foundations');
  });

  it('loads a kit body for a stack and pins it active on ctx.meta', async () => {
    const ctx = makeCtx();
    const res = await designTool.execute(
      { action: 'use', kit: 'neo-brutalist', stack: 'web' },
      ctx,
      opts,
    );
    expect(res.action).toBe('use');
    expect(res.kit).toBe('neo-brutalist');
    expect(res.stack).toBe('web');
    expect(res.output).toMatch(/Active design kit/i);
    expect(res.output).toContain('## Stack: web');
    expect(res.output).not.toContain('## Stack: flutter');
    // tokens snapshot included
    expect(res.output).toMatch(/oklch/);
    // active kit recorded for the request middleware / UI pickers
    expect((ctx.meta.designStudio as any)?.activeKit).toBe('neo-brutalist');
  });

  it('rejects an unsupported kit stack without replacing the active choice', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-stack-'));
    const ctx = { cwd: projectRoot, tools: [], projectRoot, meta: {} } as any;
    try {
      const selected = await designTool.execute(
        { action: 'use', kit: 'ios-native', stack: 'swiftui' },
        ctx,
        opts,
      );
      expect(selected.output).toContain('## Stack: swiftui');
      expect((await loadActiveKit(projectRoot))?.stack).toBe('swiftui');

      await expect(
        designTool.execute({ action: 'use', kit: 'ios-native', stack: 'compose' }, ctx, opts),
      ).rejects.toThrow(/does not support stack "compose"/i);
      expect((ctx.meta.designStudio as { stack?: string }).stack).toBe('swiftui');
      expect((await loadActiveKit(projectRoot))?.stack).toBe('swiftui');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('deals three kits and asks for a reason before pinning one outside the deal', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-deal-'));
    const ctx = { cwd: projectRoot, tools: [], projectRoot, meta: {} } as any;
    try {
      const dealt = await designTool.execute({ action: 'deal', seed: 'fixed' }, ctx, opts);
      expect(dealt.output).toContain('seed "fixed"');
      const ids = [...dealt.output.matchAll(/\*\*([a-z0-9-]+)\*\*/g)].map((m) => m[1] as string);
      expect(ids).toHaveLength(3);
      // Reproducible from the printed seed.
      const again = await designTool.execute(
        { action: 'deal', seed: 'fixed' },
        { ...ctx, meta: {} },
        opts,
      );
      expect(again.output).toBe(dealt.output);

      const outside = ['minimal-clarity', 'neo-brutalist', 'ios-native'].find(
        (k) => !ids.includes(k),
      );
      await expect(designTool.execute({ action: 'use', kit: outside }, ctx, opts)).rejects.toThrow(
        /outside this session's deal[\s\S]*reason/,
      );
      expect(await loadActiveKit(projectRoot)).toBeUndefined();

      const withReason = await designTool.execute(
        { action: 'use', kit: outside, reason: 'the brand already ships this look' },
        ctx,
        opts,
      );
      expect(withReason.output).toContain(
        'Chosen outside the deal: the brand already ships this look',
      );
      const inDeal = await designTool.execute({ action: 'use', kit: ids[0] }, ctx, opts);
      expect(inDeal.output).not.toContain('Chosen outside the deal');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('diffs two DESIGN.md versions and flags a contrast regression', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-diff-'));
    const ctx = { cwd: projectRoot, tools: [], projectRoot, meta: {} } as any;
    try {
      await designTool.execute({ action: 'use', kit: 'minimal-clarity' }, ctx, opts);
      await designTool.execute({ action: 'document', out: 'docs/before.md' }, ctx, opts);
      const text = await fs.readFile(path.join(projectRoot, 'docs/before.md'), 'utf8');
      // Same system against itself: nothing to report.
      const same = await designTool.execute(
        { action: 'diff', files: ['docs/before.md'] },
        ctx,
        opts,
      );
      expect(same.output).toContain('no token changes');
      // Wash the foreground out: the fg/bg pair loses AA.
      const fg = /\n {2}fg: "?([^"\n]+)"?/.exec(text)?.[1];
      expect(fg).toBeTruthy();
      await fs.writeFile(
        path.join(projectRoot, 'docs/after.md'),
        text.replace(/\n {2}fg: "?[^"\n]+"?/, '\n  fg: "#d4d4d4"'),
      );
      const res = await designTool.execute(
        { action: 'diff', files: ['docs/before.md', 'docs/after.md'] },
        ctx,
        opts,
      );
      expect(res.output).toMatch(/FAIL colors\.fg on bg: contrast/);
      expect(res.output).toContain('fix it or state why');
      await expect(
        designTool.execute({ action: 'diff', files: ['../outside.md'] }, ctx, opts),
      ).rejects.toThrow(/escape the project root/);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('throws (with the menu in the message) when an unknown kit is requested', async () => {
    const ctx = makeCtx();
    await expect(designTool.execute({ action: 'use', kit: 'nope' }, ctx, opts)).rejects.toThrow(
      /not found[\s\S]*minimal-clarity/i,
    );
  });

  it('throws when "set" is called without overrides', async () => {
    await expect(designTool.execute({ action: 'set' }, makeCtx(), opts)).rejects.toThrow(
      /no overrides given/i,
    );
  });

  it('throws when verify/materialize have no active kit to work from', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-bare-'));
    try {
      const ctx = { cwd: bare, tools: [], projectRoot: bare, meta: {} } as any;
      await expect(designTool.execute({ action: 'verify' }, ctx, opts)).rejects.toThrow(
        /no active kit/i,
      );
      await expect(designTool.execute({ action: 'materialize' }, ctx, opts)).rejects.toThrow(
        /no active kit/i,
      );
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it('returns the mandatory foundations baseline', async () => {
    const ctx = makeCtx();
    const res = await designTool.execute({ action: 'foundations', stack: 'web' }, ctx, opts);
    expect(res.action).toBe('foundations');
    expect(res.output).toMatch(/WCAG/);
  });

  it('blocks a ../ traversal escape in materialize out path (CWE-22)', async () => {
    const ctx = makeCtx();
    // Pin an active kit so materialize has tokens to write.
    await designTool.execute({ action: 'use', kit: 'minimal-clarity', stack: 'web' }, ctx, opts);

    // A caller-supplied out path that climbs out of the project root must be
    // refused before any file is written.
    const escapePath = path.join('..', '..', '..', '..', 'ws-design-escape.css');
    await expect(
      designTool.execute({ action: 'materialize', out: escapePath }, ctx, opts),
    ).rejects.toThrow(/escape the project root/i);

    // And nothing was written outside the root.
    const outside = path.resolve(root, escapePath);
    let wrote = true;
    try {
      await fs.access(outside);
    } catch {
      wrote = false;
    }
    expect(wrote).toBe(false);
  });

  // #249: dest and projectRoot are siblings under os.tmpdir() — the case
  // that used to pass through when realpath of the dest parent collapsed
  // onto a shared tmp mount. The containment check now realpaths both
  // sides and rejects any relative that starts with '..' or is absolute.
  it('blocks an absolute out path outside the project root', async () => {
    const ctx = makeCtx();
    await designTool.execute({ action: 'use', kit: 'minimal-clarity', stack: 'web' }, ctx, opts);

    const abs = path.join(os.tmpdir(), `ws-design-abs-${Date.now()}.css`);
    await expect(
      designTool.execute({ action: 'materialize', out: abs }, ctx, opts),
    ).rejects.toThrow(/escape the project root/i);
    let wrote = true;
    try {
      await fs.access(abs);
    } catch {
      wrote = false;
    }
    expect(wrote).toBe(false);
  });

  // The materialize guard matches `rel === '..'` or a '..<sep>' prefix — not a
  // bare startsWith('..'): in-root names like "..hidden/theme.css" produce rel
  // values that merely begin with ".." yet are legal project-relative paths.
  it('allows in-root out paths whose names start with ".."', async () => {
    const ctx = makeCtx();
    await designTool.execute({ action: 'use', kit: 'minimal-clarity', stack: 'web' }, ctx, opts);

    const nested = await designTool.execute(
      { action: 'materialize', out: '..hidden/theme.css' },
      ctx,
      opts,
    );
    expect(nested.action).toBe('materialize');
    // Landed inside the project root, not beside it.
    const css = await fs.readFile(path.join(root, '..hidden', 'theme.css'), 'utf8');
    expect(css.length).toBeGreaterThan(0);

    const flat = await designTool.execute(
      { action: 'materialize', out: '..tokens.css' },
      ctx,
      opts,
    );
    expect(flat.action).toBe('materialize');
    await fs.access(path.join(root, '..tokens.css'));
  });

  // Symmetry with the materialize guard above: verify's explicit `files` are
  // documented as project-relative, but a ../ climb or an absolute outside
  // path was resolved and read as-is — and the report echoes file:line +
  // snippet, so an escaped read leaks outside content into the tool output.
  it('blocks ../ and absolute traversal escapes in verify files (CWE-22)', async () => {
    const ctx = makeCtx();
    await designTool.execute({ action: 'use', kit: 'minimal-clarity', stack: 'web' }, ctx, opts);

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-verify-out-'));
    try {
      const outsideFile = path.join(outside, 'secret.css');
      await fs.writeFile(outsideFile, '.leak { color: #123123; }\n');
      const relEscape = path.relative(root, outsideFile).split(path.sep).join('/');
      expect(relEscape.startsWith('..')).toBe(true);
      await expect(
        designTool.execute({ action: 'verify', files: [relEscape] }, ctx, opts),
      ).rejects.toThrow(/escape the project root/i);
      await expect(
        designTool.execute({ action: 'verify', files: [outsideFile] }, ctx, opts),
      ).rejects.toThrow(/escape the project root/i);

      // In-root files still scan and report normally.
      await fs.mkdir(path.join(root, 'verify-inroot'), { recursive: true });
      await fs.writeFile(path.join(root, 'verify-inroot', 'app.css'), '.btn { color: #123123; }\n');
      const res = await designTool.execute(
        { action: 'verify', files: ['verify-inroot/app.css'] },
        ctx,
        opts,
      );
      expect(res.violations ?? 0).toBeGreaterThan(0);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('tune resolves high-level knobs and flows into materialize', async () => {
    const ctx = makeCtx();
    await designTool.execute({ action: 'use', kit: 'linear-dark', stack: 'web' }, ctx, opts);
    const tuned = await designTool.execute(
      { action: 'tune', tune: { radius: 'lg', density: 'compact' } },
      ctx,
      opts,
    );
    expect(tuned.output).toMatch(/Tuned/);
    expect(tuned.output).toContain('radius-md=0.75rem');
    // Materialize picks up the tuned overrides in the generated CSS.
    const mat = await designTool.execute(
      { action: 'materialize', out: 'tuned.css', force: true },
      ctx,
      opts,
    );
    const css = await fs.readFile(path.join(root, 'tuned.css'), 'utf8');
    expect(css).toContain('--radius-md: 0.75rem;');
    expect(css).toContain('--spacing-4: 0.8rem;'); // compact density
    expect(mat.output).toMatch(/Wrote/);

    // Refusing to clobber without force is a failed call, not an ok result.
    await expect(
      designTool.execute({ action: 'materialize', out: 'tuned.css' }, ctx, opts),
    ).rejects.toThrow(/already exists/);
  });

  // ── The verify summary must be axis-aware: the remediation footer and the
  // unchecked caveat describe the PALETTE axis, and must not make claims the
  // radius/spacing/type axes refute. ──

  it('does not claim a file went unchecked when its radius/type axes flagged it', async () => {
    const ctx = makeCtx();
    await designTool.execute({ action: 'use', kit: 'minimal-clarity', stack: 'web' }, ctx, opts);
    // No className, no color literal, no color function: the palette axis has
    // nothing here — but the radius and type axes still scan the file.
    await fs.writeFile(
      path.join(root, 'styles.css'),
      '.card {\n  border-radius: 8px;\n  font-family: Arial, sans-serif;\n}\n',
    );

    const res = await designTool.execute({ action: 'verify', files: ['styles.css'] }, ctx, opts);

    // Sanity: the file WAS checked and flagged by the non-color axes…
    expect(res.output).toContain('hardcoded radius');
    expect(res.output).toMatch(/hardcoded font family/);
    // …so the summary must not claim it went unchecked.
    expect(res.output).not.toMatch(/were NOT checked/);
  });

  it('does not tell a 100%-on-palette report to replace off-palette colors', async () => {
    const ctx = makeCtx();
    await designTool.execute({ action: 'use', kit: 'minimal-clarity', stack: 'web' }, ctx, opts);
    // Token-clean slop: 100% on-palette, composition-axis hit only.
    await fs.writeFile(
      path.join(root, 'hero.tsx'),
      '<h1 className="bg-clip-text text-transparent">Hi</h1>\n',
    );

    const res = await designTool.execute({ action: 'verify', files: ['hero.tsx'] }, ctx, opts);

    expect(res.output).toMatch(/composition finding/);
    // The color remediation contradicts the composition advice on a report
    // with zero color violations.
    expect(res.output).not.toContain('Replace off-palette colors');
  });

  // ── WCAG AA contrast gate: warn (never block) on sub-4.5:1 pairs ──────────

  it('warns at use time when a set override breaks AA, and stays silent when clean', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-contrast-'));
    const ctx = { cwd: projectRoot, tools: [], projectRoot, meta: {} } as any;
    try {
      const res = await designTool.execute(
        {
          action: 'use',
          kit: 'minimal-clarity',
          stack: 'web',
          // Near-white primary on minimal-clarity's oklch(99% 0 0) light bg.
          set: { 'light.primary': 'oklch(95% 0.02 250)' },
        },
        ctx,
        opts,
      );
      const warnLine = res.output.split('\n').find((l) => l.includes('WCAG AA contrast'));
      expect(warnLine).toBeDefined();
      expect(warnLine).toMatch(/light primary\/bg = \d+\.\d+:1/);
      // The dark theme was not overridden — it must not appear in the warning.
      expect(warnLine).not.toContain('dark');

      // The same kit WITHOUT overrides must not warn.
      const clean = await designTool.execute(
        { action: 'use', kit: 'minimal-clarity', stack: 'web' },
        { cwd: root, tools: [], projectRoot: root, meta: {} } as any,
        opts,
      );
      expect(clean.output).not.toContain('WCAG AA contrast:');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('materialize still writes the theme file but appends the contrast warning', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-contrast2-'));
    const ctx = { cwd: projectRoot, tools: [], projectRoot, meta: {} } as any;
    try {
      await designTool.execute({ action: 'use', kit: 'minimal-clarity', stack: 'web' }, ctx, opts);
      await designTool.execute(
        { action: 'set', set: { 'light.primary': 'oklch(95% 0.02 250)' } },
        ctx,
        opts,
      );
      const mat = await designTool.execute({ action: 'materialize', out: 'tokens.css' }, ctx, opts);
      // Warn, never block: the file is written AND the warning is appended.
      expect(mat.output).toMatch(/Wrote/);
      expect(mat.output).toMatch(/WCAG AA contrast/);
      expect(mat.output).toMatch(/light primary\/bg/);
      const css = await fs.readFile(path.join(projectRoot, 'tokens.css'), 'utf8');
      expect(css).toContain('--primary');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  // ── Kit-less verify: captured project tokens ───────────────────────────────

  it('capture snapshots a CSS token source and verify runs against it without a kit', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-cap-'));
    const ctx = { cwd: projectRoot, tools: [], projectRoot, meta: {} } as any;
    try {
      await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(projectRoot, 'src', 'index.css'),
        [
          ':root {',
          '  --primary: 222 47% 11%;',
          '  --background: oklch(99% 0 0);',
          '  --radius-md: 0.5rem;',
          '}',
          '.dark {',
          '  --primary: 210 40% 96%;',
          '}',
          '',
        ].join('\n'),
      );

      const cap = await designTool.execute({ action: 'capture' }, ctx, opts);
      expect(cap.action).toBe('capture');
      expect(cap.output).toMatch(/Captured \d+ token value\(s\)/);
      expect(cap.path).toContain('captured-tokens.json');
      const persisted = await loadCapturedTokens(projectRoot);
      expect(persisted?.tokens.light?.['primary']).toMatch(/^#/);
      // Dark overlays light: primary flipped by .dark, background inherited.
      expect(persisted?.tokens.dark?.['primary']).not.toBe(persisted?.tokens.light?.['primary']);
      expect(persisted?.tokens.dark?.['background']).toBe('oklch(99% 0 0)');

      // Drift check WITHOUT a pinned kit: an off-capture hex must be flagged.
      await fs.writeFile(path.join(projectRoot, 'app.css'), '.x { color: #123123; }\n');
      const res = await designTool.execute({ action: 'verify', files: ['app.css'] }, ctx, opts);
      expect(res.source).toBe('captured');
      expect(res.kit).toBeUndefined();
      expect(res.output).toMatch(/captured tokens/);
      expect(res.violations ?? 0).toBeGreaterThan(0);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('verify with no kit and no capture still fails with actionable guidance', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-bare2-'));
    try {
      const ctx = { cwd: bare, tools: [], projectRoot: bare, meta: {} } as any;
      await expect(designTool.execute({ action: 'verify' }, ctx, opts)).rejects.toThrow(
        /no active kit, no captured tokens/i,
      );
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it('documents the pinned kit as DESIGN.md, which a kit-less project can capture and verify against', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-doc-'));
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-doc2-'));
    try {
      const ctx = { cwd: src, tools: [], projectRoot: src, meta: {} } as any;
      await designTool.execute({ action: 'use', kit: 'minimal-clarity', stack: 'web' }, ctx, opts);
      const doc = await designTool.execute({ action: 'document' }, ctx, opts);
      expect(doc.path).toBe('DESIGN.md');
      expect(doc.output).toContain('Lint: clean.');
      const md = await fs.readFile(path.join(src, 'DESIGN.md'), 'utf8');
      expect(md).toMatch(/^---\nversion: alpha\nname: /);
      await expect(designTool.execute({ action: 'document' }, ctx, opts)).rejects.toThrow(
        /already exists/,
      );
      await expect(
        designTool.execute({ action: 'document', out: '../escape.md' }, ctx, opts),
      ).rejects.toThrow(/escape the project root/);

      // A different project with no kit adopts the file as its token source.
      await fs.writeFile(path.join(other, 'DESIGN.md'), md);
      const octx = { cwd: other, tools: [], projectRoot: other, meta: {} } as any;
      const cap = await designTool.execute({ action: 'capture' }, octx, opts);
      expect(cap.output).toContain('from DESIGN.md');
      await fs.mkdir(path.join(other, 'src'));
      await fs.writeFile(
        path.join(other, 'src', 'App.tsx'),
        'export const A = () => <div className="bg-blue-500" />;\n',
      );
      const verify = await designTool.execute({ action: 'verify' }, octx, opts);
      expect(verify.source).toBe('captured');
      expect(verify.output).toContain('[color.generic-utility]');

      // Kit-less materialize compiles the captured DESIGN.md tokens directly into CSS.
      const mat = await designTool.execute(
        { action: 'materialize', stack: 'web', out: 'src/styles/tokens.css' },
        octx,
        opts,
      );
      expect(mat.kit).toBeUndefined();
      expect(mat.path).toBe('src/styles/tokens.css');
      expect(mat.output).toContain('captured palette');
      const css = await fs.readFile(path.join(other, 'src', 'styles', 'tokens.css'), 'utf8');
      expect(css).toContain(':root');
      expect(css).toContain('.dark');
    } finally {
      await fs.rm(src, { recursive: true, force: true });
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('draws job-native anatomy and materializes photo treatment CSS for Material kits', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-draw-mat-'));
    try {
      const ctx = { cwd: tmp, tools: [], projectRoot: tmp, meta: {} } as any;
      const used = await designTool.execute(
        { action: 'use', kit: 'atelier', stack: 'web' },
        ctx,
        opts,
      );
      expect(used.output).toContain('Axes: light/roman-serif/cool');
      expect(used.output).toContain('Photo treatment:');

      const drawn = await designTool.execute(
        { action: 'draw', job: 'visit', material: 'photo', seed: 'bakery-1' },
        ctx,
        opts,
      );
      expect(drawn.action).toBe('draw');
      expect(drawn.output).toContain('Macrostructure');
      expect(drawn.output).toContain('[data-slot="hero"]');

      const mat = await designTool.execute(
        { action: 'materialize', stack: 'web', out: 'src/styles/atelier.css' },
        ctx,
        opts,
      );
      const css = await fs.readFile(path.join(tmp, mat.path!), 'utf8');
      expect(css).toContain('[data-slot] > img');
      expect(css).toContain('fonts.googleapis.com');

      const photos = await designTool.execute(
        { action: 'photos', query: 'sourdough bakery oven; espresso terrace', orient: 'landscape' },
        ctx,
        opts,
      );
      expect(photos.action).toBe('photos');
      expect(photos.output).toContain('data-slot="hero"');
      expect(photos.output).toContain('data-credits');
      expect(photos.output).toContain('Wikimedia Commons');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
