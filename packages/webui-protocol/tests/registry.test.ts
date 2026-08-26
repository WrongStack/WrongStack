/**
 * Regression tests for the message-type registry.
 *
 * The registry is the source of truth for which wire types each direction
 * (client / server) accepts. The decoder delegates to `isRegisteredMessageType`
 * for unknown-type rejection — if a type is missing here, the decoder
 * silently drops the frame. Pin coverage here so additions to the per-domain
 * `*_MESSAGE_TYPES` arrays stay in sync.
 */

import { describe, expect, it } from 'vitest';
import {
  CLIENT_MESSAGE_TYPES,
  isRegisteredMessageType,
  negotiateProtocol,
  protocolAdvertisement,
  SERVER_MESSAGE_TYPES,
  SURFACE_PROTOCOL_CAPABILITIES,
  SURFACE_PROTOCOL_VERSION,
} from '../src/index.js';

describe('CLIENT_MESSAGE_TYPES', () => {
  it('contains no duplicates', () => {
    const seen = new Set(CLIENT_MESSAGE_TYPES);
    expect(seen.size).toBe(CLIENT_MESSAGE_TYPES.length);
  });

  it('all entries are non-empty strings', () => {
    for (const type of CLIENT_MESSAGE_TYPES) {
      expect(typeof type).toBe('string');
      expect(type.length).toBeGreaterThan(0);
    }
  });
});

describe('SERVER_MESSAGE_TYPES', () => {
  it('contains no duplicates', () => {
    const seen = new Set(SERVER_MESSAGE_TYPES);
    expect(seen.size).toBe(SERVER_MESSAGE_TYPES.length);
  });

  it('all entries are non-empty strings', () => {
    for (const type of SERVER_MESSAGE_TYPES) {
      expect(typeof type).toBe('string');
      expect(type.length).toBeGreaterThan(0);
    }
  });

  it('contains session.start (used in decoder/connection-fsm coverage)', () => {
    expect(SERVER_MESSAGE_TYPES).toContain('session.start');
  });
});

describe('isRegisteredMessageType', () => {
  it('accepts exact client types', () => {
    expect(isRegisteredMessageType('ping', 'client')).toBe(true);
    expect(isRegisteredMessageType('session.new', 'client')).toBe(true);
  });

  it('rejects client types on the server direction', () => {
    expect(isRegisteredMessageType('ping', 'server')).toBe(false);
  });

  it('accepts exact server types', () => {
    expect(isRegisteredMessageType('session.start', 'server')).toBe(true);
    expect(isRegisteredMessageType('pong', 'server')).toBe(true);
  });

  it('rejects server types on the client direction', () => {
    expect(isRegisteredMessageType('session.start', 'client')).toBe(false);
  });

  it('accepts kanban.* extension types on both directions', () => {
    expect(isRegisteredMessageType('kanban.move_card', 'client')).toBe(true);
    expect(isRegisteredMessageType('kanban.move_card', 'server')).toBe(true);
  });

  it('rejects bare kanban. prefix', () => {
    expect(isRegisteredMessageType('kanban.', 'client')).toBe(false);
    expect(isRegisteredMessageType('kanban.', 'server')).toBe(false);
  });

  it('accepts agent-roster.* extension types on both directions', () => {
    expect(isRegisteredMessageType('agent-roster.update', 'client')).toBe(true);
    expect(isRegisteredMessageType('agent-roster.update', 'server')).toBe(true);
  });

  it('rejects bare agent-roster. prefix', () => {
    expect(isRegisteredMessageType('agent-roster.', 'client')).toBe(false);
  });

  it('rejects unknown prefixes', () => {
    expect(isRegisteredMessageType('unknown.message', 'client')).toBe(false);
    expect(isRegisteredMessageType('unknown.message', 'server')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isRegisteredMessageType('', 'client')).toBe(false);
    expect(isRegisteredMessageType('', 'server')).toBe(false);
  });
});

describe('protocolAdvertisement', () => {
  it('returns the current protocol version', () => {
    const ad = protocolAdvertisement();
    expect(ad.protocolVersion).toBe(SURFACE_PROTOCOL_VERSION);
  });

  it('returns a copy of the capability list (caller cannot mutate source)', () => {
    const ad = protocolAdvertisement();
    expect(ad.protocolCapabilities).toEqual([...SURFACE_PROTOCOL_CAPABILITIES]);
    expect(ad.protocolCapabilities).not.toBe(SURFACE_PROTOCOL_CAPABILITIES);
  });
});

describe('negotiateProtocol', () => {
  it('marks a peer without version as legacy', () => {
    const result = negotiateProtocol({});
    expect(result.legacyPeer).toBe(true);
    expect(result.compatible).toBe(true);
    expect(result.version).toBe(SURFACE_PROTOCOL_VERSION);
  });

  it('marks a peer with the current version as compatible', () => {
    const result = negotiateProtocol({
      protocolVersion: SURFACE_PROTOCOL_VERSION,
      protocolCapabilities: [...SURFACE_PROTOCOL_CAPABILITIES],
    });
    expect(result.compatible).toBe(true);
    expect(result.legacyPeer).toBe(false);
    expect(result.version).toBe(SURFACE_PROTOCOL_VERSION);
  });

  it('marks a peer below SURFACE_PROTOCOL_MIN_VERSION as incompatible', () => {
    const result = negotiateProtocol({
      protocolVersion: 0,
      protocolCapabilities: [],
    });
    expect(result.compatible).toBe(false);
  });

  it('marks a non-integer peer version as incompatible', () => {
    const result = negotiateProtocol({
      protocolVersion: 1.5,
      protocolCapabilities: [],
    });
    expect(result.compatible).toBe(false);
  });

  it('filters advertised capabilities to those we recognize', () => {
    const result = negotiateProtocol({
      protocolVersion: SURFACE_PROTOCOL_VERSION,
      protocolCapabilities: ['chronicle.query', 'unknown.capability'],
    });
    expect(result.capabilities).toEqual(['chronicle.query']);
  });

  it('returns no capabilities when peer advertises none', () => {
    const result = negotiateProtocol({
      protocolVersion: SURFACE_PROTOCOL_VERSION,
      protocolCapabilities: [],
    });
    expect(result.capabilities).toEqual([]);
  });

  it('caps the negotiated version at SURFACE_PROTOCOL_VERSION', () => {
    const result = negotiateProtocol({
      protocolVersion: SURFACE_PROTOCOL_VERSION + 100,
      protocolCapabilities: [],
    });
    expect(result.version).toBe(SURFACE_PROTOCOL_VERSION);
  });
});
