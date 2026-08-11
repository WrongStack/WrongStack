import { createHash } from 'node:crypto';
import type { Message } from '../types/messages.js';
import type { Request } from '../types/provider.js';

/**
 * Idea #2 from IDEAS.md — Deterministic Replay.
 *
 * The hash function is the foundation of replay: given a `Request`,
 * produce a stable identifier so a recorded `Response` can be looked
 * up later when we want to "re-run" the same agent loop without
 * burning API credits.
 *
 * Stability rules:
 *
 *   - All object keys are sorted recursively before stringification.
 *     Without this, two semantically identical requests that differ
 *     only in key insertion order would produce different hashes.
 *   - We hash ONLY the fields that affect the response: `model`,
 *     `system`, `messages`, `tools`, `maxTokens`, and the four
 *     sampling knobs (`temperature`, `topP`, `stopSequences`,
 *     `toolChoice`). Anything else on the `Request` (metadata,
 *     future extensions) is ignored so replay stays forward-compat.
 *   - The same rule applies *inside* each message. `Request.messages`
 *     is the live `ctx.messages` array, whose entries carry local
 *     bookkeeping the provider adapters explicitly drop: `ts` (wall
 *     clock at the moment the turn was created), `_estTokens` (a
 *     mutation-time cache) and `origin`. Hashing those made every
 *     hash a function of when the run happened, so a recorded
 *     response could never be found again and `mode: 'replay'` threw
 *     on the first call it was asked to serve. See
 *     {@link semanticMessage}.
 *   - We serialize to JSON. The `ContentBlock` and `Message` shapes
 *     are pure data; this works as long as no `undefined` values
 *     sneak in (those get dropped by `JSON.stringify`, which is
 *     fine — the structural diff is what matters).
 *
 * The SHA-256 output is hex-encoded and prefixed with the algorithm
 * tag so a future migration to a different hash (e.g. blake3) is
 * trivial to detect.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Strip a message down to what the provider actually receives.
 *
 * `ts`, `_estTokens` and `origin` are documented on {@link Message} as local
 * fields the adapters ignore. Two runs that produce the identical conversation
 * differ in all three, so they must not reach the digest.
 */
function semanticMessage(message: Message): Omit<Message, 'ts' | '_estTokens' | 'origin'> {
  const { ts: _ts, _estTokens: _estimate, origin: _origin, ...semantic } = message;
  return semantic;
}

export function hashRequest(request: Request): string {
  // Pick only the fields that affect the response. See stability rules.
  const payload = {
    model: request.model,
    system: request.system,
    messages: request.messages.map(semanticMessage),
    tools: request.tools,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    topP: request.topP,
    stopSequences: request.stopSequences,
    toolChoice: request.toolChoice,
  };
  const json = stableStringify(payload);
  const digest = createHash('sha256').update(json, 'utf8').digest('hex');
  return `sha256:${digest}`;
}
