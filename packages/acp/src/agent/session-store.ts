/**
 * ACPSessionStore — persistent session storage for the ACP server.
 *
 * Sessions are saved as JSON files in a configurable directory.
 * This enables session/load to work across server restarts.
 *
 * Format: one JSON file per session, named `<sessionId>.json`.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { isSafePathSegment, resolveContainedPath } from '@wrongstack/core/utils';
import type { SessionState } from './protocol-handler.js';

/** A persisted conversation turn (user/agent message chunk) for replay. */
interface PersistedHistoryUpdate {
  sessionUpdate: string;
  content: unknown;
}

/** A persisted session: metadata + replayable conversation history. */
export interface PersistedSession extends Partial<SessionState> {
  history?: PersistedHistoryUpdate[] | undefined;
}

export interface SessionStoreOptions {
  /** Directory to store session files. Defaults to a temp dir. */
  dir?: string | undefined;
}

export class ACPSessionStore {
  private readonly dir: string;
  /**
   * Memoized result of the first successful `init()`. Saved sessions
   * are the hot path — calling `mkdir(..., {recursive:true})` on every
   * turn adds an avoidable syscall to the per-prompt persistence flow.
   * Cleared automatically if the directory disappears between calls.
   */
  private initialized = false;
  /**
   * Tail of in-flight sidecar-index mutations. `readIndex`/`writeIndex`/
   * `updateIndex`/delete's index-touching branch all run through the
   * `withIndexLock` gate so a concurrent save/delete/save cannot read the
   * same baseline twice and clobber the other writer's edit (Chimera
   * HIGH — race that could permanently omit or resurrect sessions in
   * `list()`). Mirrors the `writeChains` pattern in
   * `packages/core/src/storage/tool-audit-log.ts`.
   */
  private indexChain: Promise<void> = Promise.resolve();
  /**
   * Monotonic per-store counter. Used to make tmp filenames unique so two
   * concurrent saves started in the same millisecond cannot collide on
   * `<target>.<pid>.<ts>.tmp` and lose one's tmp mid-write (latent bug
   * discovered by the concurrent same-id save/delete stress test).
   */
  private writeSeq = 0;

  constructor(opts: SessionStoreOptions = {}) {
    this.dir = opts.dir ?? path.join(process.cwd(), '.acp-sessions');
  }

  /**
   * Path of `<sessionId>.json` inside the store, or `null` when `sessionId`
   * is not usable as a single path segment (WS-015).
   *
   * The session id arrives from the ACP client — `session/load`,
   * `session/close` and `session/delete` all take it verbatim from the wire.
   * It was joined straight onto the store directory, so `../../..` escaped it,
   * and the `.json` suffix was the only thing narrowing the blast radius:
   *
   *   - `load`   — read any `.json` on the machine, e.g. the provider config
   *                holding API keys
   *   - `delete` — unlink any `.json` on the machine
   *   - `save`   — the worst one: a loaded session keeps the traversing id as
   *                its `state.id`, so the next persist WRITES to that path
   *
   * All three now route through here, so the escape is closed once rather than
   * three times.
   */
  private sessionFile(sessionId: string): string | null {
    // Validate the RAW id, then build the filename. Checking only the joined
    // `<id>.json` would let `.` and `..` through — they suffix into the legal
    // filenames `..json` and `...json`, so they happen to stay inside the
    // directory. Contained by accident is not a rule; the client controls the
    // id, so the id is what must satisfy the segment contract.
    if (!isSafePathSegment(sessionId)) return null;
    return resolveContainedPath(this.dir, `${sessionId}.json`);
  }

  /** Ensure the store directory exists. Memoized — only mkdirs once. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await fsp.mkdir(this.dir, { recursive: true });
    this.initialized = true;
  }

  /**
   * Persist a session state (and optionally its conversation history) to
   * disk. Returns the session id. `history` enables cross-restart
   * `session/load` replay.
   */
  async save(state: SessionState, history?: PersistedHistoryUpdate[]): Promise<string> {
    // Throws rather than returning null: an unsafe id here means a caller
    // built a session with an attacker-supplied id, and silently skipping the
    // write would leave that session live but unpersisted.
    const target = this.sessionFile(state.id);
    if (target === null) {
      throw new Error(`ACPSessionStore: refusing to persist unsafe session id "${state.id}"`);
    }
    await this.init();
    // Atomic tmp+rename (same pattern as writeIndex): a crash mid-save must
    // not tear the session file — it carries replayable history. The
    // per-call sequence counter keeps the tmp unique even when two
    // concurrent saves fire inside the same millisecond.
    const tmp = `${target}.${process.pid}.${Date.now()}.${++this.writeSeq}.tmp`;
    let renamed = false;
    try {
      await fsp.writeFile(
        tmp,
        JSON.stringify({
          id: state.id,
          cwd: state.cwd,
          modeId: state.modeId,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          title: state.title,
          ...(history && history.length > 0 ? { history } : {}),
        }),
        'utf8',
      );
      await fsp.rename(tmp, target);
      renamed = true;
    } finally {
      // Best-effort: drop the tmp unless rename already moved it into place.
      // Without this, a failing write/rename leaks an orphan on every retry
      // (Chimera MEDIUM — repeated persistence failures accumulate).
      if (!renamed) {
        await fsp.unlink(tmp).catch(() => undefined);
      }
    }
    await this.updateIndex(state.id, state.updatedAt);
    return state.id;
  }

  /** Load a persisted session (metadata + history) from disk, or null. */
  async load(sessionId: string): Promise<PersistedSession | null> {
    const target = this.sessionFile(sessionId);
    if (target === null) return null;
    try {
      const data = await fsp.readFile(target, 'utf8');
      return JSON.parse(data) as PersistedSession;
    } catch {
      return null;
    }
  }

  /** List all persisted sessions. */
  async list(): Promise<Array<{ id: string; updatedAt: string }>> {
    // Fast path: read the small sidecar index instead of every session
    // file. Rebuilds on first call if the index is missing or stale.
    const indexEntries = await this.readIndex();
    if (indexEntries !== null) {
      return indexEntries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    // Slow path fallback: scan the directory, parse each file, then
    // rebuild the index for next time. Same external contract as before.
    const files: string[] = [];
    try {
      const entries = await fsp.readdir(this.dir);
      for (const entry of entries) {
        if (entry.endsWith('.json') && entry !== 'index.json') {
          files.push(entry);
        }
      }
    } catch {
      return [];
    }

    const sessions: Array<{ id: string; updatedAt: string }> = [];
    for (const file of files) {
      try {
        const data = await fsp.readFile(path.join(this.dir, file), 'utf8');
        const parsed = JSON.parse(data) as { id?: string; updatedAt?: string };
        if (parsed.id) {
          sessions.push({ id: parsed.id, updatedAt: parsed.updatedAt ?? '' });
        }
      } catch {
        // Corrupted file — skip
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // Best-effort rebuild; failure to write the index does not affect
    // the returned list.
    void this.writeIndex(sessions).catch(() => undefined);
    return sessions;
  }

  /** Sidecar path that stores `{id, updatedAt}` for every saved session. */
  private indexPath(): string {
    return path.join(this.dir, 'index.json');
  }

  /**
   * Serialize sidecar-index mutations. Each call appends `fn` to the tail
   * of `indexChain` so reads and writes see a linearized order — a second
   * caller cannot start until the first one's index update has finished.
   *
   * The chain swallows errors (`prev.then(fn, fn)`) so one failing writer
   * does not poison every subsequent caller, and the catch keeps an
   * unhandled rejection from leaking out of the stored tail. The cleanup
   * removes the tail entry once settled, so a quiet store does not retain
   * stale promises forever.
   */
  private withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.indexChain;
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.indexChain = settled;
    void settled.finally(() => {
      if (this.indexChain === settled) this.indexChain = Promise.resolve();
    });
    return next;
  }

  /** Read the sidecar index. Returns `null` when missing or unreadable. */
  private async readIndex(): Promise<Array<{ id: string; updatedAt: string }> | null> {
    try {
      const data = await fsp.readFile(this.indexPath(), 'utf8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return null;
      const out: Array<{ id: string; updatedAt: string }> = [];
      for (const e of parsed) {
        if (
          e &&
          typeof (e as { id?: unknown }).id === 'string' &&
          typeof (e as { updatedAt?: unknown }).updatedAt === 'string'
        ) {
          out.push({
            id: (e as { id: string }).id,
            updatedAt: (e as { updatedAt: string }).updatedAt,
          });
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Atomically replace the sidecar index with the supplied entries. */
  private async writeIndex(entries: Array<{ id: string; updatedAt: string }>): Promise<void> {
    const target = this.indexPath();
    // Sequence suffix avoids same-millisecond tmp collisions between the
    // background rebuild scheduled by `list()` and a concurrent
    // `updateIndex()` write.
    const tmp = `${target}.${process.pid}.${Date.now()}.${++this.writeSeq}.tmp`;
    let renamed = false;
    try {
      await fsp.writeFile(tmp, JSON.stringify(entries), 'utf8');
      await fsp.rename(tmp, target);
      renamed = true;
    } finally {
      // Best-effort orphan cleanup — mirror of the save() tmp+rename guard.
      if (!renamed) {
        await fsp.unlink(tmp).catch(() => undefined);
      }
    }
  }

  /** Update one entry in the index, adding it if missing. Best-effort. */
  private async updateIndex(id: string, updatedAt: string): Promise<void> {
    await this.withIndexLock(async () => {
      const entries = await this.readIndex();
      if (entries === null) {
        // No index yet — fall back to a full scan to populate it.
        // `list()` itself schedules its own writeIndex on the same chain,
        // so a concurrent updater cannot clobber the rebuild.
        await this.list();
        return;
      }
      const i = entries.findIndex((e) => e.id === id);
      if (i >= 0) entries[i] = { id, updatedAt };
      else entries.push({ id, updatedAt });
      try {
        await this.writeIndex(entries);
      } catch {
        // Index is best-effort; per-session file is the source of truth.
      }
    });
  }

  /** Delete a session file. */
  async delete(sessionId: string): Promise<void> {
    const target = this.sessionFile(sessionId);
    if (target === null) return;
    try {
      await fsp.unlink(target);
    } catch {
      // File may not exist — ignore
    }
    // Best-effort: drop the entry from the sidecar index so future
    // `list()` calls don't return a stale row. Routed through the
    // index lock so concurrent save/delete cannot race on the index.
    await this.withIndexLock(async () => {
      const entries = await this.readIndex();
      if (entries === null) return;
      const next = entries.filter((e) => e.id !== sessionId);
      if (next.length !== entries.length) {
        try {
          await this.writeIndex(next);
        } catch {
          // Index is best-effort; next list() rebuild will fix it.
        }
      }
    });
  }

  /** Get the store directory path. */
  getDirectory(): string {
    return this.dir;
  }
}
