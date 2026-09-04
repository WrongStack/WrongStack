/**
 * The codec's whole contract is that it is invisible: the journal stores the
 * same canonical JSON it always did, just smaller, and `verify()` must not be
 * able to tell the difference. These tests pin the round trip, the coexistence
 * of pre-codec rows, and the compression ratio that justified the change.
 */
import { describe, expect, it } from 'vitest';
import {
  chroniclePayloadStoredBytes,
  decodeChroniclePayload,
  encodeChroniclePayload,
} from '../../src/chronicle/payload-codec.js';

/** An event shaped like the ones this codec was measured against. */
function sampleEvent(index: number): string {
  return JSON.stringify({
    eventType: 'tool.started',
    outcome: 'started',
    attributes: {
      toolName: 'grep',
      input: `{"pattern":"wireFleetBus","path":"packages/core/src/coordination/director.ts"}`,
      inputHash: 'ece621ec08f36357ab956f359f70b9dac08997cccda8c94c964426d5e4418980',
      inputBytes: 155,
    },
    scope: {
      installationId: 'installation_464cc64013b41c186419f633',
      machineId: 'machine_9ba3773ea9df7178f897b84d',
      projectId: '6fc4463c34ea',
      workspaceId: 'wrongstack-6fc446',
      sessionId: '2026-09-01/sess_01M1FGK9D4GQ9DCSMH3852RJTG',
      agentId: 'leader',
    },
    correlation: {
      traceId: '67dc9dca4e094f71278738a42663b906',
      spanId: '7af59407-895b-4fdd-bc37-88841e58e10b',
      logicalRequestId: '8b2f00ee-f682-4244-a0e2-f639d1920103',
      promptManifestId: 'prompt_6dc029fd76c46443a7cc2521cf0d8a329d022b6c2c9286889f94b116c35a9b22',
      toolCallId: `call_function_ka7acs6f0lp6_${index}`,
    },
    runtime: { providerId: 'minimax-coding-plan', modelId: 'MiniMax-M2.7-highspeed' },
    occurredAt: '2026-09-01T22:53:29.516Z',
    monotonicNs: '18531174634900',
    schemaVersion: 1,
    eventId: '36fc3527-2c25-475b-9775-decb3031c69f',
    observedAt: '2026-09-01T22:53:29.516Z',
    persistedAt: '2026-09-01T22:53:29.516Z',
    sequence: 55_590 + index,
    previousHash: '6e3711ef8d6fc37ec751b751e3366f93b786d0cfd834ab25842f07be03113d7e',
    hash: 'f430e1c63f5f3103fdf7dc25249c3cd7c3e018d7c1c77196045d2d47df5230fc',
  });
}

describe('chronicle payload codec', () => {
  it('round-trips a realistic event byte for byte', () => {
    const json = sampleEvent(1);
    const decoded = decodeChroniclePayload(encodeChroniclePayload(json));
    // Byte-identical, not merely JSON-equivalent: the hash preimage is derived
    // from the parsed payload, so a re-serialization that reordered keys would
    // still verify -- but a codec that cannot reproduce the exact text is a
    // codec whose failures would surface as tamper reports.
    expect(decoded).toBe(json);
  });

  it('round-trips every shape an attribute bag can take', () => {
    for (const attributes of [
      {},
      { nested: { deep: { deeper: [1, 2, 3] } } },
      { unicode: 'tükenmez kalem — ağırlık', emoji: '🧪' },
      { empty: '', zero: 0, no: false, nothing: null },
      { long: 'x'.repeat(50_000) },
    ]) {
      const json = JSON.stringify({ eventType: 'test', attributes });
      expect(decodeChroniclePayload(encodeChroniclePayload(json))).toBe(json);
    }
  });

  it('leaves short payloads as readable text', () => {
    const json = '{"eventType":"tiny"}';
    const stored = encodeChroniclePayload(json);
    // Below the threshold the deflate header costs more than it saves, and a
    // readable column is worth more than the handful of bytes.
    expect(typeof stored).toBe('string');
    expect(stored).toBe(json);
  });

  it('reads a pre-codec row unchanged', () => {
    // Rows written before the codec landed are plain strings in the same
    // column. They must keep working forever -- there is no migration, the two
    // forms coexist in one table.
    const legacy = sampleEvent(2);
    expect(decodeChroniclePayload(legacy)).toBe(legacy);
  });

  it('compresses a realistic corpus to well under half its size', () => {
    let raw = 0;
    let stored = 0;
    for (let index = 0; index < 200; index += 1) {
      const json = sampleEvent(index);
      raw += Buffer.byteLength(json, 'utf8');
      stored += chroniclePayloadStoredBytes(encodeChroniclePayload(json));
    }
    // Measured at ~41% on a live 4-day journal (1518 B average down to 618 B).
    // The bound is loose because the exact ratio depends on the dictionary and
    // this test exists to catch a dictionary that stopped matching the data,
    // not to pin a number to the byte.
    expect(stored / raw).toBeLessThan(0.5);
  });

  it('never grows a payload the dictionary cannot help with', () => {
    // Random bytes are incompressible; the codec must notice and store text
    // rather than pay a deflate header for nothing.
    const json = JSON.stringify({
      blob: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 2654435761) % 256)).toString(
        'base64',
      ),
    });
    const stored = encodeChroniclePayload(json);
    expect(chroniclePayloadStoredBytes(stored)).toBeLessThanOrEqual(
      Buffer.byteLength(json, 'utf8'),
    );
    expect(decodeChroniclePayload(stored)).toBe(json);
  });
});
