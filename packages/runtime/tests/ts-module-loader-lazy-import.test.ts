import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importExternalPluginModule } from '../src/plugin-host.js';

// The Node type-strip fallback rewrites local `import('./x')` specifiers into its
// per-load closure directory. A dynamic import runs whenever the plugin calls it,
// usually long after the load returned, so the closure it points into must still exist.
describe('Node type-strip fallback: lazy local imports', () => {
  let dir = '';
  const identity = (code: string): string => code;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wstack-lazy-import-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves a local dynamic import executed after the load returned', async () => {
    await writeFile(join(dir, 'eager.ts'), "export const tag = 'eager';\n");
    await writeFile(join(dir, 'lazy.ts'), "export const tag = 'lazy';\n");
    await writeFile(
      join(dir, 'index.ts'),
      [
        "import { tag as eagerTag } from './eager.ts';",
        'export const eager = eagerTag;',
        "export async function lazy() { return (await import('./lazy.ts')).tag; }",
        "export default { name: 'lazy-import-plugin', apiVersion: '^0.1', setup() {} };",
      ].join('\n'),
    );

    const mod = (await importExternalPluginModule(pathToFileURL(join(dir, 'index.ts')).href, {
      reloadGeneration: 1,
      stripTypeScriptTypes: identity,
    })) as { eager: string; lazy: () => Promise<string> };

    expect(mod.eager).toBe('eager');
    await expect(mod.lazy()).resolves.toBe('lazy');
  });

  it('resolves a lazy import of the plugin SDK bridge executed after the load returned', async () => {
    await writeFile(
      join(dir, 'index.ts'),
      [
        "export async function sdk() { return typeof (await import('@wrongstack/plugin-sdk')).definePlugin; }",
        "export default { name: 'lazy-sdk-plugin', apiVersion: '^0.1', setup() {} };",
      ].join('\n'),
    );

    const mod = (await importExternalPluginModule(pathToFileURL(join(dir, 'index.ts')).href, {
      reloadGeneration: 1,
      stripTypeScriptTypes: identity,
    })) as { sdk: () => Promise<string> };

    await expect(mod.sdk()).resolves.toBe('function');
  });
});
