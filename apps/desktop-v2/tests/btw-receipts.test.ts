import { describe, expect, it, vi } from 'vitest';
import { BtwReceiptStore, btwStatus } from '../src/btw-receipts';
import { dispatchComposer } from '../src/composer-model';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

describe('BTW receipts', () => {
  it('keeps notes per session, newest first, without duplicates and bounded', () => {
    const store = new BtwReceiptStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.record('s1', { messageId: 'a', text: 'one', sentAt: 1 });
    store.record('s1', { messageId: 'b', text: 'two', sentAt: 2 });
    store.record('s1', { messageId: 'a', text: 'one again', sentAt: 3 });
    store.record('s2', { messageId: 'c', text: 'other', sentAt: 4 });
    expect(store.list('s1').map((note) => note.messageId)).toEqual(['a', 'b']);
    expect(store.list('s2')).toHaveLength(1);
    expect(store.list('none')).toBe(store.list('missing'));
    expect(listener).toHaveBeenCalledTimes(4);
    for (let index = 0; index < 60; index++)
      store.record('s3', { messageId: `m${index}`, text: '', sentAt: index });
    expect(store.list('s3')).toHaveLength(50);
    expect(store.list('s3')[0]?.messageId).toBe('m59');
  });
  it('reads receipt state from the mailbox record without guessing', () => {
    expect(btwStatus(undefined)).toBe('not-found');
    expect(btwStatus({ completed: false, readBy: {} })).toBe('saved');
    expect(btwStatus({ readBy: { leader: '2026-10-29T10:00:00Z' } })).toBe('read');
    expect(btwStatus({ readByCount: 2 })).toBe('read');
    expect(btwStatus({ completed: true, readBy: {} })).toBe('completed');
  });
  it('reports the saved mailbox id of a BTW sent during a run', async () => {
    const saved = vi.fn();
    const started = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 'native-a', provider: 'local', model: 'reasoner' },
    });
    const ports = {
      current: () => ({ ...started, running: true }),
      send: vi.fn(),
      command: vi.fn(async () => ({ messageId: 'mail-1' })),
      waitForIdle: vi.fn(),
      onBtwSaved: saved,
    };
    await dispatchComposer('  Note for the leader  ', 'btw', ports as never);
    expect(saved).toHaveBeenCalledWith('mail-1', 'Note for the leader');
  });
});
