import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionScopedPath } from '../../src/utils/session-scoped-path.js';

describe('sessionScopedPath', () => {
  const dir = path.resolve('tmp-sessions');

  it('resolves normal session IDs and sidecar suffixes', () => {
    const p = sessionScopedPath(dir, '2026-08-29/sess_01J', '.annotations.json');
    expect(p).toBe(path.resolve(dir, '2026-08-29', 'sess_01J.annotations.json'));
  });

  it('rejects Windows backslashes in date-sharded session IDs', () => {
    expect(() => sessionScopedPath(dir, '2026-08-29\\sess_01J', '.replay.jsonl')).toThrow();
  });

  it('rejects path traversal attempts', () => {
    expect(() => sessionScopedPath(dir, '../evil', '.json')).toThrow();
    expect(() => sessionScopedPath(dir, '2026-08-29/../../evil', '.json')).toThrow();
    expect(() => sessionScopedPath(dir, '..\\..\\evil', '.json')).toThrow();
  });

  it('rejects empty session IDs', () => {
    expect(() => sessionScopedPath(dir, '', '.json')).toThrow();
  });
});
