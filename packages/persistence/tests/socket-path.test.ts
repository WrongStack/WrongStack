import { describe, expect, it } from 'vitest';
import {
  assertUnixSocketPathWithinLimit,
  checkUnixSocketPath,
  unixSocketPathLimit,
} from '../src/socket-path.js';

/** Canonical macOS per-user temp dir shape: /var/folders/<2>/<30>/T (48 bytes). */
const MACOS_TMPDIR = '/var/folders/zz/abcdefghijklmnopqrstuvwxyz0123/T';

describe('unixSocketPathLimit', () => {
  it('returns the BSD-family limit for darwin', () => {
    expect(unixSocketPathLimit('darwin')).toBe(103);
    expect(unixSocketPathLimit('freebsd')).toBe(103);
    expect(unixSocketPathLimit('openbsd')).toBe(103);
  });

  it('returns the Linux-family limit otherwise', () => {
    expect(unixSocketPathLimit('linux')).toBe(107);
    expect(unixSocketPathLimit('sunos')).toBe(107);
  });
});

describe('checkUnixSocketPath', () => {
  it('always passes on win32 (named pipes have no sun_path)', () => {
    const pipe = `\\\\.\\pipe\\wrongstack-codebase-index-v1-${'a'.repeat(200)}`;
    expect(checkUnixSocketPath(pipe, 'win32').ok).toBe(true);
  });

  it('accepts a path at exactly the platform limit', () => {
    const at = '/'.padEnd(103, 'a');
    expect(Buffer.byteLength(at)).toBe(103);
    expect(checkUnixSocketPath(at, 'darwin')).toMatchObject({ ok: true, byteLength: 103 });
  });

  it('rejects one byte over the platform limit', () => {
    const over = '/'.padEnd(104, 'a');
    expect(checkUnixSocketPath(over, 'darwin')).toMatchObject({
      ok: false,
      byteLength: 104,
      maxBytes: 103,
    });
    // The same path is fine on Linux.
    expect(checkUnixSocketPath(over, 'linux').ok).toBe(true);
  });

  it('counts bytes, not code units, for non-ASCII temp paths', () => {
    const unicode = `/tmp/würm-${'ü'.repeat(50)}.sock`;
    const check = checkUnixSocketPath(unicode, 'darwin');
    expect(check.byteLength).toBe(Buffer.byteLength(unicode, 'utf8'));
    expect(check.byteLength).toBeGreaterThan(unicode.length);
  });

  it('flags the legacy codebase-index layout on macOS and passes the flat one', () => {
    const key = 'a'.repeat(24);
    const legacy = `${MACOS_TMPDIR}/wrongstack-codebase-index-v1/${key}.sock`;
    const flat = `${MACOS_TMPDIR}/wsci-v1-${key}.sock`;
    expect(checkUnixSocketPath(legacy, 'darwin').ok).toBe(false);
    expect(checkUnixSocketPath(flat, 'darwin').ok).toBe(true);
    expect(Buffer.byteLength(flat)).toBeLessThan(100);
  });
});

describe('assertUnixSocketPathWithinLimit', () => {
  it('is silent within the limit', () => {
    expect(() =>
      assertUnixSocketPathWithinLimit(
        `${MACOS_TMPDIR}/wsci-v1-abc.sock`,
        'codebase-index',
        'darwin',
      ),
    ).not.toThrow();
  });

  it('names the service, byte counts, and remedy when over', () => {
    const over = '/'.padEnd(110, 'a');
    expect(() => assertUnixSocketPathWithinLimit(over, 'kanban', 'darwin')).toThrowError(
      /kanban IPC socket path is 110 bytes, over the darwin sun_path limit of 103 usable bytes/,
    );
    expect(() => assertUnixSocketPathWithinLimit(over, 'kanban', 'darwin')).toThrowError(
      /shorter TMPDIR/,
    );
  });
});
