/**
 * The canonical single-path-segment rule (WS-019 → shared for WS-015).
 *
 * Two surfaces now depend on this being right: the HQ transcript route and the
 * ACP session store. The point of hoisting it was to stop the rule from
 * existing in two places and drifting; these tests are what make that hoist
 * worth anything.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_PATH_SEGMENT_LENGTH, decodeSessionIdStrict, isSafePathSegment, isSafeSessionId, resolveContainedPath } from '../../src/utils/path-segment.js';

describe('isSafePathSegment', () => {
  it('rejects the traversal segments', () => {
    expect(isSafePathSegment('..')).toBe(false);
    expect(isSafePathSegment('.')).toBe(false);
  });

  it('rejects BOTH separators, not just the platform one', () => {
    // Windows accepts '/' as well as '\\', so checking only path.sep is a
    // platform-specific hole that passes CI on Linux.
    expect(isSafePathSegment('a/b')).toBe(false);
    expect(isSafePathSegment('a\\b')).toBe(false);
    expect(isSafePathSegment('../x')).toBe(false);
    expect(isSafePathSegment('..\\x')).toBe(false);
  });

  it('rejects NUL and colon', () => {
    // NUL truncates the path in some syscalls; ':' is Windows drive-relative
    // addressing and NTFS alternate data streams.
    expect(isSafePathSegment('a\0b')).toBe(false);
    expect(isSafePathSegment('C:evil')).toBe(false);
    expect(isSafePathSegment('file.txt:stream')).toBe(false);
  });

  it('rejects empty and over-long input', () => {
    expect(isSafePathSegment('')).toBe(false);
    expect(isSafePathSegment('a'.repeat(MAX_PATH_SEGMENT_LENGTH))).toBe(true);
    expect(isSafePathSegment('a'.repeat(MAX_PATH_SEGMENT_LENGTH + 1))).toBe(false);
  });

  it('accepts the id shapes the product actually generates', () => {
    expect(isSafePathSegment('leader')).toBe(true);
    expect(isSafePathSegment('01JQ8Z0000000000000000')).toBe(true);
    expect(isSafePathSegment('sess_3_0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isSafePathSegment('scout#12345')).toBe(true);
    expect(isSafePathSegment('a-b_c.json')).toBe(true);
    // A leading dot is fine — only the bare '.' and '..' are traversal.
    expect(isSafePathSegment('.hidden')).toBe(true);
    expect(isSafePathSegment('...')).toBe(true);
  });
});

describe('resolveContainedPath', () => {
  const root = path.resolve('/srv/data');

  it('resolves a safe segment under the root', () => {
    expect(resolveContainedPath(root, 'file.json')).toBe(path.join(root, 'file.json'));
    expect(resolveContainedPath(root, 'a', 'b.json')).toBe(path.join(root, 'a', 'b.json'));
  });

  it('returns null for any unsafe segment', () => {
    expect(resolveContainedPath(root, '..')).toBeNull();
    expect(resolveContainedPath(root, '../etc')).toBeNull();
    expect(resolveContainedPath(root, 'a', '..', '..', 'etc')).toBeNull();
    expect(resolveContainedPath(root, '')).toBeNull();
  });

  it('returns null when given no segments — the root itself is not a target', () => {
    expect(resolveContainedPath(root)).toBeNull();
  });

  it('rejects an absolute segment that would discard the root', () => {
    // path.resolve(root, '/etc/passwd') === '/etc/passwd'. The segment rule
    // catches this first (separators), and the containment check is the
    // backstop if that rule is ever loosened.
    expect(resolveContainedPath(root, path.resolve('/etc/passwd'))).toBeNull();
  });

  it('is not fooled by a sibling directory sharing the root prefix', () => {
    // '/srv/data-other' starts with '/srv/data' as a STRING but is not inside
    // it — the separator in the comparison is what makes this correct.
    const contained = resolveContainedPath(root, 'x.json');
    expect(contained?.startsWith(`${root}${path.sep}`)).toBe(true);
    expect(resolveContainedPath(`${root}-other`, 'x.json')).toBe(
      path.join(`${root}-other`, 'x.json'),
    );
  });
});

describe('decodeSessionIdStrict / isSafeSessionId', () => {
  /**
   * The rule had split in two: HQ's `decodeSessionId` decoded and validated,
   * while `webui-server`'s same-named function decoded and — on a malformed
   * input — returned the RAW segment, checking nothing. The route patterns are
   * `([^/]+)`, which stops a literal slash but not `%2f`, so `..%2f..%2f`
   * decoded straight through to the handlers. Nothing below rejected it either;
   * the only thing in the way was `registry.get()` happening to miss and
   * answer 404. Containment by accident.
   *
   * These cases are the ones that used to pass.
   */
  it.each([
    ['2026-09-10%2Fsess_01J', '2026-09-10/sess_01J'],
    ['sess_01JABC', 'sess_01JABC'],
  ])('accepts the legitimate id %s', (input, expected) => {
    expect(decodeSessionIdStrict(input)).toBe(expected);
  });

  it.each([
    ['..%2f..%2fetc', 'encoded traversal'],
    ['%2e%2e%2f%2e%2e%2fetc', 'fully encoded traversal'],
    ['a%2Fb%2Fc', 'three components — deeper than the date shard allows'],
    ['..', 'bare parent'],
    ['a%00b', 'NUL truncation'],
    ['C:foo', 'windows drive-relative'],
    ['a%5Cb', 'backslash separator'],
    ['%E0%A4%A', 'malformed percent-encoding — used to return the raw segment'],
    ['', 'empty'],
  ])('rejects %s (%s)', (input) => {
    expect(decodeSessionIdStrict(input)).toBeNull();
  });

  it('validates AFTER decoding, which is the whole point', () => {
    // Pre-decode the string looks like an ordinary segment; the check has to
    // happen on the decoded value or it inspects the wrong thing.
    expect(isSafeSessionId('..%2f..%2fetc')).toBe(true);
    expect(decodeSessionIdStrict('..%2f..%2fetc')).toBeNull();
  });

  it('rejects a double-decoded traversal at the first decode', () => {
    // `vector-memory-handlers` ran the value through two decoders in a row, so
    // `%252e%252e%252f` survived the first pass as an innocuous `%2e%2e%2f`
    // and became `../` on the second. One decode, then validate.
    expect(decodeSessionIdStrict('%252e%252e%252fetc')).toBe('%2e%2e%2fetc');
    expect(decodeSessionIdStrict(decodeSessionIdStrict('%252e%252e%252fetc'))).toBeNull();
  });
});
