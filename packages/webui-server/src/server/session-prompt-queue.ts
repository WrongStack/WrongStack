/**
 * Server-owned prompt queue: prompts a user queued for a session to run after
 * the current turn.
 *
 * The queue used to live in the browser tab (localStorage) and drained on the
 * `run.result` that tab received, so it only advanced while that one tab was
 * open and connected, and no other tab or device could see it. Here the host
 * that owns the run owns the queue: it drains when the session's run ends
 * whether or not any page is watching, every page showing the session sees the
 * same list (`queue.state`), and it is persisted per session so a host restart
 * resumes it the next time the session is opened.
 *
 * It is the same file the TUI keeps its queue in (`<session dir>/queue.json`,
 * core `QueueStore`), in the same shape: a prompt left queued in the terminal
 * is here when the session is opened in the browser, and the other way round.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import {
  type PersistedQueueItem,
  QUEUE_MAX_BYTES,
  QUEUE_MAX_ITEM_BYTES,
  QUEUE_MAX_ITEMS,
  QueueStore,
} from '@wrongstack/core/storage';
import type { ContentBlock } from '@wrongstack/core/types';
import {
  buildUserContentBlocks,
  type IncomingImagePayload,
  parseIncomingAttachments,
  sessionScopedPath,
  toErrorMessage,
} from '@wrongstack/core/utils';
import { pdfPromptBlocks } from './incoming-documents.js';

/** A queued prompt: what the user sees (`text`) and what the model gets (`blocks`). */
export interface QueuedPrompt {
  id: string;
  text: string;
  addedAt: number;
  blocks: ContentBlock[];
  /** Set by the TUI: refine the prompt before it runs. Kept for the TUI. */
  shouldRefine?: boolean | undefined;
  /** Set by the TUI: the text before refinement, for the prompt journal. */
  journalRaw?: string | undefined;
}

/** What a page renders: the prompt without its image bytes. */
export interface QueuedPromptView {
  id: string;
  text: string;
  addedAt: number;
  imageCount: number;
}

type OutboundMessage = { type: string; payload: unknown };

export interface SessionPromptQueueDeps {
  /** The project's sessions directory; each queue is its session's `queue.json`. Undefined keeps queues in memory. */
  sessionsDir?: string | undefined;
  /** Where queues were kept before they moved next to the TUI's; read once and removed. */
  legacyDir?: string | undefined;
  /** True while the session holds its run lock. */
  isBusy: (sessionId: string) => boolean;
  /**
   * Start a turn for a drained prompt through the host's one turn path.
   * `onStart` runs synchronously once the turn holds the run lock and before
   * the run emits anything. Resolves `true` once the run started, `false` when
   * the session was busy or not ready — the prompt then keeps its place.
   */
  startTurn: (sessionId: string, prompt: QueuedPrompt, onStart: () => void) => Promise<boolean>;
  /** Session-scoped broadcast to every page showing the session. */
  broadcast: (message: OutboundMessage) => void;
  warn?: ((message: string) => void) | undefined;
}

export type AddPromptResult = { ok: true; item: QueuedPrompt } | { ok: false; reason: string };

export interface SessionPromptQueue {
  add(
    sessionId: string,
    prompt: { text: string; images?: IncomingImagePayload[] },
  ): Promise<AddPromptResult>;
  remove(sessionId: string, id: string): Promise<boolean>;
  clear(sessionId: string): Promise<number>;
  /** Current items; the first read of a session loads what a previous host persisted. */
  list(sessionId: string): Promise<QueuedPrompt[]>;
  /** Start the front prompt if the session is idle. Safe to call at any time. */
  drain(sessionId: string): Promise<void>;
}

/**
 * Where queues were kept before they moved into the session directory: a
 * sibling of the sessions directory.
 */
export function promptQueueDirFor(sessionsDir: string | undefined): string | undefined {
  return sessionsDir ? path.join(path.dirname(sessionsDir), 'prompt-queue') : undefined;
}

/** Longest session id persisted; a longer one stays in memory only. */
const MAX_SESSION_ID_CHARS = 200;

/** The legacy file name: every character outside a plain file-name set escaped. */
function legacyFileName(sessionId: string): string | undefined {
  if (!sessionId || sessionId.length > MAX_SESSION_ID_CHARS) return undefined;
  const escaped = sessionId.replace(
    /[^A-Za-z0-9_-]/g,
    (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
  return `${escaped}.json`;
}

let idCounter = 0;
function nextId(): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `q-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function attachmentCount(blocks: readonly ContentBlock[]): number {
  return blocks.filter((block) => block.type === 'image').length;
}

function promptView(item: QueuedPrompt): QueuedPromptView {
  return {
    id: item.id,
    text: item.text,
    addedAt: item.addedAt,
    imageCount: attachmentCount(item.blocks),
  };
}

function clonePrompt(item: QueuedPrompt): QueuedPrompt {
  return { ...item, blocks: structuredClone(item.blocks) };
}

/** The drained prompt as pages show it: its text and its images. */
function drainedView(item: QueuedPrompt) {
  const images = item.blocks.flatMap((block) =>
    block.type === 'image' && block.source.type === 'base64' && block.source.data
      ? [{ data: block.source.data, mediaType: block.source.media_type }]
      : [],
  );
  return {
    id: item.id,
    text: item.text,
    addedAt: item.addedAt,
    ...(images.length > 0 ? { images } : {}),
  };
}

/** The prompt as a model turn: PDFs first, then images, then the text. */
export async function queuedPromptBlocks(
  text: string,
  images: IncomingImagePayload[] | undefined,
): Promise<ContentBlock[]> {
  const attached = parseIncomingAttachments(images);
  return [
    ...(await pdfPromptBlocks(attached.pdfs)),
    ...buildUserContentBlocks(text, attached.images),
  ];
}

function fromPersisted(item: PersistedQueueItem & { id?: unknown; addedAt?: unknown }) {
  return {
    id: typeof item.id === 'string' && item.id.trim().length > 0 ? item.id : nextId(),
    text: item.displayText,
    addedAt:
      typeof item.addedAt === 'number' && Number.isFinite(item.addedAt) && item.addedAt >= 0
        ? item.addedAt
        : Date.now(),
    blocks: item.blocks,
    ...(item.shouldRefine !== undefined ? { shouldRefine: item.shouldRefine } : {}),
    ...(item.journalRaw !== undefined ? { journalRaw: item.journalRaw } : {}),
  } satisfies QueuedPrompt;
}

function toPersisted(item: QueuedPrompt): PersistedQueueItem & { id: string; addedAt: number } {
  return {
    id: item.id,
    addedAt: item.addedAt,
    displayText: item.text,
    blocks: item.blocks,
    ...(item.shouldRefine !== undefined ? { shouldRefine: item.shouldRefine } : {}),
    ...(item.journalRaw !== undefined ? { journalRaw: item.journalRaw } : {}),
  };
}

interface LegacyQueuedPrompt {
  text: string;
  images?: IncomingImagePayload[] | undefined;
}

function isLegacyPrompt(value: unknown): value is LegacyQueuedPrompt {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['text'] === 'string' && (v['images'] === undefined || Array.isArray(v['images']));
}

export function createSessionPromptQueue(deps: SessionPromptQueueDeps): SessionPromptQueue {
  const queues = new Map<string, QueuedPrompt[]>();
  const loading = new Map<string, Promise<QueuedPrompt[]>>();
  /** Sessions with a drain in progress — one turn start at a time per session. */
  const draining = new Set<string>();
  /** Serialises file writes per session so an older snapshot never lands last. */
  const writes = new Map<string, Promise<boolean>>();
  const legacyUpdates = new Map<string, () => Promise<boolean>>();

  const sessionDirFor = (sessionId: string): string | undefined => {
    if (!deps.sessionsDir || !sessionId || sessionId.length > MAX_SESSION_ID_CHARS) {
      return undefined;
    }
    try {
      return sessionScopedPath(deps.sessionsDir, sessionId, '');
    } catch {
      // An id that would leave the sessions directory stays in memory.
      return undefined;
    }
  };

  const storeFor = (sessionId: string): QueueStore | undefined => {
    const dir = sessionDirFor(sessionId);
    return dir ? new QueueStore({ dir }) : undefined;
  };

  /** Prompts a previous host kept in the old per-project directory. */
  const readLegacy = async (
    sessionId: string,
    capacity: number,
  ): Promise<{
    items: QueuedPrompt[];
    commit?: () => Promise<boolean>;
  }> => {
    const name = legacyFileName(sessionId);
    if (!deps.legacyDir || !name) return { items: [] };
    const file = path.join(deps.legacyDir, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.size > QUEUE_MAX_BYTES) return { items: [] };
      const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
      const legacy = Array.isArray(parsed) ? parsed.filter(isLegacyPrompt) : [];
      const items: QueuedPrompt[] = [];
      const selected = legacy.slice(0, Math.max(0, capacity));
      for (const prompt of selected) {
        try {
          items.push({
            id: nextId(),
            text: prompt.text,
            addedAt: Date.now(),
            blocks: await queuedPromptBlocks(prompt.text, prompt.images),
          });
        } catch (err) {
          deps.warn?.(`queued prompt for ${sessionId} dropped: ${toErrorMessage(err)}`);
        }
      }
      const remaining = legacy.slice(selected.length);
      const commit = async (): Promise<boolean> => {
        try {
          if (remaining.length > 0) {
            await fsp.writeFile(file, JSON.stringify(remaining), 'utf8');
          } else {
            await fsp.rm(file, { force: true });
          }
          return true;
        } catch (err) {
          deps.warn?.(`old prompt queue for ${sessionId} not updated: ${toErrorMessage(err)}`);
          return false;
        }
      };
      return { items, commit };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        deps.warn?.(`old prompt queue for ${sessionId} unreadable: ${toErrorMessage(err)}`);
      }
      return { items: [] };
    }
  };

  const load = (sessionId: string): Promise<QueuedPrompt[]> => {
    const pending = loading.get(sessionId);
    if (pending) return pending;
    const known = queues.get(sessionId);
    if (known) return Promise.resolve(known);
    const read = (async (): Promise<QueuedPrompt[]> => {
      const stored = (await storeFor(sessionId)?.read()) ?? [];
      const legacy = await readLegacy(sessionId, QUEUE_MAX_ITEMS - stored.length);
      const persisted = stored as Array<PersistedQueueItem & { id?: unknown; addedAt?: unknown }>;
      const hydrated = persisted.map(fromPersisted);
      let repaired = hydrated.some(
        (item, index) =>
          item.id !== persisted[index]?.id || item.addedAt !== persisted[index]?.addedAt,
      );
      const items: QueuedPrompt[] = [];
      const seenIds = new Set<string>();
      for (const item of [...hydrated, ...legacy.items].slice(0, QUEUE_MAX_ITEMS)) {
        let unique = item;
        if (seenIds.has(unique.id)) {
          let id = nextId();
          while (seenIds.has(id)) id = nextId();
          unique = { ...unique, id };
          repaired = true;
        }
        seenIds.add(unique.id);
        items.push(unique);
      }
      // A mutation that raced the read already created the live list.
      const live = queues.get(sessionId);
      if (live) return live;
      queues.set(sessionId, items);
      if (legacy.commit) legacyUpdates.set(sessionId, legacy.commit);
      if (legacy.commit || repaired) await persist(sessionId);
      return items;
    })().finally(() => loading.delete(sessionId));
    loading.set(sessionId, read);
    return read;
  };

  const persist = (sessionId: string): Promise<boolean> => {
    const dir = sessionDirFor(sessionId);
    const store = storeFor(sessionId);
    if (!dir || !store) return Promise.resolve(false);
    const previous = writes.get(sessionId) ?? Promise.resolve(true);
    const next = previous
      .then(async () => {
        const items = queues.get(sessionId) ?? [];
        if (items.length > 0) await fsp.mkdir(dir, { recursive: true });
        await store.write(items.map(toPersisted), { throwOnError: true });
        const commit = legacyUpdates.get(sessionId);
        if (commit && (await commit()) && legacyUpdates.get(sessionId) === commit) {
          legacyUpdates.delete(sessionId);
        }
        return true;
      })
      .catch((err) => {
        deps.warn?.(`prompt queue for ${sessionId} not saved: ${toErrorMessage(err)}`);
        return false;
      });
    writes.set(sessionId, next);
    void next.finally(() => {
      if (writes.get(sessionId) === next) writes.delete(sessionId);
    });
    return next;
  };

  const publish = (sessionId: string): void => {
    deps.broadcast({
      type: 'queue.state',
      payload: { sessionId, items: (queues.get(sessionId) ?? []).map(promptView) },
    });
  };

  const changed = async (sessionId: string): Promise<void> => {
    publish(sessionId);
    await persist(sessionId);
  };

  const drain = async (sessionId: string): Promise<void> => {
    if (draining.has(sessionId)) return;
    draining.add(sessionId);
    try {
      const items = await load(sessionId);
      const front = items[0];
      if (!front || deps.isBusy(sessionId)) return;
      items.shift();
      let started = false;
      try {
        started = await deps.startTurn(sessionId, front, () => {
          // Pages add the user bubble from this, ahead of the run's own events.
          deps.broadcast({
            type: 'queue.drained',
            payload: { sessionId, item: drainedView(front) },
          });
          publish(sessionId);
        });
      } catch (err) {
        deps.warn?.(`queued prompt for ${sessionId} failed to start: ${toErrorMessage(err)}`);
      }
      if (!started) {
        // Lost the lock (another turn got there first) or the session is not
        // open yet: the prompt keeps its place and runs after that turn.
        // The shift above was already visible to a concurrent add's publish
        // and persist, so republish and rewrite the file with the prompt back
        // in place — pages stay truthful and a restart still finds it.
        items.unshift(front);
        await changed(sessionId);
        return;
      }
      await persist(sessionId);
    } finally {
      draining.delete(sessionId);
    }
  };

  return {
    async add(sessionId, prompt) {
      const text = prompt.text.trim();
      const images = prompt.images?.length ? prompt.images : undefined;
      if (!text && !images) return { ok: false, reason: 'A queued prompt needs text or an image.' };
      const items = await load(sessionId);
      if (items.length >= QUEUE_MAX_ITEMS) {
        return { ok: false, reason: `The queue is full (${QUEUE_MAX_ITEMS} prompts).` };
      }
      const item: QueuedPrompt = {
        id: nextId(),
        text,
        addedAt: Date.now(),
        blocks: await queuedPromptBlocks(text, images),
      };
      const itemBytes = bytesOf(toPersisted(item));
      if (itemBytes > QUEUE_MAX_ITEM_BYTES) {
        return { ok: false, reason: 'This prompt is too large to queue.' };
      }
      if (bytesOf(items.map(toPersisted)) + itemBytes > QUEUE_MAX_BYTES) {
        return { ok: false, reason: 'The queue is full; remove a prompt first.' };
      }
      items.push(item);
      await changed(sessionId);
      // Queued while idle: nothing will end to drain it, so start it now.
      void drain(sessionId);
      return { ok: true, item: clonePrompt(item) };
    },

    async remove(sessionId, id) {
      const items = await load(sessionId);
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return false;
      items.splice(index, 1);
      await changed(sessionId);
      return true;
    },

    async clear(sessionId) {
      const items = await load(sessionId);
      const count = items.length;
      if (count === 0) {
        publish(sessionId);
        return 0;
      }
      items.length = 0;
      await changed(sessionId);
      return count;
    },

    list: async (sessionId) => (await load(sessionId)).map(clonePrompt),
    drain,
  };
}

type QueueReply = (message: OutboundMessage) => void;

/**
 * Serve one `queue.*` client message for `sessionId`. Changes reach every page
 * showing the session through the queue's own `queue.state` broadcast; the
 * asking page gets a direct answer only for `queue.get` and for a refusal.
 */
export async function handlePromptQueueMessage(
  queue: SessionPromptQueue,
  request: { sessionId: string; type: string; payload: unknown; reply: QueueReply },
): Promise<void> {
  const { sessionId, reply } = request;
  const payload = (
    request.payload && typeof request.payload === 'object' ? request.payload : {}
  ) as Record<string, unknown>;
  const refuse = (message: string): void =>
    reply({ type: 'error', payload: { sessionId, phase: request.type, message } });

  switch (request.type) {
    case 'queue.get': {
      const items = await queue.list(sessionId);
      reply({ type: 'queue.state', payload: { sessionId, items: items.map(promptView) } });
      // A page opening the session is the resume point: whatever a previous
      // host left queued runs now if nothing else is.
      void queue.drain(sessionId);
      return;
    }
    case 'queue.add': {
      const text = typeof payload['text'] === 'string' ? payload['text'] : '';
      const raw = Array.isArray(payload['images'])
        ? (payload['images'] as IncomingImagePayload[])
        : undefined;
      let images: IncomingImagePayload[] | undefined;
      try {
        // Validated now, so a bad image is refused while the user is here —
        // not when the prompt drains and nobody is watching.
        if (raw) {
          const attached = parseIncomingAttachments(raw);
          if (attached.images.length > 0 || attached.pdfs.length > 0) images = raw;
        }
      } catch (err) {
        refuse(toErrorMessage(err));
        return;
      }
      let result: AddPromptResult;
      try {
        result = await queue.add(sessionId, { text, ...(images ? { images } : {}) });
      } catch (err) {
        refuse(toErrorMessage(err));
        return;
      }
      if (!result.ok) refuse(result.reason);
      return;
    }
    case 'queue.remove': {
      if (typeof payload['id'] === 'string') await queue.remove(sessionId, payload['id']);
      return;
    }
    case 'queue.clear':
      await queue.clear(sessionId);
      return;
  }
}
