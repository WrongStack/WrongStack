import { describe, expect, it } from 'vitest';
import {
  contextEditorSnapshot,
  metricsSummary,
  removalProposal,
  removalSet,
} from '../src/context-editor-model';

const raw = {
  revision: 'rev-1',
  messages: [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'answer two' },
  ],
  messageBreakdown: [
    { index: 0, role: 'user', tokens: 5, preview: 'first', pairedAssistantIndices: [1] },
    { index: 1, role: 'assistant', tokens: 9, preview: 'answer one', warnings: [{ message: 'w' }] },
    { index: 2, role: 'user', tokens: 4, preview: 'second', pairedAssistantIndices: [3] },
    { index: 3, role: 'assistant', tokens: 7, preview: 'answer two' },
  ],
  readonlyContext: { totalTokens: 1200 },
};

describe('context editor model', () => {
  it('reads the snapshot and refuses one whose breakdown does not match', () => {
    const snapshot = contextEditorSnapshot(raw);
    expect(snapshot.rows[0]?.paired).toEqual([1]);
    expect(snapshot.rows[1]?.warnings).toEqual(['w']);
    expect(snapshot.totalTokens).toBe(1200);
    expect(() => contextEditorSnapshot({ ...raw, revision: '' })).toThrow(/unreadable/);
    expect(() =>
      contextEditorSnapshot({ ...raw, messageBreakdown: raw.messageBreakdown.slice(1) }),
    ).toThrow(/does not match/);
  });
  it('removes paired replies with a user message and builds the exact proposal', () => {
    const snapshot = contextEditorSnapshot(raw);
    const removed = removalSet(snapshot, new Set([0]));
    expect([...removed].sort()).toEqual([0, 1]);
    const proposal = removalProposal(snapshot, removed);
    expect(proposal).toEqual({
      baseRevision: 'rev-1',
      messages: [raw.messages[2], raw.messages[3]],
      removals: [{ messageIndex: 0 }, { messageIndex: 1 }],
      allowRepair: true,
    });
    // The proposal is a copy; editing it cannot change the snapshot.
    (proposal.messages[0] as { content: string }).content = 'changed';
    expect(snapshot.messages[2]).toEqual({ role: 'user', content: 'second' });
    // An assistant reply alone removes only itself.
    expect([...removalSet(snapshot, new Set([3]))]).toEqual([3]);
  });
  it('summarises before and after metrics only when the engine reports both', () => {
    expect(
      metricsSummary({
        before: { messages: 4, fullRequestTokens: 1200 },
        after: { messages: 2, fullRequestTokens: 900 },
      }),
    ).toBe('4 → 2 messages · ~1,200 → ~900 request tokens');
    expect(metricsSummary({ before: { messages: 4 } })).toBe('');
  });
});
