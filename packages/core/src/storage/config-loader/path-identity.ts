import * as path from 'node:path';

/**
 * Compare two absolute filesystem paths for identity. Normalizes separators and
 * `.`/`..` segments via `path.resolve`, and folds case on win32 (and darwin,
 * whose default APFS/HFS+ volumes are case-insensitive) so the same file
 * reached through differently-cased drive/dir spellings still compares equal —
 * the same Windows path-casing hazard that bit the core token symbols.
 */
export function samePath(a: string, b: string): boolean {
  let ra = path.resolve(a);
  let rb = path.resolve(b);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    ra = ra.toLowerCase();
    rb = rb.toLowerCase();
  }
  return ra === rb;
}
