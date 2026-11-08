import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const output = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/safe-json.ts', import.meta.url))],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'jsonHelpers',
  write: false,
}).outputFiles[0];
if (!output) throw new Error('Expected a browser bundle for safe-json');
const bundle = output.text;

function browserParse(input: string, maxBytes: number): unknown {
  return runInNewContext(
    `${bundle}\nJSON.stringify(jsonHelpers.safeParse(input, maxBytes))`,
    { TextEncoder, input, maxBytes },
    { timeout: 1000 },
  );
}

const cases = [
  { name: 'ASCII', input: '{}', value: {}, bytes: 2 },
  { name: 'two-byte character', input: '"é"', value: 'é', bytes: 4 },
  { name: 'three-byte character', input: '"€"', value: '€', bytes: 5 },
  { name: 'surrogate pair', input: '"😀"', value: '😀', bytes: 6 },
  {
    name: 'unpaired surrogate',
    input: String.fromCharCode(34, 0xd800, 34),
    value: String.fromCharCode(0xd800),
    bytes: 5,
  },
];

describe('browser-safe JSON byte limits', () => {
  it.each(cases)('accepts $name exactly at its UTF-8 byte limit', ({ input, value, bytes }) => {
    expect(browserParse(input, bytes)).toBe(JSON.stringify({ ok: true, value }));
  });

  it.each(cases)('rejects $name one byte above the limit', ({ input, bytes }) => {
    const limit = bytes - 1;
    expect(browserParse(input, limit)).toBe(
      JSON.stringify({ ok: false, error: `Input exceeds limit (${limit} bytes)` }),
    );
  });

  it('keeps the small-input fast path working without Node globals', () => {
    expect(browserParse('{}', 6)).toBe(JSON.stringify({ ok: true, value: {} }));
  });

  it('still reports malformed JSON as a result rather than throwing', () => {
    const result: unknown = runInNewContext(
      `${bundle}\nconst result = jsonHelpers.safeParse('{', 10); [result.ok, typeof result.error].join(':')`,
      { TextEncoder },
      { timeout: 1000 },
    );
    expect(result).toBe('false:string');
  });
});
