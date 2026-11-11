import type { SessionEvent } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { buildInspectPayload } from '../src/server/session-history.js';

const ts = '2026-11-11T13:00:00.000Z';
const fallback = {
  id: 'session',
  title: 'History',
  model: 'test',
  provider: 'test',
  startedAt: ts,
};
function inspect(event: SessionEvent) {
  return buildInspectPayload(undefined, [event], fallback).events[0]!;
}

describe('branch events in session inspection', () => {
  it('preserves ordinary event rendering', () => {
    expect(
      inspect({ type: 'checkpoint', ts, promptIndex: 2, promptPreview: 'control' }).label,
    ).toBe('Checkpoint at prompt #2');
  });
  it.each<SessionEvent>([
    {
      type: 'branch_created',
      ts,
      newBranchId: 'child',
      name: 'Explore',
      parentBranchId: 'main',
      forkSeq: 8,
    },
    {
      type: 'branch_switched',
      ts,
      fromBranchId: 'main',
      toBranchId: 'child',
      workspaceRestored: false,
    },
    {
      type: 'branch_folded',
      ts,
      sourceBranchId: 'child',
      targetBranchId: 'main',
      summary: 'Use the validated approach',
      summaryMessage: { role: 'assistant', content: 'Use the validated approach' },
      archiveSource: true,
    },
    { type: 'branch_status_changed', ts, targetBranchId: 'child', status: 'archived' },
    { type: 'branch_status_changed', ts, targetBranchId: 'child', name: 'Reviewed' },
  ])('provides readable label and branch identity for $type', (event) => {
    const row = inspect(event);
    expect(row.type).toBe(event.type);
    expect(row.ts).toBe(ts);
    expect(row.label).toMatch(/^Branch /);
    expect(row.detail).toContain('child');
    expect(row.label).not.toContain('[object Object]');
    if (event.type === 'branch_switched') expect(row.detail).toContain('not restored');
    if (event.type === 'branch_folded') expect(row.detail).toContain(event.summary);
    if (event.type === 'branch_status_changed')
      expect(row.detail).toContain(event.status ?? event.name!);
  });
});
