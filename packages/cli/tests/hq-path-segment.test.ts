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
  isSafePathSegment,
  readLocalSubagentTranscript,
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
