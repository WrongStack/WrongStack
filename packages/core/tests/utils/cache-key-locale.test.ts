import { describe, expect, it } from 'vitest';
import type { Tool } from '@wrongstack/contracts/types';
import { deriveCachePrefixKey } from '../../src/utils/cache-key.js';

/**
 * F105: deriveCachePrefixKey sorts tools by canonicalToolFingerprint with
 * localeCompare so "registration order does not perturb the key" (its own
 * contract — provider prompt-cache routing on load-balanced deployments).
 * Fingerprints are canonical JSON of free-form names/descriptions;
 * localeCompare returns 0 for distinct canonically-equivalent texts
 * ('café' vs 'cafe\u0301' — proven on this en-US host), so the tie falls
 * back to registration order and the same tool set hashes differently.
 */
const tool = (name: string): Tool =>
  ({ name, description: '', inputSchema: { type: 'object', properties: {} } }) as unknown as Tool;

const cafe = tool('café');
const cafeDecomposed = tool('cafe\u0301');

describe('cache prefix key is registration-order independent (F105)', () => {
  it('hashes collation-equal fingerprints identically in either order', () => {
    const prompt = [{ type: 'text', text: 'sys' }] as never;
    const k1 = deriveCachePrefixKey(prompt, [cafe, cafeDecomposed]);
    const k2 = deriveCachePrefixKey(prompt, [cafeDecomposed, cafe]);
    expect(k1).toBe(k2);
  });

  it('still ignores registration order for ASCII tools (control)', () => {
    const prompt = [{ type: 'text', text: 'sys' }] as never;
    const a = tool('alpha');
    const b = tool('beta');
    expect(deriveCachePrefixKey(prompt, [a, b])).toBe(deriveCachePrefixKey(prompt, [b, a]));
  });

  it('still changes the key when a schema changes (control)', () => {
    const prompt = [{ type: 'text', text: 'sys' }] as never;
    const a = tool('alpha');
    const changed = {
      name: 'alpha',
      description: '',
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    } as unknown as Tool;
    expect(deriveCachePrefixKey(prompt, [a])).not.toBe(deriveCachePrefixKey(prompt, [changed]));
  });
});
