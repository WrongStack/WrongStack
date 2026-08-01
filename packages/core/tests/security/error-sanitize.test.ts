/**
 * WS-066 / WS-060 / WS-063 — error text that leaves the process.
 *
 * `sanitizeApiError` lived in `packages/cli/src/hq-server/utils.ts`, so the
 * WebUI and SimpleUI servers — same JSON API surface, same browser on the other
 * end — never adopted it and answered with `String(err)`. These pin the shared
 * implementation both surfaces now import, and the two levels it offers:
 * opaque for HTTP bodies, scrubbed-but-readable for authenticated channels.
 */
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  ERROR_DETAIL_MAX,
  sanitizeApiError,
  scrubErrorDetail,
  scrubErrorText,
} from '../../src/security/error-sanitize.js';

describe('sanitizeApiError', () => {
  it('never echoes the original message', () => {
    const err = new Error('ENOENT: no such file or directory, open /home/me/.wrongstack/key.json');
    const out = sanitizeApiError(err);
    expect(out).toBe('resource not found');
    expect(out).not.toContain('.wrongstack');
    expect(out).not.toContain('/home/me');
  });

  it('classifies permission and parse failures without their text', () => {
    expect(sanitizeApiError(new Error('EACCES: permission denied, open C:\\Users\\me\\x'))).toBe(
      'permission denied',
    );
    expect(sanitizeApiError(new SyntaxError('Unexpected token } in JSON at position 42'))).toBe(
      'malformed data',
    );
  });

  it('falls back to an opaque label for anything else', () => {
    expect(sanitizeApiError(new Error('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA rejected'))).toBe(
      'internal error',
    );
    expect(sanitizeApiError('plain string throw')).toBe('internal error');
    expect(sanitizeApiError(undefined)).toBe('internal error');
  });

  it('survives a thrown value whose String() coercion itself throws', () => {
    const hostile = {
      toString() {
        throw new Error('nope');
      },
    };
    expect(sanitizeApiError(hostile)).toBe('internal error');
  });
});

describe('scrubErrorDetail', () => {
  it('redacts a credential quoted back by the thrower', () => {
    const out = scrubErrorDetail(
      new Error('upstream rejected Authorization: Bearer sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQ'),
    );
    expect(out).not.toContain('sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQ');
    // The message itself is preserved — this level is for authenticated
    // channels where the detail is the point.
    expect(out).toContain('upstream rejected');
  });

  it('rewrites the home directory to ~ so the OS account name does not leak', () => {
    const home = homedir();
    const out = scrubErrorDetail(new Error(`cannot read ${home}/projects/app/config.json`));
    expect(out).not.toContain(home);
    expect(out).toContain('~');
  });

  it('matches the home directory case-insensitively and in both separator forms', () => {
    const home = homedir();
    const swapped = home.includes('\\') ? home.replace(/\\/g, '/') : home.replace(/\//g, '\\');
    expect(scrubErrorDetail(new Error(`at ${home.toUpperCase()}/x`))).not.toContain(
      home.toUpperCase(),
    );
    if (swapped !== home) {
      expect(scrubErrorDetail(new Error(`at ${swapped}/x`))).not.toContain(swapped);
    }
  });

  it('caps the detail length', () => {
    const out = scrubErrorDetail(new Error('x'.repeat(ERROR_DETAIL_MAX * 3)));
    expect(out.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
  });

  it('leaves an ordinary message untouched', () => {
    expect(scrubErrorDetail(new Error('session not found'))).toBe('session not found');
  });
});

describe('scrubErrorText', () => {
  it('does not truncate — callers own their own length contract', () => {
    const long = 'y'.repeat(ERROR_DETAIL_MAX * 3);
    expect(scrubErrorText(long)).toHaveLength(long.length);
  });

  it('returns empty input unchanged', () => {
    expect(scrubErrorText('')).toBe('');
  });
});
