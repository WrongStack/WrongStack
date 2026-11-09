/**
 * Applies each session's numbered frames in order across a reconnect.
 *
 * The server numbers every session-scoped broadcast (`seq`, per session; a
 * frame delivered to a tab other than the session its payload names also
 * carries `stream`). After a reconnect the page sends the last number it
 * applied per tab and gets back the frames it missed, followed by
 * `session.frames_resumed`. Live frames of the new connection can arrive
 * before that catch-up, so while a tab is resuming, a frame that skips ahead
 * waits here until the missing ones have been applied, and a frame that was
 * already applied is dropped.
 *
 * Outside a resume a gap is normal (frames broadcast while no tab showed the
 * session were never delivered) and is accepted as is.
 */

export interface SequencedFrame {
  seq?: unknown;
  stream?: unknown;
  payload?: unknown;
}

function frameSeq(msg: SequencedFrame): { sessionId: string; seq: number } | null {
  const seq = msg.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
  const payload = msg.payload as { sessionId?: unknown } | undefined;
  const sessionId =
    typeof msg.stream === 'string' && msg.stream.trim().length > 0
      ? msg.stream.trim()
      : payload && typeof payload === 'object'
        ? payload.sessionId
        : undefined;
  return typeof sessionId === 'string' && sessionId.trim().length > 0
    ? { sessionId: sessionId.trim(), seq }
    : null;
}

export class SessionFrameGate<T extends SequencedFrame> {
  private epoch: string | undefined;
  private readonly applied = new Map<string, number>();
  private readonly held = new Map<string, Map<number, T>>();
  private readonly resuming = new Set<string>();

  /**
   * The epoch of a new connection's `session.start`. A different one means the
   * server process changed and every cursor is meaningless: held frames are
   * released and the numbering starts over.
   */
  adoptEpoch(epoch: string): T[] {
    if (epoch === this.epoch) return [];
    const released = this.releaseAll();
    this.applied.clear();
    this.epoch = epoch;
    return released;
  }

  /** Cursors worth sending for `sessionIds`, or null when nothing can be resumed. */
  cursors(
    sessionIds: readonly string[],
  ): { eventEpoch: string; cursors: Record<string, number> } | null {
    if (!this.epoch) return null;
    const entries: [string, number][] = [];
    for (const id of sessionIds) {
      const seq = this.applied.get(id);
      if (seq !== undefined) entries.push([id, seq]);
    }
    // Preserve special session ids as own properties without invoking setters.
    const cursors = Object.fromEntries(entries);
    return Object.keys(cursors).length > 0 ? { eventEpoch: this.epoch, cursors } : null;
  }

  beginResume(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) this.resuming.add(id);
  }

  isResuming(sessionId: string): boolean {
    return this.resuming.has(sessionId);
  }

  /** The frames to apply now, in order, for one frame that arrived. */
  accept(msg: T): T[] {
    const at = frameSeq(msg);
    if (!at) return [msg];
    const last = this.applied.get(at.sessionId);
    if (last !== undefined && at.seq <= last) return [];
    if (this.resuming.has(at.sessionId) && last !== undefined && at.seq > last + 1) {
      let held = this.held.get(at.sessionId);
      if (!held) {
        held = new Map();
        this.held.set(at.sessionId, held);
      }
      held.set(at.seq, msg);
      return [];
    }
    this.applied.set(at.sessionId, at.seq);
    return [msg, ...this.drainContiguous(at.sessionId, at.seq)];
  }

  /** The catch-up for one tab is complete (or refused): release what waited. */
  finishResume(sessionId: string): T[] {
    if (!this.resuming.delete(sessionId)) return [];
    return this.release(sessionId);
  }

  /** Clear sequence state for one session when `session.start` has `reset: true`. */
  resetSession(sessionId: string): void {
    this.resuming.delete(sessionId);
    this.held.delete(sessionId);
    this.applied.delete(sessionId);
  }

  /** Give up on every catch-up still pending (no answer came). */
  releaseAll(): T[] {
    const out: T[] = [];
    for (const id of [...this.resuming]) out.push(...this.finishResume(id));
    this.resuming.clear();
    return out;
  }

  /**
   * Frames held for `sessionId` that now follow on from `last`. A held frame
   * is always newer than `last + 1` when it is stored, and `last` only moves
   * through here or through `release`, which empties the hold.
   */
  private drainContiguous(sessionId: string, last: number): T[] {
    const held = this.held.get(sessionId);
    if (!held) return [];
    const out: T[] = [];
    for (;;) {
      const next = held.get(last + 1);
      if (!next) break;
      held.delete(last + 1);
      out.push(next);
      last += 1;
    }
    this.applied.set(sessionId, last);
    if (held.size === 0) this.held.delete(sessionId);
    return out;
  }

  /**
   * Everything held for a session, in order, gaps accepted. Every held frame
   * is newer than the last applied one (see `drainContiguous`).
   */
  private release(sessionId: string): T[] {
    const held = this.held.get(sessionId);
    this.held.delete(sessionId);
    if (!held) return [];
    // A hold is dropped once it is empty, so there is a newest frame.
    let newest = Number.NEGATIVE_INFINITY;
    for (const seq of held.keys()) newest = Math.max(newest, seq);
    this.applied.set(sessionId, newest);
    return [...held.entries()].sort(([a], [b]) => a - b).map(([, msg]) => msg);
  }
}

/**
 * The host's timers. This module runs in browsers and in Node, and the lib it
 * is compiled against declares neither's. Read at call time, so fake timers
 * in tests still apply.
 */
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** How long a reconnect waits for its catch-up before accepting the gap. */
const FRAME_RESUME_TIMEOUT_MS = 5_000;

/** Replay fields of `session.start`; see replay-payload.ts. */
const REPLAY_FIELDS = ['replayMessages', 'replayMarkers', 'replayToolMeta', 'replayUsage'] as const;

/**
 * The client's side of the reconnect catch-up: the gate, plus the give-up
 * timer and the `session.start` handling that go with it.
 */
export class FrameResume<T extends SequencedFrame & { type: string }> {
  readonly gate = new SessionFrameGate<T>();
  private timer: unknown = null;
  /** Tabs the armed timer is waiting on (an earlier request's still count: its timer was replaced). */
  private requested: readonly string[] = [];

  constructor(
    private readonly apply: (frames: T[]) => void,
    private readonly timeoutMs = FRAME_RESUME_TIMEOUT_MS,
  ) {}

  /**
   * Cursors for a reconnect's `session.subscribe`. The tabs they name hold
   * their frames until `session.frames_resumed` (or the timeout).
   */
  request(sessionIds: readonly string[]): ReturnType<SessionFrameGate<T>['cursors']> {
    const request = this.gate.cursors(sessionIds);
    if (!request) return null;
    const ids = Object.keys(request.cursors);
    this.requested = [...new Set([...this.requested, ...ids])];
    this.gate.beginResume(ids);
    if (this.timer) timers.clearTimeout(this.timer);
    this.timer = timers.setTimeout(() => {
      this.timer = null;
      this.requested = [];
      this.apply(this.gate.releaseAll());
    }, this.timeoutMs);
    return request;
  }

  /**
   * A `session.start`: adopt a connection's epoch, and drop the transcript
   * replay of a tab that is being caught up. Its pane is kept; the frames it
   * missed are on their way, and a replay rebuilt from the journal would
   * throw away the answer still streaming.
   */
  onSessionStart(msg: T): T {
    if (msg.payload === null || typeof msg.payload !== 'object' || Array.isArray(msg.payload)) {
      return msg;
    }
    const payload = msg.payload as Record<string, unknown>;
    if (typeof payload.eventEpoch === 'string') {
      this.apply(this.gate.adoptEpoch(payload.eventEpoch));
      if (this.timer && !this.requested.some((id) => this.gate.isResuming(id))) {
        timers.clearTimeout(this.timer);
        this.timer = null;
        this.requested = [];
      }
    }
    const sessionId = payload.sessionId;
    if (typeof sessionId !== 'string') return msg;
    if (payload.reset === true) {
      this.gate.resetSession(sessionId);
      if (this.timer && !this.requested.some((id) => this.gate.isResuming(id))) {
        timers.clearTimeout(this.timer);
        this.timer = null;
        this.requested = [];
      }
      return msg;
    }
    if (!this.gate.isResuming(sessionId)) return msg;
    const kept = { ...payload };
    for (const field of REPLAY_FIELDS) delete kept[field];
    return { ...msg, payload: kept };
  }

  /** `session.frames_resumed`: one tab's catch-up is over. */
  onFramesResumed(msg: T): void {
    if (msg.payload === null || typeof msg.payload !== 'object' || Array.isArray(msg.payload)) {
      return;
    }
    const sessionId = (msg.payload as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string') this.apply(this.gate.finishResume(sessionId));
    // Every tab caught up: nothing left to give up on. A live timer would also
    // keep a Node process up for the rest of its 5 s.
    if (this.timer && !this.requested.some((id) => this.gate.isResuming(id))) {
      timers.clearTimeout(this.timer);
      this.timer = null;
      this.requested = [];
    }
  }
}
