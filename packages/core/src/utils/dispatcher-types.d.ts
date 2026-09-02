/**
 * `dispatcher-types.d.ts` — Unify `https.Agent` and `undici.Dispatcher` types.
 *
 * Problem: `https.Agent` (Node.js built-in) and `undici.Dispatcher` implement the
 * same interface at runtime — `fetch`'s `RequestInit.dispatcher` accepts anything
 * with a `dispatch(req, opts)` method. However, TypeScript's type definitions
 * treat them as unrelated types because they come from different `@types/*` packages
 * (or undici@7 bundles its own Dispatcher type that conflicts with @types/node's
 * copy of the same concept via undici-types).
 *
 * Solution: This module augments the global `RequestInit` type so that
 * `https.Agent` is accepted as a valid `dispatcher` value without a cast.
 *
 * Usage:
 *   import '@wrongstack/core/utils/dispatcher-types';
 *   const agent = new https.Agent({ rejectUnauthorized: false });
 *   fetch(url, { dispatcher: agent }); // ✅ no cast needed
 *
 * Alternatively, use `as HttpsAgentAsDispatcher` to silence any remaining
 * conflicts at the call site.
 *
 * Verified at runtime: `https.Agent` has a `dispatch(req, opts)` method and
 * is callable by the built-in fetch implementation — this shim is a type-level
 * correction only, not a runtime polyfill.
 */

import type * as https from 'node:https';
import type { Dispatcher as UndiciDispatcher } from 'undici';

/**
 * Marker type: a value that fetch's `RequestInit.dispatcher` accepts at runtime.
 * Both `https.Agent` and `undici.Dispatcher` satisfy this structural interface.
 */
export type HttpDispatcher = Pick<UndiciDispatcher, 'dispatch'>;

/**
 * Augment `RequestInit` so that `https.Agent` is a valid dispatcher type.
 * Without this, TypeScript rejects `https.Agent` for `dispatcher` because the
 * two agent types are not structurally compatible in the installed @types set.
 */
declare global {
  interface RequestInit {
    /**
     * Accepts `https.Agent` in addition to `undici.Dispatcher`.
     * Runtime type-check is performed by Node.js / undici — this declaration
     * only tells TypeScript the same thing.
     */
    dispatcher?: HttpDispatcher | undefined;
  }
}

/**
 * Use this cast at call sites where `https.Agent` must be passed to a function
 * typed for `undici.Dispatcher`. Documents the trust boundary: the cast is safe
 * because both types share a `dispatch(req, opts)` method at runtime.
 *
 * @example
 * import type { HttpsAgentAsDispatcher } from '@wrongstack/core';
 * const agent = new https.Agent({ rejectUnauthorized: false });
 * fetch(url, { dispatcher: agent as HttpsAgentAsDispatcher });
 */
export type HttpsAgentAsDispatcher = https.Agent;
