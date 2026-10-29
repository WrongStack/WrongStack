import { describe, expect, it } from 'vitest';
import { DurableFormDraft, type FormDraftStorage } from '../src/durable-form-draft';
import { MailboxDraftStore, mailDraftCodec } from '../src/mailbox-draft';
import { emptyMailDraft } from '../src/mailbox-model';

/** Mirrors the native compare-and-set contract of `form-draft.save`. */
function nativeSlot() {
  const slot = { revision: 0, value: null as unknown };
  const storage: FormDraftStorage = {
    get: async () => structuredClone(slot),
    save: async (value, expected) => {
      if (expected !== slot.revision)
        throw Error('DRAFT_CONFLICT: This draft changed in another window');
      slot.revision++;
      slot.value = JSON.parse(JSON.stringify(value));
      return slot.revision;
    },
  };
  return { slot, storage };
}
const windowOn = (storage: FormDraftStorage) =>
  new MailboxDraftStore(new DurableFormDraft(storage, mailDraftCodec));
const message = { ...emptyMailDraft(), to: 'agent-1', subject: 'Status', body: 'Unsent body' };

describe('durable mailbox draft', () => {
  it('restores an unsent message in a new window and clears it only after a confirmed send', async () => {
    const { slot, storage } = nativeSlot();
    const first = windowOn(storage);
    await first.hydrate();
    first.update(message);
    await first.durable!.flush();
    expect(slot.value).toEqual({ version: 1, draft: message });

    const restarted = windowOn(storage);
    await restarted.hydrate();
    expect(restarted.snapshot().draft).toEqual(message);
    expect(restarted.snapshot().restoredAt).toBeTypeOf('number');

    // A failed send keeps both the window draft and the saved copy.
    const submitted = restarted.begin();
    restarted.fail(Error('Engine unavailable.'));
    expect(slot.value).toEqual({ version: 1, draft: message });
    const again = restarted.begin();
    expect(again).toBe(submitted);
    restarted.acknowledge(again);
    await restarted.durable!.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slot.value).toBeNull();
    expect(restarted.snapshot().draft).toEqual(emptyMailDraft());
  });
  it('keeps edits made while a send was awaiting acknowledgement', async () => {
    const { slot, storage } = nativeSlot();
    const store = windowOn(storage);
    await store.hydrate();
    store.update(message);
    const submitted = store.begin();
    store.update({ ...message, body: 'ignored while pending' });
    store.acknowledge(submitted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slot.value).toBeNull();
    // Discarding an empty draft clears the slot as well.
    store.update({ ...message, body: 'second' });
    await store.durable!.flush();
    expect(slot.value).toEqual({ version: 1, draft: { ...message, body: 'second' } });
    store.update(emptyMailDraft());
    await store.durable!.flush();
    expect(slot.value).toBeNull();
  });
  it('does not adopt a saved draft over text this window already holds', async () => {
    const { slot, storage } = nativeSlot();
    const earlier = windowOn(storage);
    await earlier.hydrate();
    earlier.update(message);
    await earlier.durable!.flush();
    const typed = new MailboxDraftStore(new DurableFormDraft(storage, mailDraftCodec));
    typed.update({ ...message, subject: 'Typed before load' });
    await typed.hydrate();
    await typed.durable!.flush();
    expect(typed.snapshot().draft.subject).toBe('Typed before load');
    expect(typed.snapshot().restoredAt).toBeUndefined();
    expect((slot.value as { draft: { subject: string } }).draft.subject).toBe('Typed before load');
  });
  it('asks for review when another window saved a different message', async () => {
    const { storage } = nativeSlot();
    const mine = windowOn(storage);
    const peer = windowOn(storage);
    await mine.hydrate();
    await peer.hydrate();
    peer.update({ ...message, subject: 'From the other window' });
    await peer.durable!.flush();
    mine.update({ ...message, subject: 'Mine' });
    await mine.durable!.flush();
    expect(mine.durable!.snapshot().review?.value?.subject).toBe('From the other window');
    mine.update({ ...message, subject: 'Mine, edited during review' });
    expect(await mine.resolve('local')).toBe(true);
    await mine.durable!.flush();
    expect(mine.durable!.snapshot().value?.subject).toBe('Mine, edited during review');

    peer.update({ ...message, subject: 'Peer again' });
    await peer.durable!.flush();
    expect(peer.durable!.snapshot().review?.value?.subject).toBe('Mine, edited during review');
    expect(await peer.resolve('saved')).toBe(true);
    expect(peer.snapshot().draft.subject).toBe('Mine, edited during review');
  });
  it('resolves a conflict with a merged body and keeps this window’s other fields', async () => {
    const { slot, storage } = nativeSlot();
    const mine = windowOn(storage);
    const peer = windowOn(storage);
    await mine.hydrate();
    await peer.hydrate();
    peer.update({ ...message, subject: 'Peer subject', body: 'intro\npeer line' });
    await peer.durable!.flush();
    mine.update({ ...message, subject: 'My subject', body: 'intro\nmy line' });
    await mine.durable!.flush();
    expect(mine.durable!.snapshot().review?.value?.body).toBe('intro\npeer line');
    expect(await mine.merge('intro\nmy line\npeer line')).toBe(true);
    await mine.durable!.flush();
    expect(mine.snapshot().draft).toMatchObject({
      subject: 'My subject',
      body: 'intro\nmy line\npeer line',
    });
    expect(slot.value).toEqual({
      version: 1,
      draft: { ...message, subject: 'My subject', body: 'intro\nmy line\npeer line' },
    });
    expect(mine.durable!.snapshot().review).toBeNull();
  });
  it('refuses foreign or oversized envelopes', () => {
    expect(mailDraftCodec.parse(null)).toBeNull();
    for (const value of [
      { version: 2, draft: message },
      { version: 1, draft: { ...message, extra: 'x' } },
      { version: 1, draft: { ...message, body: 1 } },
      { version: 1, draft: { ...message, subject: 's'.repeat(2_001) } },
      { version: 1, draft: { ...message, body: 'b'.repeat(200_001) } },
      { version: 1, draft: [] },
    ])
      expect(() => mailDraftCodec.parse(value)).toThrow(/unsupported format/);
    expect(mailDraftCodec.parse(mailDraftCodec.serialize(message))).toEqual(message);
  });
});
