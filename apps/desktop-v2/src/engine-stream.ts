import { decodeProtocolMessage } from '@wrongstack/webui-protocol';
import { EngineOperations } from './engine-operations';
import { emptyEngineState, engineEvent, replayEngineBatch } from './engine-state';
import { type MemoryReviews, mergeMemoryReviews } from './memory-reviews';
import { request } from './platform';

export type BackendScope = 'engine' | 'project' | 'profile';
type EngineState = ReturnType<typeof replayEngineBatch>;
type EngineEvent = NonNullable<ReturnType<typeof engineEvent>>;
type Subscriber = { changed: () => void; onError: (error: unknown) => void };
/** Readers kept with their state after their last view closed, most recently used last. */
export const DORMANT_STREAM_LIMIT = 8;

/**
 * One journal reader per backend. Every view of the same project used to replay the whole
 * project journal on its own; they now share the reader, its state and its acknowledgements,
 * and a view that opens later starts from the state already read.
 *
 * A reader whose last view closed keeps its state and journal position, so going back to a
 * conversation continues where it was instead of replaying it from its first message.
 */
export class BackendStream {
  state: EngineState = { ...emptyEngineState, hydrating: true, synced: false };
  readonly operations: EngineOperations;
  private subscribers = new Set<Subscriber>();
  private listeners = new Set<(event: EngineEvent) => void>();
  private stopped = true;
  private run = 0;
  private offset = 0;
  private read = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private scope: BackendScope,
    private id: string,
    private registry: Map<string, BackendStream>,
  ) {
    this.operations = new EngineOperations(this.send);
  }
  /** Whether a view keeps this reader running now. */
  get open(): boolean {
    return !this.stopped;
  }
  private target() {
    return this.scope === 'project' ? { projectId: this.id } : { id: this.id };
  }
  send = async (type: string, payload: Record<string, unknown> = {}) => {
    const message = { type, payload };
    const decoded = decodeProtocolMessage(message, 'client');
    if (!decoded.ok) throw new Error(decoded.issue.message);
    await request(`${this.scope}.send`, { ...this.target(), message });
  };
  private error(error: unknown) {
    for (const subscriber of this.subscribers) subscriber.onError(error);
  }
  /**
   * Calls `listener` with every event this reader reads from now on, while a view keeps the
   * reader running; returns the unsubscribe.
   */
  listen(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.stopped) this.start();
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.stop();
    };
  }
  private key() {
    return `${this.scope}:${this.id}`;
  }
  private start() {
    this.stopped = false;
    this.registry.set(this.key(), this);
    // A quick unsubscribe and resubscribe (React StrictMode) must not leave two readers running.
    const run = ++this.run;
    if (!this.read) {
      this.offset = 0;
      this.state = { ...emptyEngineState, hydrating: true, synced: false };
      this.read = true;
    }
    this.operations.replaying();
    const poll = async () => {
      try {
        const result = await request<{
          offset: number;
          events: unknown[];
          hasMore?: boolean;
          size?: number;
        }>(`${this.scope}.events`, { ...this.target(), offset: this.offset });
        if (run !== this.run || this.stopped) return;
        const hasMore =
          result.hasMore ?? (result.events.length === 200 || result.offset - this.offset >= 262144);
        this.offset = result.offset;
        const events = result.events.map(engineEvent).filter((event) => event !== null);
        for (const event of events) {
          this.operations.receive(event);
          for (const listener of this.listeners) listener(event);
        }
        if (!hasMore) this.operations.caughtUp();
        if (this.scope === 'engine' && events.some((event) => event.type === 'run.result'))
          void this.send('stats.get').catch((error) => this.error(error));
        // An idle poll changes nothing, so it does not re-render every view ten times a second.
        if (events.length || this.state.hydrating !== hasMore) {
          this.state = replayEngineBatch(this.state, events, hasMore, {
            read: result.offset,
            total: result.size ?? 0,
          });
          for (const subscriber of this.subscribers) subscriber.changed();
        }
        this.timer = setTimeout(poll, hasMore ? 0 : 100);
      } catch (error) {
        if (run === this.run && !this.stopped) {
          this.error(error);
          this.timer = setTimeout(poll, 1000);
        }
      }
    };
    void poll();
  }
  private stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.operations.clear();
    if (this.registry.get(this.key()) !== this) return;
    // Most recently closed last; the oldest closed readers beyond the limit are dropped.
    this.registry.delete(this.key());
    this.registry.set(this.key(), this);
    const dormant = [...this.registry].filter(([, stream]) => stream.stopped);
    for (const [key] of dormant.slice(0, Math.max(0, dormant.length - DORMANT_STREAM_LIMIT)))
      this.registry.delete(key);
  }
}

const streams = new Map<string, BackendStream>();
/**
 * How far this window has read a backend's journal, for the reconnect diagnostics; null when
 * nothing has read it, or its reader was dropped with the oldest closed ones.
 */
export function journalReader(scope: BackendScope, id: string) {
  const stream = streams.get(`${scope}:${id}`);
  if (!stream) return null;
  const { hydrating, replay, lastAt, sessionId, messages } = stream.state;
  return { open: stream.open, hydrating, replay, lastAt, sessionId, messages: messages.length };
}
/** The newest memory reviews every project reader of this window has read. */
export function projectMemoryReviews(): MemoryReviews {
  return mergeMemoryReviews(
    [...streams].flatMap(([key, stream]) =>
      key.startsWith('project:') ? [stream.state.memoryReviews] : [],
    ),
  );
}
export function backendStream(scope: BackendScope, id: string): BackendStream {
  const key = `${scope}:${id}`;
  let stream = streams.get(key);
  if (!stream) {
    stream = new BackendStream(scope, id, streams);
    streams.set(key, stream);
  }
  return stream;
}
