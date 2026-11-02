import type { EngineEvent } from './engine-state.js';

export type EngineSend = (type: string, payload?: Record<string, unknown>) => Promise<void>;
export type EngineCommand = (
  type: string,
  payload: Record<string, unknown>,
  replies: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<Record<string, unknown>>;

export class EngineReplyError extends Error {
  constructor(
    message: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'EngineReplyError';
  }
}

/**
 * Tracks acknowledgements without persisting outgoing payloads or credentials.
 *
 * A reply can only be seen once the event journal has been read up to it. A window that opens
 * replays the journal from its start, which takes a while for a long-lived project, so a
 * request's own timeout only starts once the replay has caught up (`caughtUp`); until then
 * only a generous cap applies.
 */
export class EngineOperations {
  private pending = new Map<
    string,
    {
      replies: readonly string[];
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      timeoutMs: number;
    }
  >();
  private live = true;
  constructor(
    private send: EngineSend,
    private timeoutMs = 15000,
    private replayCapMs = 120000,
  ) {}
  private arm(requestId: string, ms: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      pending.reject(
        new Error(
          'The engine did not acknowledge this request. Refresh this workspace before retrying.',
        ),
      );
    }, ms);
  }
  /** The journal is being read from its start again; replies may still be behind. */
  replaying(): void {
    this.live = false;
  }
  /** The journal has been read up to now: every waiting request gets its own timeout. */
  caughtUp(): void {
    if (this.live) return;
    this.live = true;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.timer = this.arm(requestId, pending.timeoutMs);
    }
  }
  request: EngineCommand = (type, payload, replies, options) => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
      const timer = this.arm(requestId, this.live ? timeoutMs : this.replayCapMs);
      this.pending.set(requestId, { replies, resolve, reject, timer, timeoutMs });
      void this.send(type, { ...payload, requestId }).catch((error: unknown) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };
  receive(event: EngineEvent): void {
    const id = event.payload['requestId'];
    if (typeof id !== 'string') return;
    const pending = this.pending.get(id);
    if (!pending || (!pending.replies.includes(event.type) && event.type !== 'error')) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (
      event.type === 'error' ||
      event.payload['success'] === false ||
      event.payload['ok'] === false ||
      typeof event.payload['error'] === 'string'
    )
      pending.reject(
        new EngineReplyError(
          String(event.payload['error'] ?? event.payload['message'] ?? 'Engine request failed.'),
          { ...event.payload },
        ),
      );
    else pending.resolve(event.payload);
  }
  clear(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('This workspace was detached. Reopen it to check the result.'));
    }
    this.pending.clear();
  }
}
