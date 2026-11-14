import { describe, expect, it } from 'vitest';
import { encodeBinaryFrame, encodeJsonFrame } from '../../src/codebase-index/binary-frame.js';

describe('binary-frame cycle guard (F300)', () => {
  it('encodes cyclic objects without overflowing the call stack', () => {
    const a: Record<string, unknown> = { ok: 1 };
    a.self = a;

    const bin = encodeBinaryFrame(a);
    expect(bin.length).toBeGreaterThan(0);

    const json = encodeJsonFrame(a);
    expect(json).toContain('[Circular]');
  });
});
