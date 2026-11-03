import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBrandSource } from '../scripts/sync-brand';
import { brandDefaultPalette, brandNeutrals, brandPalettes } from '../src/brand-palettes';

const root = resolve(import.meta.dirname, '../../..');
describe('canonical WrongStack brand parity', () => {
  it('keeps all named pairs, both mode token sets, and the default aligned with WebUI', () => {
    const source = readBrandSource();
    expect(brandPalettes.length).toBe(13);
    expect(brandPalettes).toEqual(source.palettes);
    expect(brandNeutrals).toEqual(source.base);
    expect(brandDefaultPalette).toBe(source.defaultPalette);
  });
  it('ships the original mark, app logo, and native icons without altering their bytes', () => {
    for (const [source, target] of [
      ['packages/webui/public/wrongstack.svg', 'public/wrongstack.svg'],
      ['website/public/wrongstack-mark.svg', 'public/wrongstack-mark.svg'],
    ])
      expect(readFileSync(resolve(root, 'apps/desktop-v2', target!))).toEqual(
        readFileSync(resolve(root, source!)),
      );
    // Desktop v2 owns the original native assets, independently of the legacy shell.
    for (const [file, digest] of [
      ['icon.ico', 'a353691c1f9c021d869f3551c9e8a61cfee7957323bd10ab754fa436feb0756c'],
      ['icon.png', '51083f44275fceac907c2f1e66b9bb6360f4aff6cb4f7f6878e80f1fea90715b'],
    ])
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(root, 'apps/desktop-v2/src-tauri/icons', file!)))
          .digest('hex'),
      ).toBe(digest);
  });
  it('ships the WebUI provider logos and their license unchanged, for the shared setup screen', () => {
    const webui = resolve(root, 'packages/webui/public/provider-logos');
    const desktop = resolve(root, 'apps/desktop-v2/public/provider-logos');
    const files = readdirSync(webui).sort();
    expect(files).toContain('LICENSE');
    expect(readdirSync(desktop).sort()).toEqual(files);
    for (const file of files)
      expect(readFileSync(resolve(desktop, file))).toEqual(readFileSync(resolve(webui, file)));
  });
});
