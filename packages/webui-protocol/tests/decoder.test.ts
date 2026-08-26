/**
 * Regression tests for `decodeProtocolMessage` and `decodeProtocolFrame`.
 *
 * The decoder is the wire-format gate between every @wrongstack/webui-server
 * frame and the canonical message types in this package. If it silently
 * accepts an unknown type, drift between the two servers (standalone webui
 * and CLI --webui) hides until a client crashes. Pin the contract here.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeProtocolFrame,
  decodeProtocolMessage,
  SERVER_MESSAGE_TYPES,
} from '../src/index.js';

describe('decodeProtocolMessage', () => {
  it('rejects non-object envelopes', () => {
    const result = decodeProtocolMessage('not-an-object', 'server');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('invalid_envelope');
  });

  it('rejects null', () => {
    const result = decodeProtocolMessage(null, 'server');
    expect(result.ok).toBe(false);
  });

  it('rejects arrays', () => {
    const result = decodeProtocolMessage(['session.start'], 'server');
    expect(result.ok).toBe(false);
  });

  it('rejects missing or empty type', () => {
    expect(decodeProtocolMessage({}, 'server').ok).toBe(false);
    expect(decodeProtocolMessage({ type: '' }, 'server').ok).toBe(false);
    expect(decodeProtocolMessage({ type: 42 }, 'server').ok).toBe(false);
  });

  it('rejects unknown client message types', () => {
    const result = decodeProtocolMessage({ type: 'not.real.type' }, 'client');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('unknown_type');
  });

  it('accepts a known client type without payload', () => {
    const result = decodeProtocolMessage({ type: 'ping' }, 'client');
    expect(result.ok).toBe(true);
  });

  it('accepts a known server type with payload', () => {
    const result = decodeProtocolMessage(
      { type: 'session.start', payload: { sessionId: 's1' } },
      'server',
    );
    expect(result.ok).toBe(true);
  });

  it('requires payload on server messages', () => {
    const result = decodeProtocolMessage({ type: 'session.start' }, 'server');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('invalid_envelope');
  });

  it('rejects kanban. prefix without suffix', () => {
    const result = decodeProtocolMessage({ type: 'kanban.' }, 'server');
    expect(result.ok).toBe(false);
  });

  it('accepts kanban.* extension types', () => {
    const result = decodeProtocolMessage(
      { type: 'kanban.move_card', payload: {} },
      'server',
    );
    expect(result.ok).toBe(true);
  });

  it('accepts agent-roster.* extension types', () => {
    const result = decodeProtocolMessage(
      { type: 'agent-roster.update', payload: {} },
      'server',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects prototype pollution keys', () => {
    // Build the envelope programmatically so '__proto__' survives as an own
    // property of `payload`. Plain object literals and JSON.stringify both
    // silently filter __proto__ — that's the very behavior the decoder is
    // designed to defend against on the *receiving* end.
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const envelope = { type: 'session.start', payload };
    const result = decodeProtocolMessage(envelope, 'server');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code).toBe('unsafe_key');
      expect(result.issue.path).toBe('$.payload.__proto__');
    }
  });

  it('rejects constructor and prototype keys', () => {
    for (const key of ['constructor', 'prototype']) {
      const frame = JSON.stringify({
        type: 'session.start',
        payload: { [key]: 'x' },
      });
      const result = decodeProtocolFrame(frame, 'server');
      expect(result.ok, `key ${key} should be rejected`).toBe(false);
    }
  });

  it('rejects payloads deeper than MAX_PAYLOAD_DEPTH', () => {
    let payload: unknown = { leaf: 1 };
    for (let i = 0; i < 40; i++) payload = { nested: payload };
    const result = decodeProtocolMessage(
      { type: 'session.start', payload },
      'server',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('too_deep');
  });

  it('every registered server type round-trips', () => {
    for (const type of SERVER_MESSAGE_TYPES) {
      const result = decodeProtocolMessage({ type, payload: {} }, 'server');
      expect(result.ok, `server type ${type} should decode`).toBe(true);
    }
  });
});

describe('decodeProtocolFrame', () => {
  it('returns invalid_envelope on non-JSON input', () => {
    const result = decodeProtocolFrame('this is not json', 'client');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('invalid_envelope');
  });

  it('parses a valid JSON frame and delegates to decodeProtocolMessage', () => {
    const frame = JSON.stringify({ type: 'ping' });
    const result = decodeProtocolFrame(frame, 'client');
    expect(result.ok).toBe(true);
  });

  it('rejects a JSON array frame (decoder rejects arrays)', () => {
    const result = decodeProtocolFrame('[1,2,3]', 'client');
    expect(result.ok).toBe(false);
  });

  it('rejects a JSON frame whose type is unknown', () => {
    const result = decodeProtocolFrame(JSON.stringify({ type: 'fake.type' }), 'client');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('unknown_type');
  });

  it('rejects a JSON server frame without payload', () => {
    const result = decodeProtocolFrame(
      JSON.stringify({ type: 'session.start' }),
      'server',
    );
    expect(result.ok).toBe(false);
  });
});
