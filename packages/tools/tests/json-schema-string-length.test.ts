import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonTool } from '../src/json.js';
import { mkSandbox, type Sandbox } from './fixtures.js';

const face = String.fromCodePoint(0x1f600);
let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await mkSandbox();
});
afterEach(async () => {
  await sandbox.cleanup();
});

async function validate(value: unknown, schema: Record<string, unknown>) {
  return jsonTool.execute(
    { action: 'validate', data: JSON.stringify(value), schema },
    sandbox.ctx,
    { signal: new AbortController().signal },
  );
}

describe('JSON Schema string bounds count Unicode code points', () => {
  it.each([
    ['one supplementary character at maximum', face, { maxLength: 1 }, true],
    ['one supplementary character below minimum', face, { minLength: 2 }, false],
    [
      'mixed BMP and supplementary characters at exact bounds',
      `a${face}`,
      { minLength: 2, maxLength: 2 },
      true,
    ],
    ['two supplementary characters exceed maximum', face.repeat(2), { maxLength: 1 }, false],
    ['ASCII at maximum', 'a', { maxLength: 1 }, true],
    ['ASCII exceeds maximum', 'ab', { maxLength: 1 }, false],
    ['ASCII below minimum', 'a', { minLength: 2 }, false],
    ['empty string at zero bounds', '', { minLength: 0, maxLength: 0 }, true],
    ['empty string below minimum', '', { minLength: 1 }, false],
    [
      'combining mark counts separately, not as one grapheme',
      'e\u0301',
      { minLength: 2, maxLength: 2 },
      true,
    ],
    ['length keywords do not constrain numbers', 123, { minLength: 4, maxLength: 0 }, true],
  ] as const)('%s', async (_label, value, schema, expected) => {
    const result = await validate(value, schema);
    expect(result.valid).toBe(expected);
    // An invalid result lists its reasons under the verdict line.
    expect(result.formatted.split('\n')[0]).toBe(expected ? 'valid' : 'invalid');
    if (expected) expect(result.errors).toEqual([]);
    else expect(result.errors?.length).toBeGreaterThan(0);
  });

  it('applies code-point bounds to nested properties and array items', async () => {
    const result = await validate(
      { label: face, values: [face, `a${face}`] },
      {
        type: 'object',
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 1 },
          values: { type: 'array', items: { type: 'string', minLength: 2 } },
        },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['$.values[0]: string too short (min 2)']);
  });
});
