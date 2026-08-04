import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_MESSAGE_TYPES,
  decodeProtocolFrame,
  decodeProtocolMessage,
  negotiateProtocol,
  protocolAdvertisement,
  SERVER_MESSAGE_TYPES,
  SURFACE_PROTOCOL_VERSION,
} from '../src/protocol/index.js';

interface GoldenProtocolFixture {
  version: number;
  client: unknown[];
  server: unknown[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/protocol-v1.json', import.meta.url), 'utf8'),
) as GoldenProtocolFixture;

describe('surface protocol contract', () => {
  it('decodes the versioned cross-domain golden fixtures', () => {
    expect(fixture.version).toBe(SURFACE_PROTOCOL_VERSION);
    for (const message of fixture.client) {
      expect(decodeProtocolMessage(message, 'client')).toMatchObject({ ok: true });
    }
    for (const message of fixture.server) {
      expect(decodeProtocolMessage(message, 'server')).toMatchObject({ ok: true });
    }
  });

  it('keeps every exact registry entry executable through its directional decoder', () => {
    expect(new Set(CLIENT_MESSAGE_TYPES).size).toBe(224);
    expect(new Set(SERVER_MESSAGE_TYPES).size).toBe(237);
    for (const type of CLIENT_MESSAGE_TYPES) {
      expect(decodeProtocolMessage({ type }, 'client')).toEqual({
        ok: true,
        message: { type },
      });
    }
    for (const type of SERVER_MESSAGE_TYPES) {
      expect(decodeProtocolMessage({ type, payload: null }, 'server')).toEqual({
        ok: true,
        message: { type, payload: null },
      });
    }
  });

  it('accepts every prompt-library response emitted by the server', () => {
    const responseTypes = [
      'prompts.list',
      'prompts.search',
      'prompts.content',
      'prompts.favorite',
      'prompts.created',
      'prompts.used',
      'prompts.recent',
    ];

    for (const type of responseTypes) {
      expect(decodeProtocolMessage({ type, payload: {} }, 'server')).toMatchObject({ ok: true });
    }
  });

  it('supports the documented kanban extension namespace in both directions', () => {
    expect(decodeProtocolMessage({ type: 'kanban.custom' }, 'client').ok).toBe(true);
    expect(decodeProtocolMessage({ type: 'kanban.custom', payload: {} }, 'server').ok).toBe(true);
    expect(decodeProtocolMessage({ type: 'kanban.' }, 'client')).toMatchObject({
      ok: false,
      issue: { code: 'unknown_type' },
    });
  });

  it('rejects malformed, unknown, and payload-less server frames', () => {
    expect(decodeProtocolFrame('{', 'client')).toMatchObject({
      ok: false,
      issue: { code: 'invalid_envelope' },
    });
    expect(decodeProtocolMessage([], 'client')).toMatchObject({
      ok: false,
      issue: { code: 'invalid_envelope' },
    });
    expect(decodeProtocolMessage({ type: 'future.unknown' }, 'client')).toMatchObject({
      ok: false,
      issue: { code: 'unknown_type' },
    });
    expect(decodeProtocolMessage({ type: 'session.start' }, 'server')).toMatchObject({
      ok: false,
      issue: { code: 'invalid_envelope' },
    });
  });

  it('rejects unsafe keys recursively and caps hostile nesting', () => {
    const polluted = JSON.parse(
      '{"type":"user_message","payload":{"nested":{"__proto__":{"polluted":true}}}}',
    );
    expect(decodeProtocolMessage(polluted, 'client')).toMatchObject({
      ok: false,
      issue: { code: 'unsafe_key', path: '$.payload.nested.__proto__' },
    });

    let nested: Record<string, unknown> = {};
    const message = { type: 'user_message', payload: nested };
    for (let depth = 0; depth < 40; depth++) {
      nested['next'] = {};
      nested = nested['next'] as Record<string, unknown>;
    }
    expect(decodeProtocolMessage(message, 'client')).toMatchObject({
      ok: false,
      issue: { code: 'too_deep' },
    });
  });

  it('negotiates current peers while preserving version-less legacy clients', () => {
    const advertisement = protocolAdvertisement();
    expect(negotiateProtocol(advertisement)).toMatchObject({
      compatible: true,
      legacyPeer: false,
      version: SURFACE_PROTOCOL_VERSION,
      capabilities: advertisement.protocolCapabilities,
    });
    expect(negotiateProtocol({})).toMatchObject({
      compatible: true,
      legacyPeer: true,
      version: SURFACE_PROTOCOL_VERSION,
      capabilities: [],
    });
    expect(negotiateProtocol({ protocolVersion: 0 })).toMatchObject({ compatible: false });
  });
});
