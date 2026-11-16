import { describe, expect, it } from 'vitest';
import { DraftWriter } from '../src/draft-storage';

describe('session draft persistence', () => {
  it('serializes saves within a session without blocking another session', async () => {
    const seen: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = new DraftWriter(async (id, text, revision) => {
      seen.push(`${id}:${text}`);
      if (text === 'first') await first;
      return revision + 1;
    });
    writer.initialize('a', 0);
    writer.initialize('b', 0);
    const a = writer.write('a', 'first');
    const b = writer.write('a', 'second');
    const c = writer.write('b', 'other');
    await c;
    expect(seen).toEqual(['a:first', 'b:other']);
    release();
    await Promise.all([a, b]);
    expect(seen).toEqual(['a:first', 'b:other', 'a:second']);
  });
  it('saves only the newest text of writes made while a save is in flight', async () => {
    const seen: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = new DraftWriter(async (_id, text, revision) => {
      seen.push(text);
      if (text === 'h') await first;
      return revision + 1;
    });
    writer.initialize('a', 0);
    const typed = ['h', 'he', 'hel', 'hell', 'hello'].map((text) => writer.write('a', text));
    release();
    await Promise.all(typed);
    expect(seen).toEqual(['h', 'hello']);
    expect(writer.revision('a')).toBe(2);
    await writer.write('a', 'hello!');
    expect(seen).toEqual(['h', 'hello', 'hello!']);
  });
  it('reports failed writes while allowing a later save', async () => {
    const writer = new DraftWriter(async (_id, text, revision) => {
      if (text === 'bad') throw Error('disk full');
      return revision + 1;
    });
    writer.initialize('a', 0);
    await expect(writer.write('a', 'bad')).rejects.toThrow('disk full');
    await expect(writer.write('a', 'recovered')).resolves.toBeUndefined();
  });
  it('blocks queued stale writes after a conflict until the saved revision is explicitly reloaded', async () => {
    let calls = 0;
    const writer = new DraftWriter(async (_id, _text, revision) => {
      calls++;
      if (revision === 0) throw Error('DRAFT_CONFLICT: changed elsewhere');
      return revision + 1;
    });
    writer.initialize('a', 0);
    const first = writer.write('a', 'my draft');
    const second = writer.write('a', 'my newer draft');
    await expect(first).rejects.toThrow('DRAFT_CONFLICT');
    await expect(second).rejects.toThrow('DRAFT_CONFLICT');
    expect(calls).toBe(1);
    await writer.drain('a');
    writer.initialize('a', 2);
    await expect(writer.write('a', 'after reload')).resolves.toBeUndefined();
  });
});
