import type { ToolResultBlock } from '@wrongstack/contracts/types/blocks';
import { describe, expect, it, vi } from 'vitest';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import {
  prepareProgrammaticOutput,
  programmaticOutput,
  rememberProgrammaticOutput,
} from '../../src/utils/tool-programmatic-output.js';

const scrubber = new DefaultSecretScrubber();
const schema = { type: 'object' };

describe('canonical programmatic output boundary', () => {
  it('detaches repeated objects, omits absent optional fields and scrubs strings', () => {
    const common = { key: 'sk-' + 'X'.repeat(40), value: 'clean' };
    const output = { first: common, second: common, optional: undefined };
    const data = prepareProgrammaticOutput(output, schema, scrubber) as typeof output;
    common.value = 'changed';
    expect(data.first.value).toBe('clean');
    expect(data.second.value).toBe('clean');
    expect(data.first).not.toBe(data.second);
    expect(data.first.key).not.toContain('X'.repeat(40));
    expect(Object.hasOwn(data, 'optional')).toBe(false);
  });

  it('preserves prototype-shaped keys as data', () => {
    const data = prepareProgrammaticOutput(
      JSON.parse('{"__proto__":{"marker":1},"constructor":2}'),
      schema,
      scrubber,
    ) as Record<string, unknown>;
    expect(Object.hasOwn(data, '__proto__')).toBe(true);
    expect(data.constructor).toBe(2);
    expect(Object.getPrototypeOf(data)).toBeNull();
  });

  it.each([NaN, Infinity, undefined, 1n, () => {}, new Date(), [undefined], Array(2)])(
    'rejects values outside JSON: %s',
    (value) => {
      expect(() => prepareProgrammaticOutput(value, {}, scrubber)).toThrow();
    },
  );

  it('rejects cycles and getters without calling them', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => prepareProgrammaticOutput(cyclic, schema, scrubber)).toThrow('cycle');
    const getter = vi.fn(() => 'side effect');
    expect(() =>
      prepareProgrammaticOutput(
        Object.defineProperty({}, 'value', { enumerable: true, get: getter }),
        schema,
        scrubber,
      ),
    ).toThrow('accessor');
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects over-limit and schema-invalid output', () => {
    expect(() =>
      prepareProgrammaticOutput({ text: 'x'.repeat(8 * 1024 * 1024 + 1) }, schema, scrubber),
    ).toThrow('8 MiB');
    expect(() =>
      prepareProgrammaticOutput(
        { count: 'seven' },
        { type: 'object', properties: { count: { type: 'integer' } } },
        scrubber,
      ),
    ).toThrow('outputSchema');
  });

  it('bounds nested and wide values', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 65; i++) nested = { nested };
    expect(() => prepareProgrammaticOutput(nested, schema, scrubber)).toThrow('64 nesting');
    expect(() =>
      prepareProgrammaticOutput(Array(250_000).fill(null), { type: 'array' }, scrubber),
    ).toThrow('250000 values');
  });

  it('never serializes execution-local values and invalidates access after a content policy', () => {
    const block: ToolResultBlock = { type: 'tool_result', tool_use_id: 'call', content: 'preview' };
    rememberProgrammaticOutput(block, { hidden: 'canonical-value' });
    expect(programmaticOutput(block)?.value).toEqual({ hidden: 'canonical-value' });
    expect(JSON.stringify(block)).not.toContain('canonical-value');
    expect(programmaticOutput({ ...block })).toBeUndefined();
    block.content = 'redacted';
    expect(programmaticOutput(block)).toBeUndefined();
  });
});
