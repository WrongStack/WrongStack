/**
 * Regression (found in bug-hunt round 6): the AWS IPv6 IMDS literal must
 * classify as `blocked` under every valid spelling of the SAME address.
 *
 * Proven red before the fix — the rule was an exact string compare, so the
 * uncompressed form fell through to ordinary ULA `private`, the one class
 * `allowPrivateNetworks` relaxes.
 *
 * The classifier's own contract (transport-security.ts): `blocked` covers
 * "link-local / IMDS (169.254/16, fe80::/10, fd00:ec2::254); never a valid MCP
 * target, regardless of opt-in." The IMDS rule is an exact string equality, so
 * the uncompressed form of that address escapes it and is reported as ordinary
 * ULA `private` — which `allowPrivateNetworks: true` then permits to be dialed.
 * `fe80::/10` beside it is a regex, so link-local has no such spelling hole.
 */
import { describe, expect, it } from 'vitest';
import {
  assertTransportAddressAllowed,
  classifyTransportAddress,
  validateTransportUrl,
} from '../src/transport-security.js';

const IMDS_COMPRESSED = 'fd00:ec2::254';
/** The identical 128-bit address, written without zero compression. */
const IMDS_UNCOMPRESSED = 'fd00:ec2:0:0:0:0:0:254';

describe('IMDS IPv6 literal is blocked regardless of spelling', () => {
  it('classifies the canonical compressed form as blocked (control)', () => {
    expect(classifyTransportAddress(IMDS_COMPRESSED, 6)).toBe('blocked');
  });

  it('classifies the uncompressed form of the SAME address as blocked', () => {
    expect(classifyTransportAddress(IMDS_UNCOMPRESSED, 6)).toBe('blocked');
  });

  it('refuses to dial the uncompressed form even with allowPrivateNetworks', () => {
    // `blocked` must throw whatever the opt-in says; that is the whole point of
    // separating `blocked` from `private` in the classifier.
    expect(() => assertTransportAddressAllowed(IMDS_UNCOMPRESSED, 6, 'imds.example', true)).toThrow(
      /link-local\/IMDS/,
    );
  });
});

describe('ISATAP-shaped interface IDs under a private IPv6 prefix', () => {
  // `…:5efe:<v4>` is valid under any prefix; the embedded IPv4 may only make
  // a unique-local / multicast verdict stricter, never 'public' or 'loopback'.
  it('keeps unique-local and multicast addresses out of the public/loopback classes', () => {
    expect(classifyTransportAddress('fd00::200:5efe:808:808', 6)).toBe('private');
    expect(classifyTransportAddress('ff02::5efe:808:808', 6)).toBe('private');
    expect(classifyTransportAddress('fd00::200:5efe:7f00:1', 6)).toBe('private');
    expect(classifyTransportAddress('fd00::200:5efe:a9fe:a9fe', 6)).toBe('blocked');
    expect(() =>
      assertTransportAddressAllowed('fd00::200:5efe:808:808', 6, 'isatap.example', false),
    ).toThrow();
  });
});

describe('IPv6 loopback is `loopback` regardless of spelling', () => {
  // Regression (bug-hunt round 7): the loopback rule was an exact `=== "::1"`
  // compare. `0:0:0:0:0:0:0:1` — the identical 128-bit address — fell through
  // to the IPv4-compatible branch, classified `private`, and was then refused
  // by validateTransportUrl (`http://` is loopback-only) and by the dial-time
  // guard. Proven red before the fix; the classifier's own contract lists
  // `loopback` as "127/8, ::1; the documented local topology, always allowed".
  it('classifies the canonical compressed form as loopback (control)', () => {
    expect(classifyTransportAddress('::1', 6)).toBe('loopback');
  });

  it('classifies the expanded and zero-padded forms of the SAME address as loopback', () => {
    expect(classifyTransportAddress('0:0:0:0:0:0:0:1', 6)).toBe('loopback');
    expect(classifyTransportAddress('0000:0000:0000:0000:0000:0000:0000:0001', 6)).toBe('loopback');
  });

  it('accepts plain http on the expanded loopback literal, like the compressed form', () => {
    expect(() => validateTransportUrl('http://[0:0:0:0:0:0:0:1]:3344/mcp')).not.toThrow();
  });

  it('does not widen the class: other addresses keep their previous verdict', () => {
    // The fix may only reclassify the exact loopback address; anything else
    // would relax a security gate rather than repair a spelling dependence.
    expect(classifyTransportAddress('::2', 6)).toBe('private');
    expect(classifyTransportAddress('fc00::1', 6)).toBe('private');
    expect(classifyTransportAddress('fd00::200:5efe:7f00:1', 6)).toBe('private');
    expect(classifyTransportAddress('fd00:ec2:0:0:0:0:0:254', 6)).toBe('blocked');
    expect(() => validateTransportUrl('http://[::2]:3344/mcp')).toThrow(/loopback/);
  });
});
