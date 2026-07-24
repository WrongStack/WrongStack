import { describe, expect, it, vi } from 'vitest';
import {
  computeResolution,
  rejectIfUnsafeInput,
  resolveTargetId,
} from '../src/shared/candidate-lifecycle.js';
import { consolidateSession } from '../src/shared/session-consolidation.js';
import type { MemoryCandidate, Sage } from '../src/types.js';

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    schemaVersion: 1,
    id: 'candidate',
    status: 'pending',
    text: 'candidate text',
    kind: 'fact',
    scope: 'project',
    confidence: 0.9,
    importance: 0.9,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026',
    updatedAt: '2026',
    ...overrides,
  };
}

function memory(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'memory',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: 'memory',
    importance: 0.8,
    confidence: 0.8,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026',
    updatedAt: '2026',
    ...overrides,
  };
}

describe('candidate resolution policy coverage', () => {
  it('uses only the explicit target id and rejects nested secrets', () => {
    expect(resolveTargetId(candidate({ tags: ['source:spoofed'] }))).toBeUndefined();
    expect(resolveTargetId(candidate({ targetMemoryId: 'memory' }))).toBe('memory');
    expect(() => rejectIfUnsafeInput({ nested: { text: 'ordinary value' } })).not.toThrow();
    expect(() => rejectIfUnsafeInput({ nested: { token: `sk-${'x'.repeat(40)}` } })).toThrow(
      'secret or credential',
    );
  });

  it('covers every resolution mutation and reason fallback', () => {
    expect(computeResolution(candidate(), 'delete', undefined, null)).toMatchObject({
      mutation: { kind: 'noop', applied: false },
      reason: 'Reviewed: delete',
      candidateStatus: 'accepted',
    });
    expect(computeResolution(candidate(), 'archive', undefined, null)).toMatchObject({
      mutation: { kind: 'noop', applied: false },
      reason: 'Reviewed: archive',
    });
    expect(computeResolution(candidate(), 'keep', undefined, null)).toMatchObject({
      mutation: { kind: 'noop', applied: true },
      reason: 'Reviewed: keep',
      candidateStatus: 'rejected',
    });
    expect(
      computeResolution(
        candidate({ targetMemoryId: 'memory', reviewReason: 'low confidence' }),
        'delete',
        undefined,
        memory({ persistence: 'permanent' }),
      ),
    ).toMatchObject({
      mutation: { kind: 'noop', targetId: 'memory', applied: false },
      reason: 'Review resolve (low confidence)',
      resolution: { targetMemoryId: 'memory' },
    });
    expect(
      computeResolution(
        candidate({ targetMemoryId: 'memory' }),
        'delete',
        '  remove   it ',
        memory(),
      ),
    ).toMatchObject({
      mutation: { kind: 'delete_memory', applied: true },
      reason: 'remove it',
    });
    expect(
      computeResolution(candidate({ targetMemoryId: 'memory' }), 'delete', undefined, null),
    ).toMatchObject({ mutation: { kind: 'delete_memory', applied: false } });
    expect(
      computeResolution(candidate({ targetMemoryId: 'memory' }), 'archive', undefined, memory()),
    ).toMatchObject({ mutation: { kind: 'archive_memory', applied: true } });
    expect(
      computeResolution(candidate({ targetMemoryId: 'memory' }), 'archive', undefined, null),
    ).toMatchObject({ mutation: { kind: 'archive_memory', applied: false } });
  });
});

describe('session consolidation policy coverage', () => {
  it('counts rejected, duplicate, low-score, and auto-accepted facts', async () => {
    const accepted = vi.fn(async () => memory());
    const create = vi.fn(async (input: { text: string }) => {
      if (input.text === 'throws') throw new Error('unsafe');
      return candidate({
        id: input.text,
        text: input.text,
        confidence: input.text === 'low score' ? 0.1 : 1,
        importance: input.text === 'low score' ? 0.1 : 1,
      });
    });
    const initial = new Set(['existing']);
    await expect(
      consolidateSession({ createCandidate: create as never, acceptCandidate: accepted }, initial, {
        sessionId: 'session',
        autoAcceptThreshold: 0.85,
        facts: [
          { text: ' ' },
          { text: 'existing.' },
          { text: 'throws' },
          { text: 'low score' },
          { text: 'accepted', tags: ['tag'], anchors: [], kind: 'decision' },
        ],
      }),
    ).resolves.toEqual({
      candidates: 2,
      accepted: 1,
      rejected: 1,
      duplicate: 2,
    });
    expect(initial).toEqual(new Set(['existing']));
    expect(accepted).toHaveBeenCalledWith('accepted');

    await expect(
      consolidateSession(
        { createCandidate: create as never, acceptCandidate: accepted },
        new Set(),
        { sessionId: 'session', facts: [] },
      ),
    ).resolves.toEqual({
      candidates: 0,
      accepted: 0,
      rejected: 0,
      duplicate: 0,
    });
  });
});
