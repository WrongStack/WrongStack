/**
 * todo-tracker plugin — Persistent, project-scoped todo backlog that
 * survives across sessions.
 *
 * Why a separate plugin from the built-in `todo` tool?
 *   - The built-in `todo` tool mutates `ctx.todos`, which is
 *     session-scoped and auto-clears when all items complete.
 *   - todo-tracker writes to disk (`~/.wrongstack/projects/<slug>/todo-tracker.json`)
 *     and survives across sessions. Items are explicit add/complete;
 *     no auto-clear.
 *
 * Use cases:
 *   - Backlog of work the user wants to track over days/weeks
 *   - Items the LLM noticed but didn't finish — pull them into a fresh
 *     session via `todo_tracker_pull` (the LLM then registers them with
 *     the session's `ctx.todos` via the built-in `todo` tool)
 *   - Per-project scratchpad that survives `wstack resume <id>`
 *
 * Tools registered:
 *   - todo_tracker_list     : List items, filterable by status/tag/priority
 *   - todo_tracker_add      : Append a new item
 *   - todo_tracker_complete : Mark an item completed (idempotent)
 *   - todo_tracker_drop     : Mark an item dropped (idempotent)
 *   - todo_tracker_remove   : Permanently delete by id
 *   - todo_tracker_pull     : Return pending items for LLM to promote
 *                             into the session's ctx.todos via the
 *                             built-in `todo` tool
 *   - todo_tracker_status   : Counters + last update timestamp
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { atomicWrite, ensureDir } from '@wrongstack/core/utils';
import { nowIso } from '@wrongstack/primitives';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Status = 'pending' | 'in_progress' | 'completed' | 'dropped';
type Priority = 'low' | 'normal' | 'high';

interface TrackedItem {
  id: string;
  content: string;
  status: Status;
  priority: Priority;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Session that first created the item (if known). */
  sourceSessionId: string | null;
  /** Optional free-form note attached to the item. */
  notes: string | null;
}

interface TodoTrackerFile {
  version: 1;
  projectSlug: string;
  updatedAt: string;
  items: TrackedItem[];
}

// ---------------------------------------------------------------------------
// File location
// ---------------------------------------------------------------------------
//
// Per-project: `~/.wrongstack/projects/<slug>/todo-tracker.json`.
// The plugin receives the project path via `PluginAPI.config.extensions`
// (config field `filePath`) or falls back to `paths.projectDir` from
// the wiring layer. If neither is set, the plugin no-ops with a
// warning — there is no sensible default for a per-project file.

function deriveFilePath(api: { config: { extensions?: Record<string, unknown> } }): {
  filePath: string | null;
  projectSlug: string | null;
} {
  const raw = api.config.extensions?.['todo-tracker'] as Record<string, unknown> | undefined;
  const rawPath =
    raw?.['filePath'] ??
    raw?.['file_path'] ??
    raw?.['path'] ??
    raw?.['file'] ??
    raw?.['targetFile'];
  const explicit = typeof rawPath === 'string' && rawPath.trim().length > 0 ? rawPath.trim() : null;
  if (explicit) {
    // The projectSlug is the file's basename (without extension).
    const base =
      explicit
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() ?? 'tracker';
    return { filePath: explicit, projectSlug: base };
  }
  return { filePath: null, projectSlug: null };
}

// ---------------------------------------------------------------------------
// Persistence (file I/O)
// ---------------------------------------------------------------------------

const FILE_VERSION = 1 as const;

async function loadFile(filePath: string): Promise<TodoTrackerFile | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as TodoTrackerFile;
    if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.items)) {
      return null;
    }
    return parsed;
  } catch {
    // Corrupt file: treat as empty rather than crashing the agent.
    return null;
  }
}

async function saveFile(filePath: string, file: TodoTrackerFile): Promise<void> {
  // Atomic write: temp file + rename, so a partial write cannot corrupt the
  // backlog on crash or power loss.
  //
  // Uses the shared primitive rather than a local tmp+rename: on Windows the
  // rename fails EPERM/EBUSY while an antivirus scanner or a concurrent
  // reader holds the destination, and a bare `fs.rename` reports that as a
  // lost write. The shared helper retries across ~4s before giving up.
  await ensureDir(dirname(filePath));
  await atomicWrite(filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Module-scope state (H1 pattern: shared between setup, teardown, health)
// ---------------------------------------------------------------------------

const state = {
  filePath: null as string | null,
  projectSlug: null as string | null,
  file: null as TodoTrackerFile | null,
  addCount: 0,
  completeCount: 0,
  dropCount: 0,
  removeCount: 0,
  pullCount: 0,
  /** Most recent mutation for /diag plugins visibility. */
  lastMutation: null as null | {
    op: 'add' | 'complete' | 'drop' | 'remove' | 'pull';
    itemId: string;
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureFile(): TodoTrackerFile {
  if (!state.file) {
    // This branch should be unreachable for any tool that requires
    // `setup` to have run, but defensive: callers that hit it see an
    // empty store. The actual "file not configured" error is raised
    // by the tools themselves so the user gets a clear message.
    state.file = {
      version: FILE_VERSION,
      projectSlug: state.projectSlug ?? 'unconfigured',
      updatedAt: nowIso(),
      items: [],
    };
  }
  return state.file;
}

function recordMutation(op: 'add' | 'complete' | 'drop' | 'remove' | 'pull', itemId: string): void {
  state.lastMutation = { op, itemId, when: nowIso() };
  if (op === 'add') state.addCount += 1;
  else if (op === 'complete') state.completeCount += 1;
  else if (op === 'drop') state.dropCount += 1;
  else if (op === 'remove') state.removeCount += 1;
  else if (op === 'pull') state.pullCount += 1;
}

function findItemIndex(id: string): number {
  return ensureFile().items.findIndex((it) => it.id === id);
}

function notConfiguredError(): { ok: false; error: string } {
  return {
    ok: false,
    error:
      'todo-tracker: no file path configured. Set `filePath` under ' +
      '`config.extensions["todo-tracker"]` or run inside a session where ' +
      '`paths.projectDir` is provided by the host (e.g. `wstack` CLI).',
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'todo-tracker',
  version: '0.1.0',
  description: 'Persistent, project-scoped todo backlog that survives across sessions',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  defaultConfig: {
    filePath: '',
  },
  configSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description:
          'Override the auto-derived per-project path. Defaults to <projectDir>/todo-tracker.json when `paths.projectDir` is provided by the host.',
      },
    },
  },

  async setup(api) {
    // Idempotent re-init (H1 pattern): zero counters on reload.
    state.addCount = 0;
    state.completeCount = 0;
    state.dropCount = 0;
    state.removeCount = 0;
    state.pullCount = 0;
    state.lastMutation = null;
    state.file = null;

    // Derive the file path. Two paths:
    //   1. config.extensions['todo-tracker'].filePath (explicit)
    //   2. the wiring layer passes paths.projectDir in config — but
    //      PluginAPI doesn't surface that today, so the plugin can
    //      only rely on (1) until the wiring is extended.
    const derived = deriveFilePath(api);
    if (derived.filePath === null) {
      api.log.warn(
        'todo-tracker: no file path configured (set `config.extensions["todo-tracker"].filePath` or wire `paths.projectDir` through PluginAPI) — tools will report a clear error',
      );
      return;
    }

    state.filePath = derived.filePath;
    state.projectSlug = derived.projectSlug;
    state.file = await loadFile(state.filePath);
    if (state.file === null) {
      // No file yet — start with an empty store; first save will create it.
      state.file = {
        version: FILE_VERSION,
        projectSlug: state.projectSlug ?? 'tracker',
        updatedAt: nowIso(),
        items: [],
      };
    }

    // --- todo_tracker_list ---
    api.tools.register({
      name: 'todo_tracker_list',
      description:
        'List persistent todo-tracker items. Filterable by status, priority, and tag. By default only pending + in_progress items are shown.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'dropped', 'all'],
            description:
              "Filter by status. 'all' returns every item; default is pending+in_progress.",
          },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
          tag: { type: 'string', description: 'Filter by exact tag match' },
          limit: { type: 'number', description: 'Max items to return (default 50, max 200)' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        if (state.filePath === null) return notConfiguredError();
        const rawStatus =
          typeof input['status'] === 'string' ? input['status'].trim().toLowerCase() : undefined;
        const status = rawStatus ?? 'active';
        const rawPriority =
          typeof input['priority'] === 'string'
            ? input['priority'].trim().toLowerCase()
            : undefined;
        const priority = rawPriority as Priority | undefined;
        const tag = input['tag'] as string | undefined;
        const limit = Math.min(Math.max(Number(input['limit'] ?? 50) || 50, 1), 200);
        const file = ensureFile();
        let items = file.items;
        if (status !== 'all') {
          if (status === 'active') {
            items = items.filter((it) => it.status === 'pending' || it.status === 'in_progress');
          } else {
            items = items.filter((it) => it.status.toLowerCase() === status);
          }
        }
        if (priority) items = items.filter((it) => it.priority.toLowerCase() === priority);
        if (tag) items = items.filter((it) => it.tags.includes(tag));
        const total = items.length;
        const truncated = items.slice(0, limit);
        return {
          ok: true,
          total,
          returned: truncated.length,
          truncated: total > truncated.length,
          items: truncated,
        };
      },
    });

    // --- todo_tracker_add ---
    api.tools.register({
      name: 'todo_tracker_add',
      description: 'Append a new item to the persistent todo-tracker backlog.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'What needs doing (required)' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'], default: 'normal' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for filtering',
          },
          sourceSessionId: { type: 'string', description: 'Session that created this item' },
          notes: { type: 'string', description: 'Optional free-form notes' },
        },
        required: ['content'],
      },
      permission: 'auto',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        if (state.filePath === null) return notConfiguredError();
        const rawContent =
          input['content'] ??
          input['text'] ??
          input['task'] ??
          input['title'] ??
          input['todo'] ??
          input['message'] ??
          input['item'];
        const content = typeof rawContent === 'string' ? rawContent.trim() : '';
        if (!content) {
          return { ok: false, error: 'content is required and must be a non-empty string' };
        }
        const rawPri =
          typeof input['priority'] === 'string' ? input['priority'].trim().toLowerCase() : '';
        const priority: Priority =
          rawPri === 'low' || rawPri === 'high' ? (rawPri as Priority) : 'normal';
        const tags = Array.isArray(input['tags'])
          ? (input['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : [];
        const sourceSessionId =
          typeof input['sourceSessionId'] === 'string'
            ? (input['sourceSessionId'] as string)
            : null;
        const notes = typeof input['notes'] === 'string' ? (input['notes'] as string) : null;

        const now = nowIso();
        const item: TrackedItem = {
          id: randomUUID(),
          content,
          status: 'pending',
          priority,
          tags,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          sourceSessionId,
          notes,
        };
        const file = ensureFile();
        file.items.push(item);
        file.updatedAt = now;
        await saveFile(state.filePath, file);
        recordMutation('add', item.id);
        api.log.info('todo-tracker: added item', { id: item.id, content });
        try {
          await api.session?.append?.({
            type: 'todo-tracker:add',
            ts: now,
            id: item.id,
            content,
            priority,
            tags,
          });
        } catch {
          // session.append is best-effort.
        }
        return { ok: true, item };
      },
    });

    // --- todo_tracker_complete ---
    api.tools.register({
      name: 'todo_tracker_complete',
      description: 'Mark a tracked item as completed. Idempotent.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Item id' },
        },
        required: ['id'],
      },
      permission: 'auto',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        if (state.filePath === null) return notConfiguredError();
        const rawId = input['id'] ?? input['itemId'] ?? input['taskId'] ?? input['todoId'];
        const id = typeof rawId === 'string' ? rawId.trim() : '';
        if (!id) return { ok: false, error: 'id is required' };
        const idx = findItemIndex(id);
        if (idx === -1) return { ok: false, error: `no item with id ${id}` };
        const file = ensureFile();
        const item = file.items[idx]!;
        if (item.status === 'completed') {
          return { ok: true, item, message: 'already completed (idempotent)' };
        }
        const now = nowIso();
        item.status = 'completed';
        item.updatedAt = now;
        item.completedAt = now;
        file.updatedAt = now;
        await saveFile(state.filePath, file);
        recordMutation('complete', id);
        api.log.info('todo-tracker: completed item', { id });
        return { ok: true, item };
      },
    });

    // --- todo_tracker_drop ---
    api.tools.register({
      name: 'todo_tracker_drop',
      description:
        'Mark a tracked item as dropped (skipped/obsolete). The row is kept for audit. Idempotent.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Item id' },
        },
        required: ['id'],
      },
      permission: 'auto',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        if (state.filePath === null) return notConfiguredError();
        const rawId = input['id'] ?? input['itemId'] ?? input['taskId'] ?? input['todoId'];
        const id = typeof rawId === 'string' ? rawId.trim() : '';
        if (!id) return { ok: false, error: 'id is required' };
        const idx = findItemIndex(id);
        if (idx === -1) return { ok: false, error: `no item with id ${id}` };
        const file = ensureFile();
        const item = file.items[idx]!;
        if (item.status === 'dropped') {
          return { ok: true, item, message: 'already dropped (idempotent)' };
        }
        const now = nowIso();
        item.status = 'dropped';
        item.updatedAt = now;
        item.completedAt = now;
        file.updatedAt = now;
        await saveFile(state.filePath, file);
        recordMutation('drop', id);
        return { ok: true, item };
      },
    });

    // --- todo_tracker_remove ---
    api.tools.register({
      name: 'todo_tracker_remove',
      description:
        'Permanently delete a tracked item by id. Use todo_tracker_drop instead if you want to keep the audit row.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Item id' },
        },
        required: ['id'],
      },
      permission: 'confirm',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        if (state.filePath === null) return notConfiguredError();
        const rawId = input['id'] ?? input['itemId'] ?? input['taskId'] ?? input['todoId'];
        const id = typeof rawId === 'string' ? rawId.trim() : '';
        if (!id) return { ok: false, error: 'id is required' };
        const idx = findItemIndex(id);
        if (idx === -1) return { ok: false, error: `no item with id ${id}` };
        const file = ensureFile();
        const [removed] = file.items.splice(idx, 1);
        file.updatedAt = nowIso();
        await saveFile(state.filePath, file);
        recordMutation('remove', id);
        return { ok: true, removed };
      },
    });

    // --- todo_tracker_pull ---
    api.tools.register({
      name: 'todo_tracker_pull',
      description:
        'Return all pending + in_progress items. The LLM is expected to take this list and re-register each entry with the session-local `todo` tool (which mutates ctx.todos). After pull, the LLM may also choose to call todo_tracker_complete on items it finishes mid-session.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max items to return (default 50, max 200)' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        if (state.filePath === null) return notConfiguredError();
        const limit = Math.min(Math.max(Number(input['limit'] ?? 50) || 50, 1), 200);
        const file = ensureFile();
        const items = file.items
          .filter((it) => it.status === 'pending' || it.status === 'in_progress')
          .slice(0, limit);
        if (items.length > 0) {
          recordMutation('pull', items[0]!.id);
        }
        return {
          ok: true,
          total: items.length,
          items,
          hint:
            'These are persistent items. To work on them this session, ' +
            'register each one with the built-in `todo` tool. Mark them ' +
            '`completed` via todo_tracker_complete when done.',
        };
      },
    });

    // --- todo_tracker_status ---
    api.tools.register({
      name: 'todo_tracker_status',
      description:
        'Report todo-tracker counters (per-status totals) + the file path + last update timestamp.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {
        if (state.filePath === null) return notConfiguredError();
        const file = ensureFile();
        const byStatus: Record<Status, number> = {
          pending: 0,
          in_progress: 0,
          completed: 0,
          dropped: 0,
        };
        for (const it of file.items) byStatus[it.status] += 1;
        return {
          ok: true,
          filePath: state.filePath,
          projectSlug: state.projectSlug,
          updatedAt: file.updatedAt,
          counters: byStatus,
          total: file.items.length,
          session: {
            add: state.addCount,
            complete: state.completeCount,
            drop: state.dropCount,
            remove: state.removeCount,
            pull: state.pullCount,
          },
          lastMutation: state.lastMutation,
        };
      },
    });

    api.log.info('todo-tracker plugin loaded', {
      filePath: state.filePath,
      projectSlug: state.projectSlug,
      initialItemCount: state.file.items.length,
    });
  },

  teardown(api) {
    // H1 pattern: zero counters + clear in-memory cache. The on-disk
    // file is the source of truth — do NOT delete it on teardown
    // (the user may be back in a moment to read it).
    const finalCounts = {
      add: state.addCount,
      complete: state.completeCount,
      drop: state.dropCount,
      remove: state.removeCount,
      pull: state.pullCount,
    };
    state.addCount = 0;
    state.completeCount = 0;
    state.dropCount = 0;
    state.removeCount = 0;
    state.pullCount = 0;
    state.lastMutation = null;
    state.file = null;
    state.filePath = null;
    state.projectSlug = null;
    api.log.info('todo-tracker: teardown complete', { sessionCounts: finalCounts });
  },

  async health() {
    if (state.filePath === null) {
      return {
        ok: false,
        message: 'todo-tracker: no file path configured — tools will error',
      };
    }
    const file = ensureFile();
    return {
      ok: true,
      message: `todo-tracker: ${file.items.length} item(s) at ${state.filePath}`,
      filePath: state.filePath,
      projectSlug: state.projectSlug,
      total: file.items.length,
      sessionCounts: {
        add: state.addCount,
        complete: state.completeCount,
        drop: state.dropCount,
        remove: state.removeCount,
        pull: state.pullCount,
      },
      lastMutation: state.lastMutation,
    };
  },
};

export default plugin;
