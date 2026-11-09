import { describe, expect, it } from 'vitest';
import { readMessagePins, toggleMessagePin } from '../src/message-pins';

describe('conversation message pins', () => {
  it('restores only bounded valid unique IDs and keeps scopes separate', () => {
    const values = new Map([
      ['project-a:session-a', '["m1","m1",5,""]'],
      ['project-b:session-a', '["other"]'],
    ]);
    const storage = { getItem: (key: string) => values.get(key) ?? null };
    expect(readMessagePins(storage, 'project-a:session-a')).toEqual(['m1']);
    expect(readMessagePins(storage, 'project-b:session-a')).toEqual(['other']);
    expect(readMessagePins(storage, 'absent')).toEqual([]);
  });
  it('pins, unpins and refuses silent eviction of older pins at the bound', () => {
    expect(toggleMessagePin(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleMessagePin(['a', 'b'], 'a')).toEqual(['b']);
    const full = Array.from({ length: 100 }, (_, i) => String(i));
    expect(() => toggleMessagePin(full, 'new')).toThrow(/100/);
    expect(toggleMessagePin(full, '0')).toHaveLength(99);
  });
});
