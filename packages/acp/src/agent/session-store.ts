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
import { isSafePathSegment, resolveContainedPath, withFileLock } from '@wrongstack/core/utils';
import type { McpServer, SessionConfigOption } from './protocol-contract.js';
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

/**
 * Session ids whose `<id>.json` would collide with a store sidecar file.
 * The sidecar index is `index.json` (see `ACPSessionStore.indexPath()`), so
 * "index" is reserved — matched case-insensitively in `sessionFile()`, because
 * Windows and default macOS resolve `INDEX.json` to the same file. Extend this
 * set if more sidecars are added.
 */
const RESERVED_SESSION_IDS: ReadonlySet<string> = new Set(['index']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `history` is iterated and replayed verbatim by `session/load`
 * (`for (const update of persisted.history)` and `seedFor(…, history)`), so its
 * array shape and `sessionUpdate` discriminator are load-bearing.
 */
function isPersistedHistory(value: unknown): value is PersistedHistoryUpdate[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => isRecord(entry) && typeof entry['sessionUpdate'] === 'string')
  );
}

function isNamedValueList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) && typeof entry['name'] === 'string' && typeof entry['value'] === 'string',
    )
  );
}

/** `SessionConfigOption` as the client advertises it back on `session/load`. */
function isConfigOption(value: unknown): value is SessionConfigOption {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string' || typeof value['name'] !== 'string') return false;
  if (typeof value['type'] !== 'string' || typeof value['currentValue'] !== 'string') return false;
  const options = value['options'];
  return (
    Array.isArray(options) &&
    options.every(
      (option) =>
        isRecord(option) &&
        typeof option['value'] === 'string' &&
        typeof option['name'] === 'string' &&
        (option['description'] === undefined || typeof option['description'] === 'string'),
    )
  );
}

function isConfigOptionList(value: unknown): value is SessionConfigOption[] {
  return Array.isArray(value) && value.every(isConfigOption);
}

/**
 * `McpServer` is a stdio/http/sse union. The stdio variant carries no `type`
 * in the published type, but a normalising producer may write `type: "stdio"`,
 * so both spellings are accepted.
 */
function isMcpServer(value: unknown): value is McpServer {
  if (!isRecord(value)) return false;
  if (typeof value['name'] !== 'string') return false;
  const type = value['type'];
  if (type === 'http' || type === 'sse') {
    return (
      typeof value['url'] === 'string' &&
      (value['headers'] === undefined || isNamedValueList(value['headers']))
    );
  }
  if (type !== undefined && type !== 'stdio') return false;
  if (typeof value['command'] !== 'string') return false;
  if (
    value['args'] !== undefined &&
    (!Array.isArray(value['args']) || !value['args'].every((arg) => typeof arg === 'string'))
  ) {
    return false;
  }
  return value['env'] === undefined || isNamedValueList(value['env']);
}

function isMcpServerList(value: unknown): value is McpServer[] {
  return Array.isArray(value) && value.every(isMcpServer);
}

/**
 * Parse a persisted session file into the record the handler consumes.
 *
 * The file is external input — hand-edited, restored from a backup, or written
 * by another server version — so the previous `JSON.parse(data) as
 * PersistedSession` cast let a parseable-but-wrong payload through:
 * `history: {}` reached `session/load`'s `for (const update of history)` and
 * threw `TypeError: {} is not iterable`, and a numeric `modeId` would have been
 * stored in a string-typed field and advertised to the client. A file that does
 * not match the persisted shape is now treated exactly like unreadable JSON:
 * `load()` returns null and the caller answers its normal "session not found".
 */
function parsePersistedSession(raw: string): PersistedSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const session: PersistedSession = {};
  const id = parsed['id'];
  if (id !== undefined) {
    if (typeof id !== 'string') return null;
    session.id = id;
  }
  const cwd = parsed['cwd'];
  if (cwd !== undefined) {
    if (typeof cwd !== 'string') return null;
    session.cwd = cwd;
  }
  const modeId = parsed['modeId'];
  if (modeId !== undefined) {
    if (typeof modeId !== 'string') return null;
    session.modeId = modeId;
  }
  const createdAt = parsed['createdAt'];
  if (createdAt !== undefined) {
    if (typeof createdAt !== 'string') return null;
    session.createdAt = createdAt;
  }
  const updatedAt = parsed['updatedAt'];
  if (updatedAt !== undefined) {
    if (typeof updatedAt !== 'string') return null;
    session.updatedAt = updatedAt;
  }
  const title = parsed['title'];
  if (title !== undefined) {
    if (typeof title !== 'string') return null;
    session.title = title;
  }

  const configOptions = parsed['configOptions'];
  if (configOptions !== undefined) {
    if (!isConfigOptionList(configOptions)) return null;
    session.configOptions = configOptions;
  }
  const mcpServers = parsed['mcpServers'];
  if (mcpServers !== undefined) {
    if (!isMcpServerList(mcpServers)) return null;
    session.mcpServers = mcpServers;
  }
  const history = parsed['history'];
  if (history !== undefined) {
    if (!isPersistedHistory(history)) return null;
    session.history = history;
  }
  return session;
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
  private readonly sessionChains = new Map<string, Promise<void>>();
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

  private withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.sessionChains.set(sessionId, settled);
    void settled.finally(() => {
      if (this.sessionChains.get(sessionId) === settled) {
        this.sessionChains.delete(sessionId);
      }
    });
    return next;
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
    // Reject ids whose `<id>.json` collides with a store sidecar file (e.g.
    // "index" → index.json). A client-supplied reserved id would otherwise let
    // session/load read, session/delete unlink, and save clobber the sidecar
    // (Chimera MEDIUM — reserved-name collision). Compared case-insensitively:
    // Windows and default macOS resolve `INDEX.json` and `index.json` to the
    // SAME file, so a case variant of the sidecar name is the same collision.
    if (RESERVED_SESSION_IDS.has(sessionId.toLowerCase())) return null;
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
    return this.withSessionLock(state.id, async () => {
      await this.init();
      // Atomic tmp+rename (same pattern as writeIndex): a crash mid-save must
      // not tear the session file — it carries replayable history. The
      // per-call sequence counter keeps the tmp unique even when two
      // concurrent saves fire inside the same millisecond.
      const tmp = `${target}.${process.pid}.${Date.now()}.${++this.writeSeq}.tmp`;
      let renamed = false;
      try {
        const data = JSON.stringify({
          id: state.id,
          cwd: state.cwd,
          modeId: state.modeId,
          configOptions: state.configOptions,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          title: state.title,
          ...(state.mcpServers && state.mcpServers.length > 0
            ? { mcpServers: state.mcpServers }
            : {}),
          ...(history && history.length > 0 ? { history } : {}),
        });
        try {
          await fsp.writeFile(tmp, data, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          // Recover once when the memoized directory disappeared between saves.
          this.initialized = false;
          await this.init();
          await fsp.writeFile(tmp, data, 'utf8');
        }
        await fsp.rename(tmp, target);
        renamed = true;
      } finally {
        // Best-effort: drop the tmp unless rename already moved it into place.
        // Without this, a failing write/rename leaks an orphan on every retry
        // (Chimera MEDIUM — repeated persistence failures accumulate).
        if (!renamed) {
          /* v8 ignore next */
          await fsp.unlink(tmp).catch(() => undefined);
        }
      }
      await this.updateIndex(state.id, state.updatedAt);
      return state.id;
    });
  }

  /** Load a persisted session (metadata + history) from disk, or null. */
  async load(sessionId: string): Promise<PersistedSession | null> {
    const target = this.sessionFile(sessionId);
    if (target === null) return null;
    await this.sessionChains.get(sessionId);
    try {
      const data = await fsp.readFile(target, 'utf8');
      return parsePersistedSession(data);
    } catch {
      return null;
    }
  }

  /** List all persisted sessions. */
  async list(): Promise<Array<{ id: string; updatedAt: string }>> {
    // Fast path: read the small sidecar index instead of every session
    // file. Serialize fallback rebuilds with save/delete index mutations
    // so an older directory snapshot cannot overwrite their updates.
    return this.withIndexLock(async () => {
      const indexEntries = await this.readIndex();
      if (indexEntries !== null) {
        return indexEntries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
      const sessions = await this.scanForSessions();
      await this.writeIndex(sessions).catch(() => undefined);
      return sessions;
    });
  }

  /**
   * Walk `<dir>` and parse every session file into `{id, updatedAt}`
   * metadata. Used as the slow-path fallback by `list()` and by
   * `updateIndex()` when the sidecar index is missing. Pure read —
   * does NOT touch `index.json`.
   */
  private async scanForSessions(): Promise<Array<{ id: string; updatedAt: string }>> {
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
      const stem = file.slice(0, -5);
      if (this.sessionFile(stem) === null) continue;
      try {
        const data = await fsp.readFile(path.join(this.dir, file), 'utf8');
        const parsed = parsePersistedSession(data);
        if (parsed && parsed.id === stem) {
          sessions.push({ id: parsed.id, updatedAt: parsed.updatedAt ?? '' });
        }
      } catch {
        // Corrupted file — skip
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    // The chain only orders THIS instance. Two agent processes for the same
    // project (two editor windows) share the directory, so the index
    // read-modify-write also holds a cross-process file lock — otherwise the
    // last writer drops the other's entry and list() never shows it again.
    const locked = () => withFileLock(this.indexPath(), fn);
    const next = prev.then(locked, locked);
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
          this.sessionFile((e as { id: string }).id) !== null &&
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
        /* v8 ignore next */
        await fsp.unlink(tmp).catch(() => undefined);
      }
    }
  }

  /** Update one entry in the index, adding it if missing. Best-effort. */
  private async updateIndex(id: string, updatedAt: string): Promise<void> {
    await this.withIndexLock(async () => {
      const entries = await this.readIndex();
      if (entries === null) {
        // Scan directly: calling list() while already holding the index
        // lock would wait on our own operation and deadlock.
        const sessions = await this.scanForSessions();
        try {
          await this.writeIndex(sessions);
        } catch {
          // Index is best-effort; per-session file is the source of truth.
        }
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
    await this.withSessionLock(sessionId, async () => {
      try {
        await fsp.unlink(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
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
    });
  }

  /** Get the store directory path. */
  getDirectory(): string {
    return this.dir;
  }
}
