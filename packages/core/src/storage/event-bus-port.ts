/**
 * Event-bus port for the storage area.
 *
 * Storage modules receive a bus instance from the composition root and use
 * it only to *emit* `storage.*` events (verified: zero subscribe/logger/
 * constructor calls across packages/core/src/storage). Importing the concrete
 * `EventBus` class from `../kernel/events.js` kept a storage → kernel edge in
 * the dependency graph; this port severs it.
 *
 * Structurally satisfied by the kernel `EventBus` class (its typed-generic
 * `emit` is compatible with this loose signature via method-bivariance), so
 * composition-root wiring needs no adapter.
 *
 * Surface policy: emit-only. If a storage consumer ever needs to subscribe,
 * widen this port deliberately instead of re-importing the kernel type.
 */
export interface EventBus {
  /**
   * Emit a storage-domain event onto the bus.
   *
   * Loose parameter typing is deliberate: the concrete kernel bus carries the
   * full `EventMap` typing; storage call sites pass literal `'storage.*'`
   * names whose payloads the kernel map validates at the wiring boundary.
   */
  emit(event: string, payload?: unknown): void;
}
