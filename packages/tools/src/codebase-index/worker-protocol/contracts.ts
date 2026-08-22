/**
 * Leaf contract types shared by `index-service.ts` and `worker-protocol.ts`.
 *
 * Lives separately from `index-service.ts` so the worker protocol can import
 * these types type-only without depending on the implementation side, and
 * so the runtime side can re-export them for downstream consumers that already
 * reference them via the old path. Breaks the long-standing type-level SCC
 * ARCH-CYCLE-TYPE-28 where `index-service.ts` and `worker-protocol.ts` were
 * mutually importing contract types.
 *
 * This module MUST contain no runtime imports.
 */

import type { CallSite } from '../schema.js';

/** Result of an incoming calls query. */
export interface IncomingCallsResult {
  calls: CallSite[];
  symbolFound: boolean;
  /** True when `file` was scoped but the name is ambiguous (other files define it too). */
  ambiguous: boolean;
  /** Total matching call sites before the limit was applied. */
  totalMatches: number;
  /**
   * True when the project server served a previous generation's cached
   * answer while a refresh was publishing (stale-read serving). Never set by
   * the worker/inline path, which refuses reads during a refresh instead.
   */
  stale?: boolean | undefined;
}

/** Result of an outgoing calls query. */
export interface OutgoingCallsResult {
  calls: CallSite[];
  symbolFound: boolean;
  /** Number of refs whose target could not be resolved (to_id IS NULL). */
  unresolvedCount: number;
  /** Total matching call sites before the limit was applied. */
  totalMatches: number;
  /**
   * True when the project server served a previous generation's cached
   * answer while a refresh was publishing (stale-read serving). Never set by
   * the worker/inline path, which refuses reads during a refresh instead.
   */
  stale?: boolean | undefined;
}
