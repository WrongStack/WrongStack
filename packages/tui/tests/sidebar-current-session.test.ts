// Unit tests for the shared `isCurrentSession` helper that normalizes
// the live-vs-resume "current session" comparison key (see
// `sidebar-content.tsx:74-95` and the parallel uses in
// `sidebar-panels.tsx`). Before the helper, the live row used
// `s.sessionId === currentSessionId` while the resume row used
// `currentSessionId !== undefined ? rs.id === currentSessionId : rs.isCurrent === true`
// — two different sources of truth. The helper unifies them.

import { describe, expect, it } from 'vitest';
import { isCurrentSession } from '../src/components/sidebar-content.js';

describe('isCurrentSession (normalized current-session comparison)', () => {
  it('returns true when currentSessionId is defined and rowId matches', () => {
    expect(isCurrentSession('abc-123', 'abc-123')).toBe(true);
  });

  it('returns false when currentSessionId is defined and rowId does not match', () => {
    expect(isCurrentSession('abc-123', 'xyz-789')).toBe(false);
  });

  it('treats currentSessionId as authoritative even when fallbackIsCurrent is true', () => {
    // Even though the row's `isCurrent` flag is true, the runtime
    // currentSessionId takes priority — a row whose id doesn't match
    // the live session must NOT be highlighted.
    expect(isCurrentSession('abc-123', 'xyz-789', true)).toBe(false);
  });

  it('falls back to fallbackIsCurrent when currentSessionId is undefined', () => {
    expect(isCurrentSession('abc-123', undefined, true)).toBe(true);
  });

  it('returns false when both currentSessionId and fallbackIsCurrent are undefined', () => {
    expect(isCurrentSession('abc-123', undefined)).toBe(false);
    expect(isCurrentSession('abc-123', undefined, undefined)).toBe(false);
    expect(isCurrentSession('abc-123', undefined, false)).toBe(false);
  });

  it('returns false when rowId is undefined and currentSessionId is defined', () => {
    // Defensive: a row without an id can never be the current row.
    expect(isCurrentSession(undefined, 'abc-123')).toBe(false);
  });

  it('returns false when rowId is undefined and currentSessionId is undefined', () => {
    expect(isCurrentSession(undefined, undefined)).toBe(false);
    expect(isCurrentSession(undefined, undefined, true)).toBe(false);
  });
});
