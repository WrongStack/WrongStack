import { decodeProtocolMessage } from '@wrongstack/webui-protocol';
import { replyFailure } from './engine-operations';
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
    // A failed lookup (services still starting) is not remembered: the next caller retries.
    this.pending ??= this.locate().catch((error: unknown) => {
      this.pending = undefined;
      throw error;
    });
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

/**
 * Asks a project's engine once and waits for the reply on the journal's live end. A view that
 * only needs one answer (the composer's prompt recall and its file or skill suggestions) must
 * not open the project's full reader: that replays the whole project journal first, which on a
 * long-lived project is hundreds of megabytes read before the reply can even be seen.
 */
export async function projectRequest(
  projectId: string,
  type: string,
  payload: Record<string, unknown>,
  replies: readonly string[],
  {
    timeoutMs = 15000,
    tail = journalTail(projectId),
  }: { timeoutMs?: number; tail?: JournalTail } = {},
): Promise<Record<string, unknown>> {
  const requestId = crypto.randomUUID();
  const message = { type, payload: { ...payload, requestId } };
  const decoded = decodeProtocolMessage(message, 'client');
  if (!decoded.ok) throw new Error(decoded.issue.message);
  let stop = () => {};
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The project engine did not answer. Try again in a moment.')),
        timeoutMs,
      );
      stop = tail.listen((event) => {
        if (event.payload['requestId'] !== requestId) return;
        if (!replies.includes(event.type) && event.type !== 'error') return;
        clearTimeout(timer);
        const failure = replyFailure(event);
        if (failure) reject(failure);
        else resolve(event.payload);
      });
      // Sent once the tail has a position, so the reply cannot land before the tail reads.
      void tail
        .ready()
        .then(() => request('project.send', { projectId, message }))
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  } finally {
    stop();
  }
}
