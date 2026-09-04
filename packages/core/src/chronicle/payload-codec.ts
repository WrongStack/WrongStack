/**
 * Storage codec for the `events.payload` column.
 *
 * The journal stores each event as its canonical JSON text because the hash
 * preimage is derived from the *parsed* payload — see the header of
 * `sqlite-journal.ts`. That invariant is what makes `verify()` independent of
 * the projected columns, and it is deliberately kept here: this codec is a
 * byte-for-byte lossless transform of that same JSON text, applied on the way
 * to disk and undone on the way back. `decode(encode(json)) === json`, always.
 *
 * Why it exists: measured on a live 4-day journal (101k events, 151 MB of
 * payload), the average event was 1518 bytes of which roughly 60% was envelope
 * that repeats verbatim on every single row — the `scope` identity block, the
 * `correlation` keys, `schemaVersion`/`observedAt`/`persistedAt`/`sequence`,
 * and the two 64-char hex hashes. JSON of that shape is extremely compressible,
 * but only if the compressor is told about the repetition up front: at ~1.5 KB
 * a row, plain deflate never gets to build a useful window (measured 55% of
 * raw; gzip 55%, brotli q5 51%). Seeded with a fixed dictionary of the envelope
 * skeleton it reaches **41%** — a 2.4x reduction for one synchronous call per
 * append.
 *
 * The dictionary is frozen. Deflate needs the exact same bytes to inflate, so
 * changing it is a format change, never an edit: add a new format id and keep
 * the old dictionary readable forever.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** Plain UTF-8 JSON, stored as TEXT. Every pre-codec row is this. */
const FORMAT_PLAIN = 0x00;
/** `deflateRaw` seeded with {@link DICTIONARY_V1}, stored as BLOB. */
const FORMAT_DEFLATE_DICT_V1 = 0x01;

/**
 * Frozen deflate preset dictionary, v1.
 *
 * Not prose: a concatenation of the literal byte sequences that recur across
 * Chronicle payloads, ordered so the most frequent sit at the end (deflate
 * matches backwards from the dictionary's tail, so tail entries encode with
 * the shortest distances). Derived from a real journal, not guessed.
 *
 * NEVER edit this string. Inflating a v1 row requires these exact bytes.
 */
const DICTIONARY_V1 = Buffer.from(
  '"previousHash":"","hash":""}"observedAt":"","persistedAt":"","sequence":' +
    '"schemaVersion":1,"eventId":"","monotonicNs":"","occurredAt":"20"' +
    ',"tags":{"collector":"eventbus-domain","family":""}' +
    ',"attributes":{"sessionId":"","toolName":"","inputHash":"","outputHash":""' +
    ',"outputBytes":,"ok":true,"metadata":{"files":[],"symbols":[],"commands":[]}' +
    ',"signal":"","windowStart":"","windowEnd":"","samples":,"dimensions":{}' +
    ',"stats":{"sum":,"min":,"max":,"last":},"categories":{},"rawEventsRetained":false' +
    ',"resources":[{"id":"file_","kind":"file","path":"packages/core/src/"}],"resourceCount":}' +
    ',"resource":{"kind":"other","id":"sessionId:"}' +
    ',"runtime":{"providerId":"","modelId":""}' +
    ',"outcome":"success","started","failure","unknown"' +
    ',"correlation":{"traceId":"","spanId":"","logicalRequestId":"","promptManifestId":"prompt_","toolCallId":"call_"}' +
    ',"scope":{"installationId":"installation_","machineId":"machine_","projectId":"","workspaceId":"","sessionId":"","agentId":""}' +
    ',"eventType":"tool.executed","tool.started","metrics.rollup","metrics.counter"' +
    ',"provider.attempt.","iteration.","permission.evaluated","token.accounted"' +
    ',"file.external.modified","memory.injector_","subagent.","process."' +
    ',"agent.timeline.message","storage.write","provider.response","provider.stream.summarized"',
  'utf8',
);

/**
 * Below this, deflate's fixed overhead outweighs the win and the row is stored
 * as plain text. Keeps tiny synthetic events (and every test fixture that reads
 * the column directly) in a human-readable form.
 */
const MIN_COMPRESS_BYTES = 192;

/** What the `payload` column can hold: legacy/short text, or a codec BLOB. */
export type StoredChroniclePayload = string | Uint8Array;

/** Encode canonical event JSON for storage. Never throws: falls back to text. */
export function encodeChroniclePayload(json: string): StoredChroniclePayload {
  if (json.length < MIN_COMPRESS_BYTES) return json;
  try {
    const body = deflateRawSync(Buffer.from(json, 'utf8'), {
      level: 6,
      dictionary: DICTIONARY_V1,
    });
    // A payload that grew is a payload not worth decompressing on every read.
    if (body.length + 1 >= Buffer.byteLength(json, 'utf8')) return json;
    const out = Buffer.allocUnsafe(body.length + 1);
    out[0] = FORMAT_DEFLATE_DICT_V1;
    body.copy(out, 1);
    return out;
  } catch {
    return json;
  }
}

/**
 * Decode a stored payload back to its exact canonical JSON text.
 *
 * Rows written before the codec landed come back as `string` and pass straight
 * through, so an existing journal keeps reading and verifying with no
 * migration — the two forms coexist in the same table indefinitely.
 */
export function decodeChroniclePayload(stored: StoredChroniclePayload): string {
  if (typeof stored === 'string') return stored;
  const bytes = Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
  if (bytes.length === 0) return '';
  const format = bytes[0];
  if (format === FORMAT_DEFLATE_DICT_V1) {
    return inflateRawSync(bytes.subarray(1), { dictionary: DICTIONARY_V1 }).toString('utf8');
  }
  if (format === FORMAT_PLAIN) return bytes.subarray(1).toString('utf8');
  // Not a codec frame — a BLOB written by something else. Best effort.
  return bytes.toString('utf8');
}

/** Bytes this payload actually occupies in the column. */
export function chroniclePayloadStoredBytes(stored: StoredChroniclePayload): number {
  return typeof stored === 'string' ? Buffer.byteLength(stored, 'utf8') : stored.byteLength;
}
