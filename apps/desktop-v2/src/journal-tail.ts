import { engineEvent } from './engine-state';
import { request } from './platform';

type Frame = NonNullable<ReturnType<typeof engineEvent>>;
type Listener = (event: Frame) => void;

/**
 * Follows what a project's engine writes from now on. A project journal holds every frame the
 * engine ever sent (hundreds of megabytes on a long-lived project), so a surface that asks and
 * waits for its own reply reads from the journal's end instead of behind a replay from its
 * start. One tail per project, running while anyone listens.
 */
export class JournalTail {
  private listeners = new Set<Listener>();
  private offset: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private run = 0;
  constructor(
    private projectId: string,
    private pollMs = 120,
  ) {}
  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }
  /** Resolves once the tail has a position, so a request sent after it is never missed. */
  ready(): Promise<void> {
    if (this.offset !== null) return Promise.resolve();
    this.pending ??= this.locate();
    return this.pending;
  }
  private pending: Promise<void> | undefined;
  private async locate() {
    let page = await request<{ offset: number; hasMore?: boolean; tail?: boolean }>(
      'project.events',
      { projectId: this.projectId, tail: true },
    );
    // A session host from an older build ignores `tail` and answers from the start: page to
    // the end without handing anything on, so old replies never reach a waiting surface.
    while (page.tail !== true && page.hasMore) {
      page = await request('project.events', { projectId: this.projectId, offset: page.offset });
    }
    this.offset ??= page.offset;
  }
  private start() {
    const run = ++this.run;
    const poll = async () => {
      try {
        await this.ready();
        const result = await request<{ offset: number; events: unknown[]; hasMore?: boolean }>(
          'project.events',
          { projectId: this.projectId, offset: this.offset },
        );
        if (run !== this.run) return;
        this.offset = result.offset;
        for (const event of result.events.map(engineEvent))
          if (event) for (const listener of this.listeners) listener(event);
        this.timer = setTimeout(poll, result.hasMore ? 0 : this.pollMs);
      } catch {
        if (run === this.run) this.timer = setTimeout(poll, 1000);
      }
    };
    void poll();
  }
  private stop() {
    this.run++;
    clearTimeout(this.timer);
    // The next listener starts from the end again, not from where this one left.
    this.offset = null;
    this.pending = undefined;
  }
}

const tails = new Map<string, JournalTail>();
export function journalTail(projectId: string): JournalTail {
  let tail = tails.get(projectId);
  if (!tail) {
    tail = new JournalTail(projectId);
    tails.set(projectId, tail);
  }
  return tail;
}
