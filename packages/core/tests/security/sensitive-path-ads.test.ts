import { describe, expect, it } from 'vitest';
import { inputPathLooksSensitive } from '../../src/security/permission-helpers.js';

/**
 * Regression for the NTFS alternate-data-stream bypass found by the 2026-08-20
 * security-check audit.
 *
 * On Windows `fs` resolves `.env::$DATA` to the same file as `.env`, but every
 * sensitive-path pattern is `$`-anchored so the suffix made them all miss.
 * `read` is `permission: 'auto'`, so `{"path": ".env::$DATA"}` was a silent
 * credential read with no prompt.
 *
 * The detection is pure string work, so these assertions hold on every
 * platform even though the underlying filesystem behaviour is Windows-only.
 */

describe('an ADS suffix cannot hide a sensitive path', () => {
  it.each([
    '.env::$DATA',
    '.env:hidden',
    '.env:hidden:$DATA',
    'C:/Users/me/project/.env::$DATA',
    'C:\\Users\\me\\project\\.env::$DATA',
    '/home/me/.aws/credentials::$DATA',
    '.npmrc::$DATA',
    'id_rsa::$DATA',
  ])('still flags %s', (p) => {
    expect(inputPathLooksSensitive({ path: p })).toBe(true);
  });

  it.each(['.env', '.npmrc', '/home/me/.aws/credentials', 'C:/Users/me/.kube/config'])(
    'still flags the plain form %s',
    (p) => {
      expect(inputPathLooksSensitive({ path: p })).toBe(true);
    },
  );
});

describe('the ADS strip does not create false positives', () => {
  it.each([
    'src/index.ts',
    'C:/Users/me/notes.md',
    'C:\\Users\\me\\notes.md',
    'package.json',
    // A bare drive spec must survive normalization — the colon there is not a
    // stream separator.
    'C:',
    'C:/',
  ])('does not flag %s', (p) => {
    expect(inputPathLooksSensitive({ path: p })).toBe(false);
  });
});
