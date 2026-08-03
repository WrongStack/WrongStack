/**
 * Requirements Intake — domain event emitter.
 *
 * Events carry identifiers and safe metadata only — never a copy of the
 * user request. Pattern mirrors the Kanban board event emitter.
 */
import type { IntakeEvent, IntakeEventName } from './types.js';

type Listener = (event: IntakeEvent) => void;

/** Safety cap on listener sets; prevents unbounded memory growth. */
const MAX_LISTENERS = 200;

export class IntakeEventEmitter {
  private readonly listeners = new Set<Listener>();

  /** Publish an event. Listener errors are swallowed so one bad listener cannot break others. */
  emit(event: IntakeEventName, data: Omit<IntakeEvent, 'event' | 'timestamp'>): void {
    const payload: IntakeEvent = { event, timestamp: new Date().toISOString(), ...data };
    for (const listener of [...this.listeners]) {
      try {
        listener(payload);
      } catch {
        // Intentionally ignored — observers must not break the write path.
      }
    }
  }

  /** Subscribe; returns a disposer. Past the cap, returns a no-op disposer. */
  subscribe(listener: Listener): () => void {
    if (this.listeners.size >= MAX_LISTENERS) {
      const message =
        'Requirement intake event-emitter listener limit reached — callers must dispose subscriptions';
      if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
        process.emitWarning(message, 'IntakeEventEmitterWarning');
      }
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
