/**
 * Binary frame protocol for the codebase-index IPC server.
 *
 * Replaces newline-delimited JSON with a length-prefixed MessagePack binary
 * format. The first byte of every frame is a magic value that distinguishes
 * binary from JSON — so a mixed-protocol socket is never ambiguous:
 *
 *  - `0x57` ('W') → binary frame: [magic] [uint32 BE length] [MessagePack]
 *  - anything else → the byte is part of a JSON text line terminated by `\n`
 *
 * There is no negotiated mode switch — the receiver sniffs every frame's
 * first byte (see `consume()` in project-server.ts and the client's unified
 * reader), so JSON and binary frames interleave freely on one socket:
 *  - the server's `hello` frame advertises `binarySupported: true` (always
 *    JSON, so any client can read it);
 *  - a client that wants binary simply sends binary frames
 *    (opt-in via WRONGSTACK_INDEX_BINARY=1 — the benchmark showed NDJSON is
 *    faster for this workload, so it stays the default);
 *  - the server answers each request in that request's framing, and latches
 *    outbound to binary once a client has sent any binary frame.
 *
 * Backward compatibility: a JSON-only client never sees a binary byte, and a
 * binary client's frames are self-describing — the protocolVersion + buildId
 * handshake already prevents a binary build from talking to a JSON-only build
 * of a different version (the buildId changes when the compiled artifact
 * changes), so there is no protocol ambiguity in practice.
 */

import { decode, encode } from '@msgpack/msgpack';

/** Magic byte that prefixes every binary frame. 'W' for WrongStack. */
const BINARY_FRAME_MAGIC = 0x57;

/**
 * Hard cap on one binary frame's declared payload length for the CLIENT
 * reader (project-server-client.ts). A malformed or hostile peer could
 * claim a 4 GiB frame and stall the reader; this bound is far above any
 * legitimate IPC response.
 *
 * Direction split is deliberate, not an oversight: the server enforces a
 * much tighter inbound cap (MAX_INBOUND_BINARY_FRAME_BYTES, 64 Mi) because
 * requests are small by construction and readable before auth; the client
 * accepts larger frames because server responses (search results, symbol
 * graphs) are the big direction. The two constants are intentionally
 * separate — do not "unify" them: raising the server's inbound ceiling to
 * match would widen the unauthenticated write surface, and lowering the
 * client's read ceiling to match would reject legitimate large responses.
 * Both directions also cap JSON text frames at their own ceilings, so
 * neither framing offers the larger write than the other on its side.
 */
export const MAX_BINARY_FRAME_BYTES = 256 * 1024 * 1024;

/**
 * Cap on one INBOUND (client → server) binary frame. Requests are tiny (an
 * op name plus a few arguments; the largest is an explicit reindex file
 * list), and unlike responses this direction is readable before any auth
 * check — a local client could otherwise declare a huge frame and make the
 * server wait for and accumulate it. The check runs the moment the five-byte
 * header is complete, so the connection is destroyed without ever buffering
 * toward the declared length (bytes already delivered in the current socket
 * chunk are freed with the destroyed connection). Matches the JSON request
 * ceiling (PROJECT_INDEX_SERVER_MAX_FRAME_CHARS, 64 Mi) so neither framing
 * offers a larger unauthenticated write than the other.
 */
export const MAX_INBOUND_BINARY_FRAME_BYTES = 64 * 1024 * 1024;

/** True if a byte stream begins with the binary-frame magic. */
export function isBinaryFrame(firstByte: number): boolean {
  return firstByte === BINARY_FRAME_MAGIC;
}

/**
 * Encode a message as a binary frame: [magic] [uint32 BE length] [MessagePack].
 * Returns a single Buffer ready to write to the socket.
 *
 * `undefined`-valued properties are stripped before encoding: MessagePack
 * would encode them as `nil` (arriving as `null`), while the JSON framing
 * drops them entirely — callers must not observe a different payload shape
 * just because they negotiated binary. Plain objects are normalized
 * recursively, and a small allowlist of well-known class instances is
 * converted to deterministic JSON-framing shapes (see normalizeUndefined)
 * so the same payload does not shape-shift between framings.
 */
export function encodeBinaryFrame(message: unknown): Buffer {
  const payload = encode(normalizeUndefined(message));
  const header = Buffer.allocUnsafe(5);
  header[0] = BINARY_FRAME_MAGIC;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload], 5 + payload.length);
}

function normalizeUndefined(value: unknown): unknown {
  // Well-known class instances convert to the shapes clients expect instead
  // of MessagePack's native encodings, which shape-shift against JSON
  // framing: Date arrives as an ext-timestamp object (JSON delivers an ISO
  // string), Map/Set encode sparsely (JSON delivers {}), Error loses all
  // diagnostics. RegExp/URL stringify to their canonical source/href form;
  // Buffer converts via toJSON() — byte-identical with JSON framing.
  if (value instanceof Date) {
    // An invalid Date (NaN time) stringifies as null in JSON framing; the
    // binary path must agree — toISOString() throws "Invalid time value"
    // where JSON.stringify silently delivers null. Neither framing may
    // crash the daemon on a payload the other framing accepts.
    const time = value.getTime();
    return Number.isNaN(time) ? null : value.toISOString();
  }
  if (value instanceof Map) return normalizeUndefined(Object.fromEntries(value));
  if (value instanceof Set) return normalizeUndefined([...value]);
  if (value instanceof Error) {
    return normalizeUndefined({ name: value.name, message: value.message, stack: value.stack });
  }
  if (value instanceof RegExp) return String(value);
  if (value instanceof URL) return value.toJSON();
  if (Buffer.isBuffer(value)) return { type: 'Buffer', data: [...value] };
  // Arrays of plain objects are the standard response shape (`SearchResult[]`
  // carries `lspKind: undefined`) — recurse element-wise, preserving the array.
  if (Array.isArray(value)) return value.map((entry) => normalizeUndefined(entry));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = normalizeUndefined(entry);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  // Guards FIRST: Object.getPrototypeOf(null/undefined) throws TypeError, and
  // null values reach normalizeUndefined on every ping response
  // (updatedAt: null / lastError: null). Hoisting the proto lookup above
  // these guards crashed the daemon on its first authorized binary reply.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // Object.create(null) objects must count as plain: reviver-based parse
  // paths and Object.assign(Object.create(null), …) payloads appear in
  // request arguments. Rejecting them would skip the undefined-stripping
  // recursion, so the same payload would shape-shift between framings
  // (JSON drops undefined keys; MessagePack would deliver them as null).
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Decode a MessagePack payload (the bytes after the magic + length header).
 * Throws if the payload is not valid MessagePack.
 */
export function decodeBinaryFrame(payload: Uint8Array): unknown {
  return decode(payload);
}

/**
 * Encode a message as a JSON text frame, terminated by `\n`.
 * This is the original wire format — kept for fallback and handshake.
 *
 * Parity invariant (bf-2): both framings deliver the SAME normalized tree.
 * JSON.stringify alone silently loses Map/Set/Error/RegExp payloads (`{}`
 * on the wire); routing through the shared normalizer makes a payload's
 * delivered shape independent of which framing carried it. A client that
 * negotiates binary — or fails to — sees identical data.
 */
export function encodeJsonFrame(message: unknown): string {
  return `${JSON.stringify(normalizeUndefined(message))}\n`;
}
