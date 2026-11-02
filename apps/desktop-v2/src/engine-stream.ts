import { decodeProtocolMessage } from '@wrongstack/webui-protocol';
import { EngineOperations } from './engine-operations';
import { emptyEngineState, engineEvent, replayEngineBatch } from './engine-state';
import { request } from './platform';

export type BackendScope = 'engine' | 'project' | 'profile';
type EngineState = ReturnType<typeof replayEngineBatch>;
type Subscriber = { changed: () => void; onError: (error: unknown) => void };

/**
 * One journal reader per backend. Every view of the same project used to replay the whole
 * project journal on its own; they now share the reader, its state and its acknowledgements,
 * and a view that opens later starts from the state already read.
 */
export class BackendStream {
  state: EngineState = { ...emptyEngineState, hydrating: true };
  readonly operations: EngineOperations;
  private subscribers = new Set<Subscriber>();
  private stopped = true;
  private run = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private scope: BackendScope,
    private id: string,
    private registry: Map<string, BackendStream>,
  ) {
    this.operations = new EngineOperations(this.send);
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
    let offset = 0;
    this.state = { ...emptyEngineState, hydrating: true };
    this.operations.replaying();
    const poll = async () => {
      try {
        const result = await request<{ offset: number; events: unknown[]; hasMore?: boolean }>(
          `${this.scope}.events`,
          { ...this.target(), offset },
        );
        if (run !== this.run || this.stopped) return;
        const hasMore =
          result.hasMore ?? (result.events.length === 200 || result.offset - offset >= 262144);
        offset = result.offset;
        const events = result.events.map(engineEvent).filter((event) => event !== null);
        for (const event of events) this.operations.receive(event);
        if (!hasMore) this.operations.caughtUp();
        if (this.scope === 'engine' && events.some((event) => event.type === 'run.result'))
          void this.send('stats.get').catch((error) => this.error(error));
        // An idle poll changes nothing, so it does not re-render every view ten times a second.
        if (events.length || this.state.hydrating !== hasMore) {
          this.state = replayEngineBatch(this.state, events, hasMore);
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
    if (this.registry.get(this.key()) === this) this.registry.delete(this.key());
  }
}

const streams = new Map<string, BackendStream>();
export function backendStream(scope: BackendScope, id: string): BackendStream {
  const key = `${scope}:${id}`;
  let stream = streams.get(key);
  if (!stream) {
    stream = new BackendStream(scope, id, streams);
    streams.set(key, stream);
  }
  return stream;
}
