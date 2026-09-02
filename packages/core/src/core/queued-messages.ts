/**
 * Queue awareness — let the running agent *see* messages the user typed
 * while it was busy, without delivering them early.
 *
 * The TUI queues plain messages typed mid-run and replays them as real user
 * turns after the run finishes (the queue drainer in app.tsx). That keeps
 * turn-taking clean, but the model is blind to the backlog: a queued message
 * may invalidate the current approach, add a constraint, or just be a
 * "by the way" note the user expected the agent to notice.
 *
 * Unlike `/btw` (a consume-once note channel, {@link ./btw.ts}), this is a
 * SNAPSHOT channel: the host mirrors the queue's current contents onto the
 * live `Context` on every queue mutation (enqueue, /queue delete, /queue
 * clear, dequeue-for-delivery). At each iteration boundary the agent loop
 * asks "did the snapshot change since the model last saw it?" and, if so,
 * injects an informational block listing the pending messages. The queue
 * itself is untouched — every queued message still arrives later as its own
 * user turn.
 *
 * Deliberate quietness: when the queue transitions to empty (cleared by the
 * user, drained between runs, or dropped by steering/abort) the snapshot is
 * marked seen WITHOUT injecting a "queue is now empty" block. The empty
 * transition usually happens at run boundaries where such a notice is stale
 * noise; the cost is that a mid-run `/queue clear` isn't announced, which is
 * safe because the block's framing already tells the model the queue may
 * change and the authoritative messages arrive as future turns.
 */
import type { Context } from './context.js';

/** Meta key holding the queue-awareness snapshot. */
const META_KEY = '_queuedMessagesAwareness';

/** Cap on listed messages so a paste-storm can't bloat the injected block. */
const MAX_ITEMS = 20;

/** Per-message preview cap — the full text arrives later as a real turn. */
const MAX_PREVIEW_CHARS = 500;

interface AwarenessState {
  /** Current queue contents (truncated previews, head first). */
  items: string[];
  /** What the model was last shown. Injection fires only on a diff. */
  seen: string[];
}

function read(ctx: Context): AwarenessState | undefined {
  const raw = ctx.meta[META_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as AwarenessState;
  return Array.isArray(s.items) && Array.isArray(s.seen) ? s : undefined;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function toPreview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_PREVIEW_CHARS - 1)}…`;
}

/**
 * Mirror the host's pending-message queue onto the context. Call on every
 * queue mutation with the FULL current queue (head first) — not a delta.
 * Blank entries are dropped; the head-most {@link MAX_ITEMS} are kept since
 * the head is what arrives first.
 */
export function setQueuedMessagesSnapshot(ctx: Context, texts: string[]): void {
  const items = texts
    .map(toPreview)
    .filter((t) => t.length > 0)
    .slice(0, MAX_ITEMS);
  const prev = read(ctx);
  if (items.length === 0 && (!prev || prev.seen.length === 0)) {
    // Nothing pending and the model never saw anything — keep meta clean.
    if (prev) delete ctx.meta[META_KEY];
    return;
  }
  ctx.meta[META_KEY] = { items, seen: prev?.seen ?? [] } satisfies AwarenessState;
}

/** Current snapshot (previews), without affecting seen-state. */
export function peekQueuedMessages(ctx: Context): string[] {
  return read(ctx)?.items ?? [];
}

/**
 * Called by the agent loop at each iteration boundary. Returns the queued
 * messages to surface when the snapshot changed since the model last saw it,
 * or `null` when there is nothing new to say. Marks the snapshot seen either
 * way, so the same state is never injected twice. An empty snapshot is
 * acknowledged silently (see module comment).
 */
export function consumeQueuedMessagesUpdate(ctx: Context): string[] | null {
  const s = read(ctx);
  if (!s) return null;
  if (sameList(s.items, s.seen)) return null;
  if (s.items.length === 0) {
    delete ctx.meta[META_KEY];
    return null;
  }
  ctx.meta[META_KEY] = { items: s.items, seen: s.items } satisfies AwarenessState;
  return s.items;
}

/**
 * Format the awareness block. Framing goals: (1) the model must NOT treat
 * the listed messages as instructions to execute now — they each arrive as
 * their own turn later; (2) it SHOULD let them influence in-flight decisions
 * (a queued message may invalidate the current approach or be a /btw-style
 * note); (3) the list is a full replacement of any earlier notice, so a
 * shrunken list implicitly communicates deletions.
 */
export function buildQueuedMessagesBlock(items: string[]): string {
  const body = items.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return [
    '[QUEUED MESSAGES — the user typed these while you were working. They are',
    'waiting in the input queue and each will be delivered as its own turn',
    'after you finish, so do NOT answer or act on them as new tasks now. Read',
    'them as a heads-up: if one changes what you should be doing right now',
    '(new constraint, invalidated approach), adapt your current work; if one',
    'is just an FYI, fold it in. The queue may still change before delivery.',
    'This notice replaces any earlier one — the queue now holds exactly:',
    '',
    body,
    ']',
  ].join('\n');
}
