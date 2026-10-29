import { describe, expect, it } from 'vitest';
import {
  contextEditorSnapshot,
  draftTokenEstimate,
  editProposal,
  messageTexts,
  metricsSummary,
  removalProposal,
  removalSet,
  withTextRange,
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

describe('text ranges inside a message', () => {
  const snapshot = contextEditorSnapshot({
    ...raw,
    messages: [
      ...raw.messages.slice(0, 3),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'keep this, drop that' },
          { type: 'tool_use', id: 't', name: 'read', input: {} },
        ],
      },
    ],
  });
  it('lists the editable texts and refuses empty or overlapping ranges', () => {
    expect(messageTexts(snapshot.messages[3]!)).toEqual([
      { blockIndex: 0, text: 'keep this, drop that' },
    ]);
    expect(messageTexts(snapshot.messages[0]!)).toEqual([{ text: 'first' }]);
    const first = withTextRange([], { messageIndex: 3, blockIndex: 0, start: 9, end: 20 });
    expect(Array.isArray(first) && first).toHaveLength(1);
    expect(
      withTextRange(first as never, { messageIndex: 3, blockIndex: 0, start: 15, end: 18 }),
    ).toMatch(/overlaps/);
    expect(withTextRange([], { messageIndex: 3, start: 2, end: 2 })).toMatch(/Select/);
  });
  it('builds the exact proposal the engine validates, pairing replies of an edited user message', () => {
    const proposal = editProposal(snapshot, new Set(), [
      { messageIndex: 3, blockIndex: 0, start: 9, end: 20 },
      { messageIndex: 0, start: 0, end: 2 },
    ]);
    expect(proposal.removals).toEqual([
      { messageIndex: 1 },
      { messageIndex: 3, blockIndex: 0, start: 9, end: 20 },
      { messageIndex: 0, start: 0, end: 2 },
    ]);
    expect(proposal.messages.map((message) => message['content'])).toEqual([
      'rst',
      'second',
      [
        { type: 'text', text: 'keep this' },
        { type: 'tool_use', id: 't', name: 'read', input: {} },
      ],
    ]);
    expect(snapshot.messages[3]!['content']).not.toBe(proposal.messages[2]!['content']);
  });
  it('estimates request tokens before the engine check', () => {
    expect(draftTokenEstimate(snapshot, new Set([2, 3]), [])).toBe(1200 - 4 - 7);
    expect(
      draftTokenEstimate(snapshot, new Set(), [
        { messageIndex: 3, blockIndex: 0, start: 0, end: 7 },
      ]),
    ).toBe(1198);
  });
});
