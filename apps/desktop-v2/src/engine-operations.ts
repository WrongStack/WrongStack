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

/** The error a reply carries, or null when it reports success. */
export function replyFailure(event: EngineEvent): EngineReplyError | null {
  const p = event.payload;
  if (
    event.type !== 'error' &&
    p['success'] !== false &&
    p['ok'] !== false &&
    typeof p['error'] !== 'string'
  )
    return null;
  return new EngineReplyError(String(p['error'] ?? p['message'] ?? 'Engine request failed.'), {
    ...p,
  });
}

/**
 * Requests the engine answers only after saving the profile config. It waits up to 15 s for
 * that file's lock first (another engine or the CLI writing it), so a request timed out at the
 * same 15 s reported "did not acknowledge" just before the engine's own answer arrived (#448).
 */
const CONFIG_WRITE_REQUESTS: ReadonlySet<string> = new Set(['model.switch']);
const CONFIG_WRITE_TIMEOUT_MS = 45_000;

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
      const timeoutMs =
        options?.timeoutMs ??
        (CONFIG_WRITE_REQUESTS.has(type)
          ? Math.max(this.timeoutMs, CONFIG_WRITE_TIMEOUT_MS)
          : this.timeoutMs);
      const timer = this.arm(requestId, this.live ? timeoutMs : this.replayCapMs);
      this.pending.set(requestId, { replies, resolve, reject, timer, timeoutMs });
      const onFailure = (error: unknown) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      try {
        void Promise.resolve(this.send(type, { ...payload, requestId })).catch(onFailure);
      } catch (error) {
        onFailure(error);
      }
    });
  };
  receive(event: EngineEvent): void {
    if (!event?.payload || typeof event.payload !== 'object') return;
    const id = event.payload['requestId'];
    if (typeof id !== 'string') return;
    const pending = this.pending.get(id);
    if (!pending || (!pending.replies.includes(event.type) && event.type !== 'error')) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const failure = replyFailure(event);
    if (failure) pending.reject(failure);
    else pending.resolve(event.payload);
  }
  clear(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const pending of entries) {
      clearTimeout(pending.timer);
      pending.reject(new Error('This workspace was detached. Reopen it to check the result.'));
    }
  }
}
