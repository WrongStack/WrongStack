/**
 * WS-019 — path traversal through the HQ transcript route.
 *
 * `GET /api/sessions/:sid/agents/:aid/messages` percent-decoded both ids with
 * `decodeURIComponent` and nothing else, then joined the result straight onto
 * a filesystem path:
 *
 *   <projectSessions>/<sid>/subagents/transcripts/<aid>/transcript.jsonl
 *
 * `%2e%2e%2f` decodes to `../`, so a request could walk out of the session's
 * own directory and read any `transcript.jsonl` on the machine — other
 * projects' sessions included. The decode is what CREATES the traversal, so
 * the check has to happen after it, not before.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodePathSegment,
  decodeSessionId,
  isSafePathSegment,
  isSafeSessionId,
  readLocalSubagentTranscript,
  truncateHqSummary,
} from '../src/hq-server/utils.js';

describe('decodePathSegment (WS-019)', () => {
  it('rejects an encoded traversal — the exact bypass', () => {
    expect(decodePathSegment('%2e%2e%2f%2e%2e%2fetc')).toBeNull();
    expect(decodePathSegment('..%2f..%2fsecrets')).toBeNull();
    expect(decodePathSegment('%2e%2e')).toBeNull();
  });

  it('rejects a plain traversal and any separator', () => {
    expect(decodePathSegment('..')).toBeNull();
    expect(decodePathSegment('.')).toBeNull();
    expect(decodePathSegment('a/b')).toBeNull();
    expect(decodePathSegment('a%2Fb')).toBeNull();
    expect(decodePathSegment('a%5Cb')).toBeNull();
  });

  it('rejects NUL, drive-relative forms, empty, and oversize input', () => {
    expect(decodePathSegment('a%00b')).toBeNull();
    expect(decodePathSegment('C%3Afoo')).toBeNull();
    expect(decodePathSegment('')).toBeNull();
    expect(decodePathSegment('a'.repeat(257))).toBeNull();
  });

  it('still returns malformed-encoding null rather than throwing', () => {
    expect(decodePathSegment('%')).toBeNull();
    expect(decodePathSegment('%zz')).toBeNull();
  });

  it('accepts the id shapes the product actually generates', () => {
    // Generated tokens, and the nickname#pid form used across surfaces.
    expect(decodePathSegment('leader')).toBe('leader');
    expect(decodePathSegment('01JQ8Z0000000000000000')).toBe('01JQ8Z0000000000000000');
    expect(decodePathSegment('scout%2312345')).toBe('scout#12345');
    expect(decodePathSegment('agent-1_test')).toBe('agent-1_test');
    expect(decodePathSegment('sess%20name')).toBe('sess name');
  });

  it('isSafePathSegment is the single definition both layers use', () => {
    expect(isSafePathSegment('ok')).toBe(true);
    expect(isSafePathSegment('..')).toBe(false);
    expect(isSafePathSegment('a\\b')).toBe(false);
  });
});

describe('decodeSessionId (date-sharded session ids)', () => {
  it('accepts a realistic date-sharded session id', () => {
    // The exact shape `generateSessionId` produces and the disk-transcript
    // tests register (`2026-07-10/sess_TESTDISK01`). The WebUI percent-encodes
    // it with encodeURIComponent, so the `/` arrives as %2F and must survive.
    expect(decodeSessionId('2026-07-10%2Fsess_TESTDISK01')).toBe('2026-07-10/sess_TESTDISK01');
    expect(decodeSessionId('2026-06-11/sess_01JQ8Z0000000000000000')).toBe(
      '2026-06-11/sess_01JQ8Z0000000000000000',
    );
  });

  it('accepts legacy flat session ids (no shard separator)', () => {
    // session-id.ts: older ids "remain readable" — they have no slash and must
    // not be rejected now that the session position uses decodeSessionId.
    expect(decodeSessionId('legacy-flat-id')).toBe('legacy-flat-id');
  });

  it('rejects traversal, deep nesting, and malformed shapes', () => {
    expect(decodeSessionId('%2e%2e%2f%2e%2e%2fetc')).toBeNull();
    expect(decodeSessionId('..%2fsess_x')).toBeNull();
    expect(decodeSessionId('a%2Fb%2Fc')).toBeNull(); // three components
    expect(decodeSessionId('a%5Cb')).toBeNull(); // backslash
    expect(decodeSessionId('C%3Afoo')).toBeNull(); // drive-relative colon
    expect(decodeSessionId('a%00b')).toBeNull(); // NUL
    expect(decodeSessionId('')).toBeNull();
    expect(decodeSessionId('%')).toBeNull(); // malformed encoding
  });

  it('isSafeSessionId allows one or two components only', () => {
    expect(isSafeSessionId('2026-07-10/sess_X')).toBe(true);
    expect(isSafeSessionId('flat')).toBe(true);
    expect(isSafeSessionId('a/b/c')).toBe(false);
    expect(isSafeSessionId('../x')).toBe(false);
    expect(isSafeSessionId('a\\b')).toBe(false);
  });
});

describe('readLocalSubagentTranscript containment (WS-019)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hq-traversal-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('refuses a traversing id even when reached directly', async () => {
    // The function is exported, so it must not depend on its caller having
    // validated. A read guarded only at one call site is one refactor away
    // from being unguarded.
    await mkdir(join(root, 'elsewhere'), { recursive: true });
    await writeFile(join(root, 'elsewhere', 'transcript.jsonl'), '{"content":"secret"}\n');

    for (const id of ['../elsewhere', '..', 'a/b', 'a\\b', '']) {
      await expect(readLocalSubagentTranscript('any-session', id)).resolves.toBeNull();
    }
  });
});

describe('truncateHqSummary (length cap)', () => {
  it('never returns output longer than maxLength', () => {
    // The exact bug: the suffix was appended on top of the capped prefix, so
    // a 281-char summary truncated to 280 came out 294 chars. The total must
    // be <= maxLength.
    const overBy1 = truncateHqSummary('a'.repeat(281), 280)!;
    expect(overBy1.length).toBeLessThanOrEqual(280);
  });

  it('never grows the string beyond its original length', () => {
    // Truncating a 10-char string "to 9" used to produce 23 chars — longer
    // than the input. The fix must keep the result <= the input length.
    const small = truncateHqSummary('abcdefghij', 9)!;
    expect(small.length).toBeLessThanOrEqual(10);
  });

  it('returns the value unchanged when it already fits', () => {
    expect(truncateHqSummary('short', 100)).toBe('short');
  });

  it('returns undefined for non-strings and empty strings', () => {
    expect(truncateHqSummary(42, 10)).toBeUndefined();
    expect(truncateHqSummary('', 10)).toBeUndefined();
  });

  it('falls back to a bare ellipsis when the cap cannot fit the suffix', () => {
    // 10 chars capped at 4: the "…[truncated:6]" suffix (15 chars) doesn't
    // fit, so a minimal ellipsis is returned rather than an oversized label.
    expect(truncateHqSummary('abcdefghij', 4)).toBe('…');
  });
});
