/**
 * Tests for `isSageVisibleForSearch` — the JS twin of the lexical channel's
 * visibility rules, applied to vector-only hits before they are admitted
 * into a result set.
 *
 * Pin (one test per mirrored clause, in the module's documented order):
 *  - status filter (`includeStatuses ?? ['active']`)
 *  - scope pin (`opts.scope`)
 *  - audience exclusion (`includeAudienceScoped === false` → `audience IS NULL`)
 *  - `contextPolicy: 'never'` exclusion for automatic-context calls, i.e.
 *    exactly the calls that leave `includeStatuses` unset
 *  - session ownership (`includeAllSessions` wins, then `sessionId`, then
 *    unowned-only) — delegated to `isVisibleToSession`, so only the wiring
 *    is pinned here, not that helper's own rules.
 */
import { describe, expect, it } from 'vitest';

import { isSageVisibleForSearch } from '../../src/retrieval/visibility.js';
import type { Sage } from '../../src/types.js';

function sage(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'mem-1',
    text: 'visibility fixture',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    importance: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    anchors: [],
    tags: [],
    ...overrides,
  } as unknown as Sage;
}

describe('isSageVisibleForSearch', () => {
  it('passes a fixture with every filter satisfied', () => {
    expect(isSageVisibleForSearch(sage())).toBe(true);
  });

  describe('status filter', () => {
    it('excludes non-active memories when includeStatuses is unset', () => {
      expect(isSageVisibleForSearch(sage({ status: 'archived' }))).toBe(false);
      expect(isSageVisibleForSearch(sage({ status: 'stale' }))).toBe(false);
    });

    it('honors an explicit includeStatuses list', () => {
      const opts = { includeStatuses: ['stale', 'archived'] } as const;
      expect(isSageVisibleForSearch(sage({ status: 'stale' }), opts)).toBe(true);
      expect(isSageVisibleForSearch(sage({ status: 'archived' }), opts)).toBe(true);
      expect(isSageVisibleForSearch(sage({ status: 'active' }), opts)).toBe(false);
    });
  });

  describe('scope pin', () => {
    it('excludes memories outside the pinned scope', () => {
      expect(isSageVisibleForSearch(sage({ scope: 'project' }), { scope: 'global' })).toBe(false);
    });

    it('admits memories inside the pinned scope', () => {
      expect(isSageVisibleForSearch(sage({ scope: 'global' }), { scope: 'global' })).toBe(true);
    });

    it('applies no scope pin when opts.scope is undefined', () => {
      expect(isSageVisibleForSearch(sage({ scope: 'session' }))).toBe(true);
    });
  });

  describe('audience exclusion', () => {
    it('drops audience-scoped memories when includeAudienceScoped is false', () => {
      expect(
        isSageVisibleForSearch(sage({ audience: 'subagents' }), {
          includeAudienceScoped: false,
        }),
      ).toBe(false);
    });

    it('keeps memories without an audience in the same call', () => {
      expect(
        isSageVisibleForSearch(sage({ audience: undefined }), {
          includeAudienceScoped: false,
        }),
      ).toBe(true);
    });

    it('keeps audience-scoped memories when audience scoping is not excluded', () => {
      expect(
        isSageVisibleForSearch(sage({ audience: 'subagents' }), {
          includeAudienceScoped: true,
        }),
      ).toBe(true);
      expect(isSageVisibleForSearch(sage({ audience: 'subagents' }))).toBe(true);
    });
  });

  describe("contextPolicy: 'never' exclusion", () => {
    it('drops never-context memories from automatic-context calls (includeStatuses unset)', () => {
      expect(isSageVisibleForSearch(sage({ contextPolicy: 'never' }))).toBe(false);
    });

    it('keeps never-context memories on explicit-status calls', () => {
      expect(
        isSageVisibleForSearch(sage({ contextPolicy: 'never' }), {
          includeStatuses: ['active'],
        }),
      ).toBe(true);
    });

    it('keeps memories without the never policy on automatic-context calls', () => {
      expect(isSageVisibleForSearch(sage({ contextPolicy: 'inherit' }))).toBe(true);
    });
  });

  describe('session ownership (delegated to isVisibleToSession)', () => {
    it('shows session-scoped memories to their owning session', () => {
      expect(
        isSageVisibleForSearch(sage({ scope: 'session', ownerSessionId: 'sess-1' }), {
          sessionId: 'sess-1',
        }),
      ).toBe(true);
    });

    it('hides session-scoped memories from other sessions', () => {
      expect(
        isSageVisibleForSearch(sage({ scope: 'session', ownerSessionId: 'sess-1' }), {
          sessionId: 'sess-2',
        }),
      ).toBe(false);
    });

    it('lets includeAllSessions win over session ownership', () => {
      expect(
        isSageVisibleForSearch(sage({ scope: 'session', ownerSessionId: 'sess-1' }), {
          includeAllSessions: true,
        }),
      ).toBe(true);
    });

    it('restricts unfiltered callers to unowned session-scoped memories', () => {
      expect(isSageVisibleForSearch(sage({ scope: 'session', ownerSessionId: null }))).toBe(true);
      expect(isSageVisibleForSearch(sage({ scope: 'session', ownerSessionId: 'sess-1' }))).toBe(
        false,
      );
    });
  });
});
