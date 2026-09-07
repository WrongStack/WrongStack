/**
 * Regression for I3 (TS-005): the previous pin was a single-file
 * `hashFileContents(entryPath)` so a plugin whose entry was
 * `dist/index.js` could have its sibling `dist/impl.js` rewritten with
 * the entry byte-identical — the trust gate reported "trusted" while
 * the loaded code was new. The fix hashes the entire directory
 * closure (sorted `relpath\0size\0sha256` triple, then SHA-256 the
 * manifest), so any sibling change moves the pin.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashPluginClosure } from '../src/wiring/external-plugins.js';

describe('I3 / hashPluginClosure — directory-level integrity', () => {
  it('changes when a sibling module is rewritten with the entry byte-identical', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'i3-closure-'));
    try {
      const entry = path.join(tmp, 'plugin.mjs');
      const sibling = path.join(tmp, 'impl.mjs');
      // First snapshot: entry imports a benign sibling.
      await fs.writeFile(entry, "export const x = 1;\n");
      await fs.writeFile(sibling, "export const y = 'safe';\n");
      const before = await hashPluginClosure(entry);
      expect(before).toMatch(/^[a-f0-9]{64}$/);

      // Re-write the sibling (the dangerous case — the entry is
      // untouched, the *sibling* changed). If the trust gate only
      // hashed the entry, this would have produced the same hash and
      // the new code would have loaded under the old pin.
      await fs.writeFile(sibling, "export const y = 'PWNED';\n");
      const after = await hashPluginClosure(entry);
      expect(after).not.toBe(before);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('is order-independent (walks sorted)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'i3-order-'));
    try {
      const a = path.join(tmp, 'a.mjs');
      const b = path.join(tmp, 'b.mjs');
      const c = path.join(tmp, 'c.mjs');
      await fs.writeFile(a, 'a');
      await fs.writeFile(b, 'b');
      await fs.writeFile(c, 'c');
      const h1 = await hashPluginClosure(a);
      const h2 = await hashPluginClosure(c);
      // Same closure (a,b,c) viewed from any entry must hash equal.
      expect(h1).toBe(h2);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
