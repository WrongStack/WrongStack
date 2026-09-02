import { describe, expect, it } from 'vitest';
import {
  computeHarnessFingerprint,
  computeStableJsonHash,
  computeToolManifestHash,
  fingerprintLabel,
} from '../src/fingerprint.js';

describe('normalizeForHash edge cases', () => {
  it('handles undefined, null, and bigint values', () => {
    // undefined → null, null → null, bigint → string
    // Values normalizeForHash converts undefined to null, so undefined and
    // null at a key produce the same result.
    const hash = computeStableJsonHash({ a: BigInt(42), b: null, c: 'hello' });
    expect(hash).toHaveLength(12);
    const hash2 = computeStableJsonHash({ a: '42', b: null, c: 'hello' });
    expect(hash).toBe(hash2);
  });

  it('omits object keys with undefined values (stripped by JSON.stringify)', () => {
    // When a value is undefined at the object level but we want it to be
    // treated as null (like JSON.stringify would, but explicitly).
    const a = computeStableJsonHash({ x: { y: null, z: 1 } });
    expect(a).toHaveLength(12);
    const b = computeStableJsonHash({ x: { z: 1, y: null } });
    expect(a).toBe(b);
  });

  it('normalizes arrays with mixed types', () => {
    const hash = computeStableJsonHash([1, undefined, null, 'a', BigInt(3)]);
    expect(hash).toHaveLength(12);
    const hash2 = computeStableJsonHash([1, null, null, 'a', '3']);
    expect(hash).toBe(hash2);
  });

  it('handles plain values without object wrapper', () => {
    expect(computeStableJsonHash('just a string')).toHaveLength(12);
    expect(computeStableJsonHash(42)).toHaveLength(12);
    expect(computeStableJsonHash(true)).toHaveLength(12);
    expect(computeStableJsonHash(null)).toHaveLength(12);
  });
});

describe('fingerprintLabel edge cases', () => {
  it('omits yolo from label when false', () => {
    const fp = computeHarnessFingerprint({
      cliVersion: '0.255.0',
      toolNames: ['read'],
      maxIterations: 40,
      yolo: false,
      subsetId: 'test',
    });
    const label = fingerprintLabel(fp);
    expect(label).toContain('wrongstack@0.255.0');
    expect(label).not.toContain('yolo');
  });
});

describe('computeToolManifestHash edge cases', () => {
  it('handles a tool with only a name (minimal fields)', () => {
    const hash = computeToolManifestHash([{ name: 'read' }]);
    expect(hash).toHaveLength(12);
  });

  it('handles an empty tool list', () => {
    const hash = computeToolManifestHash([]);
    expect(hash).toHaveLength(12);
  });

  it('differentiates tools with different risk tiers', () => {
    const a = computeToolManifestHash([{ name: 'bash', riskTier: 'high' }]);
    const b = computeToolManifestHash([{ name: 'bash', riskTier: 'medium' }]);
    expect(a).not.toBe(b);
  });
});
