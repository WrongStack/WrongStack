import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

type ExportEntry = { types?: string; import?: string } | string;

const pkgRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(pkgRoot, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
  exports: Record<string, ExportEntry>;
};

describe('@wrongstack/runtime subpath exports', () => {
  it('publishes the subpaths used by CLI and TUI', () => {
    expect(pkg.exports).toHaveProperty('./vision');
    expect(pkg.exports).toHaveProperty('./clipboard');
    expect(pkg.exports).toHaveProperty('./host');
    expect(pkg.exports).toHaveProperty('./pack');
    expect(pkg.exports).toHaveProperty('./tool-registration');
  });

  it('every declared JS export points at a built dist file', () => {
    const missing: string[] = [];
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      if (typeof entry === 'string' || !entry.import) continue;
      const filePath = path.resolve(pkgRoot, entry.import);
      if (!fs.existsSync(filePath)) {
        missing.push(`${subpath} -> ${entry.import}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // These MUST stay as dynamic imports inside the test body: resolution
  // through Node's package-exports map at runtime is the behavior under
  // test. Static imports would be resolved by Vite during transform instead.
  //
  // Timeout: the dynamic import lands on `dist/` JS whose `@wrongstack/core/*`
  // specifiers the vitest aliases redirect to core SOURCE, so the first
  // import pays a cold on-the-fly transform of the core module graph
  // (~5-6s warm-cache-free; the barrel test below then rides the cache at
  // <1s). The default 5000ms per-test timeout cuts that off — observed as a
  // spurious "import timed out" failure. 30s leaves headroom for CI runners
  // under parallel load. Plain Node resolves all three in <600ms, so this
  // guards only the transform cost, never a real hang.
  it('runtime subpath imports resolve through Node package exports', async () => {
    const vision = await import('@wrongstack/runtime/vision');
    expect(typeof vision.routeImagesForModel).toBe('function');

    const clipboard = await import('@wrongstack/runtime/clipboard');
    expect(typeof clipboard.readClipboardImage).toBe('function');

    const registration = await import('@wrongstack/runtime/tool-registration');
    expect(typeof registration.registerCanonicalHostTools).toBe('function');
  }, 30_000);

  it('exposes probeLocalLlm from the main barrel', async () => {
    const runtime = await import('@wrongstack/runtime');
    expect(typeof runtime.probeLocalLlm).toBe('function');
  });
});
