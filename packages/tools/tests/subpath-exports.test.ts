import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * L3-A: verify the package.json exports map and the built dist match,
 * so users can `import { bashTool } from '@wrongstack/tools/bash'`
 * without a runtime resolution failure.
 */

const pkgPath = path.resolve(__dirname, '..', 'package.json');
const distDir = path.resolve(__dirname, '..', 'dist');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
  exports: Record<string, { types: string; import: string }>;
};

describe('per-tool subpath exports (L3-A)', () => {
  it('every declared subpath has a corresponding dist file', () => {
    const missing: string[] = [];
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      // entry.import is relative to package root: "./dist/foo.js"
      const filePath = path.resolve(path.dirname(pkgPath), entry.import);
      if (!fs.existsSync(filePath)) {
        missing.push(`${subpath} → ${entry.import}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every dist tool file is reachable via at least one exports entry', () => {
    const expectedSubpathFiles = new Set(
      Object.values(pkg.exports).map((e) => path.basename(e.import)),
    );
    const distFiles = fs
      .readdirSync(distDir)
      .filter((f) => f.endsWith('.js') && !f.startsWith('_') && !f.endsWith('.map'));
    // Internal helper chunks (anything with a hash suffix) and the index/builtin
    // bundles are allowed to be present without an export entry.
    const orphan = distFiles.filter(
      (f) => !expectedSubpathFiles.has(f) && !/-[A-Za-z0-9_-]{6,}\.js$/.test(f), // bundler chunk
    );
    expect(orphan).toEqual([]);
  });

  it('subpath imports actually resolve at runtime', async () => {
    // Dynamic import via node's resolver to confirm exports map.
    const { bashTool } = await import('@wrongstack/tools/bash');
    expect(bashTool.name).toBe('bash');
    const { readTool } = await import('@wrongstack/tools/read');
    expect(readTool.name).toBe('read');
    const tier = await import('@wrongstack/tools/tool-tier');
    expect(typeof tier.registerBuiltinToolTier).toBe('function');
  });

  it('codebase-index subpath exports all tools including calls tools', async () => {
    const mod = await import('@wrongstack/tools/codebase-index');
    // Existing tools
    expect(mod.codebaseIndexTool.name).toBe('codebase-index');
    expect(mod.codebaseSearchTool.name).toBe('codebase-search');
    expect(mod.codebaseStatsTool.name).toBe('codebase-stats');
    expect(mod.deadCodeScanTool.name).toBe('dead-code-scan');
    // New calls tools
    expect(mod.codebaseIncomingCallsTool.name).toBe('codebase-incoming-calls');
    expect(mod.codebaseOutgoingCallsTool.name).toBe('codebase-outgoing-calls');
    // CallSite type is exported (runtime check: it's in the module namespace)
    expect(mod.CallSite).toBeUndefined(); // type-only export, not a runtime value
  });
});
