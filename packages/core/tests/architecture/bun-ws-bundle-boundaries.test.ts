import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
function javascriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(file) : entry.name.endsWith('.js') ? [file] : [];
  });
}

describe('published WebSocket bundle boundaries', () => {
  it('keeps provider definitions consumable by browser bundlers', async () => {
    const result = await build({
      entryPoints: [join(root, 'packages/providers/dist/provider-definitions.js')],
      bundle: true,
      platform: 'browser',
      write: false,
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    expect(result.outputFiles.length).toBeGreaterThan(0);
  });

  it.each(['packages/cli', 'packages/providers', 'packages/webui-server', 'apps/desktop'])(
    'does not expose private ws imports from %s',
    (name) => {
      const files = javascriptFiles(join(root, name, 'dist'));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(readFileSync(file, 'utf8'), file).not.toMatch(
          /(?:\bfrom\s*|\bimport\s*\(\s*)['"]ws\/native['"]/u,
        );
      }
    },
  );
});
