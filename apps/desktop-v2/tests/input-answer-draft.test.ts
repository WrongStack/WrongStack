import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/platform', () => ({ projectFormDraftStorage: vi.fn() }));

import { DurableFormDraft } from '../src/durable-form-draft';
import { inputAnswerCodec, inputAnswerDraftKey } from '../src/input-answer-draft';
import type { InputDraft } from '../src/input-form-model';

const owner = { projectId: 'project-a', sessionId: 'session-a', requestId: 'question-a' };
const answer: InputDraft = {
  text: { text: 'Keep my answer.', selectedOptionIds: [], delegated: false },
  choices: { text: '', selectedOptionIds: ['a', 'b'], delegated: false },
  delegated: { text: '', selectedOptionIds: [], delegated: true },
};
function storage() {
  let revision = 0;
  let value: unknown = null;
  return {
    async get() {
      return { revision, value: structuredClone(value) };
    },
    async save(next: unknown, expected: number) {
      if (expected !== revision) throw Error('DRAFT_CONFLICT');
      revision++;
      value = structuredClone(next);
      return revision;
    },
  };
}
describe('pending question answer recovery', () => {
  it('restores typed, selected and delegated answers after reconstructing the controller', async () => {
    const saved = storage();
    const before = new DurableFormDraft(saved, inputAnswerCodec(owner));
    await before.load();
    before.edit(answer);
    await before.flush();
    const reloaded = new DurableFormDraft(saved, inputAnswerCodec(owner));
    await reloaded.load();
    expect(reloaded.snapshot().value).toEqual(answer);
    expect(await reloaded.clear()).toBe(true);
    const resolved = new DurableFormDraft(saved, inputAnswerCodec(owner));
    await resolved.load();
    expect(resolved.snapshot().value).toBeNull();
  });
  it('separates project, session and question ownership in both keys and envelopes', async () => {
    const codec = inputAnswerCodec(owner);
    const data = codec.serialize(answer);
    const owners = [
      owner,
      { ...owner, projectId: 'project-b' },
      { ...owner, sessionId: 'session-b' },
      { ...owner, requestId: 'question-b' },
    ];
    expect(new Set(await Promise.all(owners.map(inputAnswerDraftKey))).size).toBe(4);
    for (const foreign of owners.slice(1))
      expect(() => inputAnswerCodec(foreign).parse(data)).toThrow('another request');
    for (const invalid of [
      [],
      {},
      { version: 2 },
      { ...(data as object), answers: { a: { text: 'x' } } },
    ])
      expect(() => codec.parse(invalid)).toThrow();
  });
  it('keeps a newer window answer when resolution cleanup loses its revision', async () => {
    const saved = storage();
    const first = new DurableFormDraft(saved, inputAnswerCodec(owner));
    await first.load();
    first.edit(answer);
    await first.flush();
    const peer = new DurableFormDraft(saved, inputAnswerCodec(owner));
    await peer.load();
    peer.edit({ text: { text: 'Newer answer', delegated: false, selectedOptionIds: [] } });
    await peer.flush();
    expect(await first.clear()).toBe(false);
    const reloaded = new DurableFormDraft(saved, inputAnswerCodec(owner));
    await reloaded.load();
    expect(reloaded.snapshot().value?.text?.text).toBe('Newer answer');
    expect(first.snapshot().review).not.toBeNull();
  });
});
