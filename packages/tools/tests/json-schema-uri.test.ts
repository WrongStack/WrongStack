import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonTool } from '../src/json.js';
import { mkSandbox, type Sandbox } from './fixtures.js';

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

describe('JSON Schema URI format applies to every present string', () => {
  it.each(['', '   ', ':::bad', '/relative'])(
    'rejects %j rather than treating an empty URI as absent',
    async (value) => {
      const result = await validate(value, { type: 'string', format: 'uri' });
      expect(result.valid).toBe(false);
      // The rendered verdict carries the reason, not a bare "invalid".
      expect(result.formatted).toBe('invalid\n- $: not a valid URI');
      expect(result.errors).toEqual(['$: not a valid URI']);
    },
  );

  it.each(['https://example.com/path', 'urn:example:item'])(
    'continues to accept the valid absolute URI %s',
    async (value) => {
      const result = await validate(value, { type: 'string', format: 'uri' });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    },
  );

  it('allows an empty string when the schema does not require a URI', async () => {
    expect((await validate('', { type: 'string', minLength: 0 })).valid).toBe(true);
  });

  it('does not constrain a non-string with the string format keyword alone', async () => {
    expect((await validate(false, { format: 'uri' })).valid).toBe(true);
    expect((await validate(null, { format: 'uri' })).valid).toBe(true);
  });

  it('distinguishes omission of an optional URI property from a present empty string', async () => {
    const schema = { type: 'object', properties: { url: { type: 'string', format: 'uri' } } };
    expect((await validate({}, schema)).valid).toBe(true);
    const result = await validate({ url: '' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['$.url: not a valid URI']);
  });

  it('reports the array item path for an empty URI', async () => {
    const result = await validate(['', 'https://example.com'], {
      type: 'array',
      items: { type: 'string', format: 'uri' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['$[0]: not a valid URI']);
  });
});
