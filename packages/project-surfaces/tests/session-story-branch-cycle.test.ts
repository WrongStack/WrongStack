import { describe, expect, it } from 'vitest';
import { buildSessionStory } from '../src/story/session-story.js';

describe('buildSessionStory branch parent cycle guard (F288)', () => {
  it('does not recurse infinitely when branch_created events form a parent cycle', () => {
    const story = buildSessionStory('s1', [
      {
        eventId: 'e1',
        eventType: 'branch_created',
        occurredAt: '2026-01-01T00:00:00.000Z',
        scope: { sessionId: 's1' },
        correlation: {},
        attributes: { branchId: 'b1', parentBranchId: 'b2' },
      },
      {
        eventId: 'e2',
        eventType: 'branch_created',
        occurredAt: '2026-01-01T00:00:01.000Z',
        scope: { sessionId: 's1' },
        correlation: {},
        attributes: { branchId: 'b2', parentBranchId: 'b1' },
      },
      {
        eventId: 'e3',
        eventType: 'branch_folded',
        occurredAt: '2026-01-01T00:00:02.000Z',
        scope: { sessionId: 's1' },
        correlation: {},
        attributes: { sourceBranchId: 'b1' },
      },
    ] as never);

    expect(story.actors.some((a) => a.id === 'branch:b1')).toBe(true);
    expect(story.actors.some((a) => a.id === 'branch:b2')).toBe(true);
  });
});
