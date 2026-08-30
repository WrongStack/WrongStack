/**
 * Regression tests for the surface-protocol version negotiation.
 *
 * `negotiateProtocol` decides whether a browser may talk to this server at
 * all. A regression here either locks out compatible clients or lets
 * incompatible ones through, so both sides of the boundary are pinned.
 */

import { describe, expect, it } from 'vitest';
import {
  negotiateProtocol,
  protocolAdvertisement,
  SURFACE_PROTOCOL_CAPABILITIES,
  SURFACE_PROTOCOL_MIN_VERSION,
  SURFACE_PROTOCOL_VERSION,
} from '../src/version.js';

describe('protocolAdvertisement', () => {
  it('advertises the current version and the full capability list', () => {
    const ad = protocolAdvertisement();
    expect(ad.protocolVersion).toBe(SURFACE_PROTOCOL_VERSION);
    expect(ad.protocolCapabilities).toEqual([...SURFACE_PROTOCOL_CAPABILITIES]);
  });

  it('hands out a copy of the capability list, not the shared constant', () => {
    const ad = protocolAdvertisement();
    (ad.protocolCapabilities as string[]).push('tampered');
    expect(SURFACE_PROTOCOL_CAPABILITIES).not.toContain('tampered');
  });
});

describe('negotiateProtocol', () => {
  it('treats a versionless peer as a legacy peer and offers the current version', () => {
    expect(negotiateProtocol({})).toEqual({
      compatible: true,
      legacyPeer: true,
      version: SURFACE_PROTOCOL_VERSION,
      capabilities: [],
    });
  });

  it('accepts the exact current version and intersects capabilities', () => {
    const result = negotiateProtocol({
      protocolVersion: SURFACE_PROTOCOL_VERSION,
      protocolCapabilities: SURFACE_PROTOCOL_CAPABILITIES,
    });
    expect(result).toEqual({
      compatible: true,
      legacyPeer: false,
      version: SURFACE_PROTOCOL_VERSION,
      capabilities: [...SURFACE_PROTOCOL_CAPABILITIES],
    });
  });

  it('negotiates down to an older-but-supported peer version', () => {
    const result = negotiateProtocol({ protocolVersion: SURFACE_PROTOCOL_MIN_VERSION });
    expect(result.compatible).toBe(true);
    expect(result.version).toBe(SURFACE_PROTOCOL_MIN_VERSION);
    expect(result.legacyPeer).toBe(false);
  });

  it('clamps a newer peer down to the local version', () => {
    const result = negotiateProtocol({ protocolVersion: SURFACE_PROTOCOL_VERSION + 9 });
    expect(result.compatible).toBe(true);
    expect(result.version).toBe(SURFACE_PROTOCOL_VERSION);
  });

  it('rejects versions below the minimum', () => {
    const result = negotiateProtocol({ protocolVersion: SURFACE_PROTOCOL_MIN_VERSION - 1 });
    expect(result.compatible).toBe(false);
    expect(result.legacyPeer).toBe(false);
  });

  it('rejects non-integer versions', () => {
    expect(negotiateProtocol({ protocolVersion: 1.5 }).compatible).toBe(false);
    expect(negotiateProtocol({ protocolVersion: Number.NaN }).compatible).toBe(false);
  });

  it('keeps only known capabilities from the peer advertisement', () => {
    const result = negotiateProtocol({
      protocolVersion: SURFACE_PROTOCOL_VERSION,
      protocolCapabilities: ['chronicle.query', 'not.a.capability', 'context.topic-boundary'],
    });
    expect(result.capabilities).toEqual(['chronicle.query', 'context.topic-boundary']);
  });

  it('returns no capabilities for a peer that advertises none', () => {
    expect(negotiateProtocol({ protocolVersion: SURFACE_PROTOCOL_VERSION }).capabilities).toEqual([]);
  });
});
