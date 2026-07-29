/**
 * Tests for codebase-index SQLite runtime utilities.
 *
 * Covers `runSqliteWithRetry` retry/backoff behaviour, LockError throwing
 * at exhaustion, and the `isLockError` detection predicate.
 */
import { describe, expect, it } from 'vitest';
import { LockError } from '../src/codebase-index/circuit-breaker.js';
import { runSqliteWithRetry } from '../src/codebase-index/sqlite-runtime.js';

// ─── runSqliteWithRetry ─────────────────────────────────────────────────────

describe('runSqliteWithRetry', () => {
  it('returns the result of fn on first success', () => {
    const result = runSqliteWithRetry(() => 42);
    expect(result).toBe(42);
  });

  it('returns the result when fn returns a complex value', () => {
    const result = runSqliteWithRetry(() => ({ ok: true, items: [1, 2, 3] }));
    expect(result).toEqual({ ok: true, items: [1, 2, 3] });
  });

  it('retries on SQLITE_BUSY and succeeds on a later attempt', () => {
    const SQLITE_BUSY = new Error('SQLITE_BUSY: database is locked');
    (SQLITE_BUSY as { code?: unknown }).code = 'SQLITE_BUSY';

    let attempt = 0;
    const result = runSqliteWithRetry(() => {
      attempt++;
      if (attempt <= 2) throw SQLITE_BUSY;
      return 'success';
    });
    expect(result).toBe('success');
    expect(attempt).toBe(3);
  });

  it('retries on SQLITE_LOCKED and succeeds on a later attempt', () => {
    const SQLITE_LOCKED = new Error('SQLITE_LOCKED: table is locked');
    (SQLITE_LOCKED as { code?: unknown }).code = 'SQLITE_LOCKED';

    let attempt = 0;
    const result = runSqliteWithRetry(() => {
      attempt++;
      if (attempt <= 1) throw SQLITE_LOCKED;
      return 'unlocked';
    });
    expect(result).toBe('unlocked');
    expect(attempt).toBe(2);
  });

  it('throws LockError after all retries are exhausted', () => {
    const SQLITE_BUSY = new Error('SQLITE_BUSY: still locked');
    (SQLITE_BUSY as { code?: unknown }).code = 'SQLITE_BUSY';

    expect(() =>
      runSqliteWithRetry(() => {
        throw SQLITE_BUSY;
      }),
    ).toThrow(LockError);
  });

  it('LockError message includes the original SQLite error', () => {
    const SQLITE_BUSY = new Error('SQLITE_BUSY: still locked');
    (SQLITE_BUSY as { code?: unknown }).code = 'SQLITE_BUSY';

    expect(() =>
      runSqliteWithRetry(() => {
        throw SQLITE_BUSY;
      }),
    ).toThrow(/SQLITE_BUSY/);
  });

  it('throws non-lock errors immediately without retry', () => {
    let callCount = 0;
    expect(() =>
      runSqliteWithRetry(() => {
        callCount++;
        throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed');
      }),
    ).toThrow('SQLITE_CONSTRAINT');
    expect(callCount).toBe(1);
  });

  it('throws non-error values immediately', () => {
    let callCount = 0;
    expect(() =>
      runSqliteWithRetry(() => {
        callCount++;
        throw 'something went wrong'; // eslint-disable-line no-throw-literal
      }),
    ).toThrow('something went wrong');
    expect(callCount).toBe(1);
  });

  it('handles SQLITE_BUSY with numeric error code 5', () => {
    const numericBusy = new Error('database locked');
    (numericBusy as { code?: unknown }).code = 5;

    let attempt = 0;
    const result = runSqliteWithRetry(() => {
      attempt++;
      if (attempt <= 1) throw numericBusy;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempt).toBe(2);
  });

  it('handles SQLITE_LOCKED with numeric error code 6 via sqliteCode', () => {
    const numericLocked = new Error('table locked');
    (numericLocked as { sqliteCode?: unknown }).sqliteCode = 6;

    let attempt = 0;
    const result = runSqliteWithRetry(() => {
      attempt++;
      if (attempt <= 1) throw numericLocked;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempt).toBe(2);
  });

  it('detects lock errors by message content when code is absent', () => {
    const msgBusy = new Error('database reports SQLITE_BUSY');
    // no code, no sqliteCode — relies on message regex

    let attempt = 0;
    const result = runSqliteWithRetry(() => {
      attempt++;
      if (attempt <= 1) throw msgBusy;
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(attempt).toBe(2);
  });
});
