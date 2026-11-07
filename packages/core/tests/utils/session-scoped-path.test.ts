import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionScopedPath } from '../../src/utils/session-scoped-path.js';

describe('sessionScopedPath', () => {
  // Absolute so the fixture cannot drift with the runner's cwd: this suite is
  // run both from the repo root and from `packages/core` (`pnpm --filter`),
  // and `path.resolve('tmp-sessions')` named a different directory in each.
  const dir = path.join(os.tmpdir(), 'session-scoped-path-test', 'tmp-sessions');

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

  it('rejects dot segments, empty segments, whitespace-only IDs, and colons (F101)', () => {
    expect(() => sessionScopedPath(dir, '.', '')).toThrow('Invalid sessionId');
    expect(() => sessionScopedPath(dir, './sess_1', '.json')).toThrow('Invalid sessionId');
    expect(() => sessionScopedPath(dir, 'sess_1/', '.json')).toThrow('Invalid sessionId');
    expect(() => sessionScopedPath(dir, 'sess_1:ads', '.json')).toThrow('Invalid sessionId');
    expect(() => sessionScopedPath(dir, '   ', '.json')).toThrow('Invalid sessionId');
  });
});
