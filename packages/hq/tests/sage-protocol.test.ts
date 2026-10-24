import { describe, expect, it } from 'vitest';
import { compareHqSageRecords, type HqSageRecord } from '../src/protocol/sage.js';
import { createHqEventEnvelope } from '../src/protocol.js';
import { queuedFrameCoalesceKey } from '../src/publisher-queue.js';
import { parseHqServerMessage } from '../src/publisher-server-message.js';
import { redactHqEventPayload } from '../src/redaction.js';

const tombstone: HqSageRecord = { id: 'm1', revision: 2, changeId: 'a'.repeat(32), memory: null };
describe('SAGE client protocol', () => {
  it('validates project identity and records before delivery', () => {
    const frame = (projectId: string, records: unknown[]) =>
      JSON.stringify({ type: 'hq.sage_snapshot', payload: { projectId, records } });
    expect(parseHqServerMessage(frame('p1', [tombstone]), 'p1')?.type).toBe('hq.sage_snapshot');
    expect(parseHqServerMessage(frame('p2', [tombstone]), 'p1')).toBeNull();
    expect(parseHqServerMessage(frame('p1', [{ ...tombstone, revision: -1 }]), 'p1')).toBeNull();
  });
  it('never coalesces independent memory deltas during a connection loss', () => {
    const event = createHqEventEnvelope({
      id: 'e',
      timestamp: new Date().toISOString(),
      type: 'sage.snapshot',
      clientId: 'c',
      projectId: 'p',
      seq: 1,
      payload: { projectId: 'p', records: [tombstone] },
    });
    expect(queuedFrameCoalesceKey({ type: 'client.event', event })).toBeUndefined();
  });
  it('gives tombstones precedence over same-revision offline edits', () => {
    const edit = { ...tombstone, changeId: 'f'.repeat(32), memory: { status: 'active' } };
    expect(compareHqSageRecords(tombstone, edit)).toBeGreaterThan(0);
    expect(compareHqSageRecords({ ...edit, revision: 3 }, tombstone)).toBeGreaterThan(0);
  });
  it('preserves memory text under summary policy while scrubbing credentials', () => {
    const result = redactHqEventPayload(
      'sage.snapshot',
      { memory: { text: 'repository convention', password: 'do-not-share' } },
      { policy: { rawContent: false } },
    );
    expect(result.value).toMatchObject({ memory: { text: 'repository convention' } });
    expect(JSON.stringify(result.value)).not.toContain('do-not-share');
  });
});
