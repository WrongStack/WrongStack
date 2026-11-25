import { describe, expect, it } from 'vitest';
import { pendingReceipts } from '../src/features/console/model';

describe('pendingReceipts preview trimming', () => {
  it('matches echoed transcript entries even when receipt.preview has outer whitespace', () => {
    const ts = '2026-11-25T10:00:00Z';
    const entries = [{ role: 'user', text: '  hello world  ', ts }] as Parameters<
      typeof pendingReceipts
    >[1];
    expect(
      pendingReceipts(
        [{ commandId: '1', type: 'steer', target: 't', preview: '  hello world  ', createdAt: ts }],
        entries,
      ),
    ).toEqual([]);
  });
});
