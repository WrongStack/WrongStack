// Ported from WrongMemory packages/client-ts/test/framing.test.ts @ 50a9d9f (bun:test -> vitest).
import { describe, expect, test } from 'vitest';
import { encodeFrame, FrameDecoder, isWrongMemoryError } from '../src/index.js';

describe('framing', () => {
  test('round trip with unicode and embedded newlines', () => {
    const d = new FrameDecoder();
    const frames = d.push(Buffer.concat([encodeFrame({ x: 'çağrı 🚀\nline' }), encodeFrame(2)]));
    expect(frames).toEqual([{ x: 'çağrı 🚀\nline' }, 2]);
    expect(d.pending).toBe(0);
  });

  test('frames split across chunks, CRLF and blank lines', () => {
    const d = new FrameDecoder();
    const bytes = Buffer.from('\n{"a":1}\r\n{"b":"ü"}\n');
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i++) out.push(...d.push(bytes.subarray(i, i + 1)));
    expect(out).toEqual([{ a: 1 }, { b: 'ü' }]);
  });

  test('partial frame is reported as pending', () => {
    const d = new FrameDecoder();
    expect(d.push(Buffer.from('{"a"'))).toEqual([]);
    expect(d.pending).toBe(4);
  });

  test('oversized line is rejected before a newline arrives', () => {
    const d = new FrameDecoder(100);
    let err: unknown;
    try {
      d.push(Buffer.alloc(1000, 0x78));
    } catch (e) {
      err = e;
    }
    expect(isWrongMemoryError(err, 'PROTOCOL')).toBe(true);
  });

  test('invalid JSON is a protocol error', () => {
    expect(() => new FrameDecoder().push(Buffer.from('not json\n'))).toThrow(/invalid frame/);
  });

  test('encoder refuses oversized payloads', () => {
    expect(() => encodeFrame('x'.repeat(200), 100)).toThrow(/exceeds/);
  });
});
