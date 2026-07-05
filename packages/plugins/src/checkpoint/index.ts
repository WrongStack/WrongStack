/**
 * checkpoint plugin — in-session file snapshots with one-call undo.
 *
 * Before every `write`/`edit` the plugin captures the file's current
 * content (a `PreToolUse` hook reads the file from disk *before* the
 * tool mutates it). Snapshots are held in an in-memory ring, so the
 * agent can always roll back a bad edit — even one made outside git
 * (untracked files, mid-refactor states, dirty worktrees).
 *
 * Tools:
 *  - `checkpoint_list`    — list captured snapshots (newest first)
 *  - `checkpoint_restore` — restore a file (or all files of a
 *    checkpoint) to its captured content; files that did not exist
 *    at capture time are noted, never deleted
 *  - `checkpoint_create`  — manually snapshot a list of files before
 *    a risky operation (bulk rename, codemod, script run)
 *
 * This deliberately complements git: `git checkout` needs a commit
 * to restore to; checkpoint restores to *any* pre-edit state from
 * this session, including states that were never committed.
 *
 * Config (`config.extensions['checkpoint']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "autoCapture": true,     // snapshot before every write/edit
 *   "maxSnapshots": 50,      // ring size
 *   "maxFileBytes": 1048576  // skip files larger than this (1 MiB)
 * }
 * ```
 *
 * Toggle off with `{ "name": "checkpoint", "enabled": false }` in
 * `config.plugins`, or `"enabled": false` in the options above.
 *
 * @public
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

export interface Snapshot {
  id: string;
  createdAt: string;
  /** What triggered the capture: 'auto:write', 'auto:edit', or 'manual'. */
  origin: string;
  files: Array<{
    path: string;
    /** null = file did not exist at capture time. */
    content: string | null;
    bytes: number;
  }>;
}

interface CheckpointState {
  snapshots: Snapshot[];
  nextId: number;
  captures: number;
  restores: number;
  skippedLarge: number;
  hookUnregister: null | (() => void);
}

const state: CheckpointState = {
  snapshots: [],
  nextId: 1,
  captures: 0,
  restores: 0,
  skippedLarge: 0,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface CheckpointConfig {
  enabled: boolean;
  autoCapture: boolean;
  maxSnapshots: number;
  maxFileBytes: number;
}

const DEFAULTS: CheckpointConfig = {
  enabled: true,
  autoCapture: true,
  maxSnapshots: 50,
  maxFileBytes: 1_048_576,
};

function readConfig(raw: unknown): CheckpointConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    autoCapture: r['autoCapture'] !== false,
    maxSnapshots:
      typeof r['maxSnapshots'] === 'number' && r['maxSnapshots'] >= 1 && r['maxSnapshots'] <= 500
        ? r['maxSnapshots']
        : DEFAULTS.maxSnapshots,
    maxFileBytes:
      typeof r['maxFileBytes'] === 'number' && r['maxFileBytes'] >= 1024
        ? r['maxFileBytes']
        : DEFAULTS.maxFileBytes,
  };
}

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

function resolveProjectPath(rawPath: string, cwd = process.cwd()): string | null {
  const root = resolve(cwd);
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const rel = relative(root, resolved);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return resolved;
  return null;
}

function captureFile(path: string, maxBytes: number): Snapshot['files'][number] | 'too-large' {
  try {
    const st = statSync(path);
    if (st.size > maxBytes) return 'too-large';
    const content = readFileSync(path, 'utf-8');
    return { path, content, bytes: st.size };
  } catch {
    // File does not exist yet — record that so restore knows the file
    // was created by the tool call (restore reports it, never deletes).
    return { path, content: null, bytes: 0 };
  }
}

function pushSnapshot(snapshot: Snapshot, maxSnapshots: number): void {
  state.snapshots.push(snapshot);
  if (state.snapshots.length > maxSnapshots) {
    state.snapshots.splice(0, state.snapshots.length - maxSnapshots);
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'checkpoint',
  version: '0.1.0',
  description:
    'In-session file snapshots: auto-captures content before every write/edit and restores any pre-edit state on demand',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      autoCapture: {
        type: 'boolean',
        default: true,
        description: 'Snapshot the target file before every write/edit tool call.',
      },
      maxSnapshots: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: 50,
        description: 'Snapshot ring size — oldest snapshots are dropped first.',
      },
      maxFileBytes: {
        type: 'number',
        minimum: 1024,
        default: 1_048_576,
        description: 'Files larger than this are not captured.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.snapshots = [];
    state.nextId = 1;
    state.captures = 0;
    state.restores = 0;
    state.skippedLarge = 0;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['checkpoint']);

    // ── Auto-capture hook ─────────────────────────────────────────────
    if (cfg.enabled && cfg.autoCapture) {
      const hook = (input: { toolName?: string | undefined; toolInput?: unknown }) => {
        const ti = (input.toolInput ?? {}) as Record<string, unknown>;
        const raw = ti['path'] ?? ti['file_path'] ?? ti['filePath'];
        if (typeof raw !== 'string' || raw.length === 0) return;
        const safePath = resolveProjectPath(raw);
        if (!safePath) return;
        const captured = captureFile(safePath, cfg.maxFileBytes);
        if (captured === 'too-large') {
          state.skippedLarge += 1;
          return;
        }
        pushSnapshot(
          {
            id: `cp-${state.nextId++}`,
            createdAt: new Date().toISOString(),
            origin: `auto:${input.toolName ?? 'unknown'}`,
            files: [captured],
          },
          cfg.maxSnapshots,
        );
        state.captures += 1;
        api.metrics.counter('captures');
      };
      state.hookUnregister = api.registerHook('PreToolUse', 'write|edit', hook as never);
    }

    // ── checkpoint_create ─────────────────────────────────────────────
    api.tools.register({
      name: 'checkpoint_create',
      description:
        'Manually snapshot the current content of one or more files before a risky operation (codemod, bulk rename, script run). Restore later with checkpoint_restore.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'File paths to snapshot.',
          },
          label: { type: 'string', description: 'Optional label recorded as the origin.' },
        },
        required: ['paths'],
      },
      permission: 'auto',
      category: 'Safety',
      mutating: false,
      async execute(input: { paths: string[]; label?: string | undefined }) {
        if (!cfg.enabled) return { ok: false, error: 'checkpoint is disabled' };
        const paths = Array.isArray(input.paths)
          ? input.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
          : [];
        if (paths.length === 0) return { ok: false, error: 'paths must not be empty' };
        const files: Snapshot['files'] = [];
        const rejectedOutsideProject: string[] = [];
        let skipped = 0;
        for (const p of paths) {
          const safePath = resolveProjectPath(p);
          if (!safePath) {
            rejectedOutsideProject.push(p);
            continue;
          }
          const captured = captureFile(safePath, cfg.maxFileBytes);
          if (captured === 'too-large') {
            skipped += 1;
            state.skippedLarge += 1;
            continue;
          }
          files.push(captured);
        }
        if (rejectedOutsideProject.length > 0) {
          return {
            ok: false,
            error: 'paths must stay within the current project directory',
            rejectedOutsideProject,
          };
        }
        if (files.length === 0) {
          return { ok: false, error: 'all files were skipped (too large)' };
        }
        const snapshot: Snapshot = {
          id: `cp-${state.nextId++}`,
          createdAt: new Date().toISOString(),
          origin: input.label?.trim() ? `manual:${input.label.trim()}` : 'manual',
          files,
        };
        pushSnapshot(snapshot, cfg.maxSnapshots);
        state.captures += 1;
        api.metrics.counter('captures');
        return {
          ok: true,
          id: snapshot.id,
          capturedFiles: files.map((f) => ({ path: f.path, existed: f.content !== null })),
          skippedTooLarge: skipped,
        };
      },
    });

    // ── checkpoint_list ───────────────────────────────────────────────
    api.tools.register({
      name: 'checkpoint_list',
      description: 'List captured file snapshots (newest first) with ids for checkpoint_restore.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max entries to return (default 20).' },
        },
      },
      permission: 'auto',
      category: 'Safety',
      mutating: false,
      async execute(input: { limit?: number | undefined }) {
        const limit =
          typeof input.limit === 'number' && input.limit >= 1 ? Math.floor(input.limit) : 20;
        return {
          ok: true,
          enabled: cfg.enabled,
          autoCapture: cfg.autoCapture,
          total: state.snapshots.length,
          snapshots: [...state.snapshots]
            .reverse()
            .slice(0, limit)
            .map((s) => ({
              id: s.id,
              createdAt: s.createdAt,
              origin: s.origin,
              files: s.files.map((f) => ({
                path: f.path,
                existed: f.content !== null,
                bytes: f.bytes,
              })),
            })),
          counters: {
            captures: state.captures,
            restores: state.restores,
            skippedLarge: state.skippedLarge,
          },
        };
      },
    });

    // ── checkpoint_restore ────────────────────────────────────────────
    api.tools.register({
      name: 'checkpoint_restore',
      description:
        'Restore file(s) to the content captured in a snapshot (see checkpoint_list). Restores every file in the snapshot, or a single file when `path` is given. Files that did not exist at capture time are reported but never deleted.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Snapshot id (cp-N). Default: the newest snapshot.' },
          path: {
            type: 'string',
            description: 'Restore only this file from the snapshot (optional).',
          },
        },
      },
      permission: 'confirm',
      category: 'Safety',
      mutating: true,
      async execute(input: { id?: string | undefined; path?: string | undefined }) {
        if (!cfg.enabled) return { ok: false, error: 'checkpoint is disabled' };
        const snapshot = input.id
          ? state.snapshots.find((s) => s.id === input.id)
          : state.snapshots[state.snapshots.length - 1];
        if (!snapshot) {
          return {
            ok: false,
            error: input.id ? `no snapshot with id "${input.id}"` : 'no snapshots captured yet',
          };
        }
        const targets = input.path
          ? snapshot.files.filter((f) => f.path === input.path)
          : snapshot.files;
        if (targets.length === 0) {
          return { ok: false, error: `snapshot ${snapshot.id} has no entry for "${input.path}"` };
        }
        const restored: string[] = [];
        const createdByTool: string[] = [];
        const errors: Array<{ path: string; error: string }> = [];
        for (const f of targets) {
          if (f.content === null) {
            // The file did not exist at capture time — the tool call
            // created it. Deleting user files is out of scope; report.
            createdByTool.push(f.path);
            continue;
          }
          try {
            mkdirSync(dirname(f.path), { recursive: true });
            writeFileSync(f.path, f.content);
            restored.push(f.path);
          } catch (err) {
            errors.push({ path: f.path, error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (restored.length > 0) {
          state.restores += 1;
          api.metrics.counter('restores');
        }
        return {
          ok: errors.length === 0,
          snapshotId: snapshot.id,
          restored,
          notRestoredFileDidNotExist: createdByTool,
          errors,
        };
      },
    });

    api.log.info('checkpoint plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      autoCapture: cfg.autoCapture,
      maxSnapshots: cfg.maxSnapshots,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      captures: state.captures,
      restores: state.restores,
      skippedLarge: state.skippedLarge,
      snapshotsHeld: state.snapshots.length,
    };
    state.snapshots = [];
    state.nextId = 1;
    state.captures = 0;
    state.restores = 0;
    state.skippedLarge = 0;
    api.log.info('checkpoint: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `checkpoint: ${state.snapshots.length} snapshot(s) held, ${state.captures} capture(s), ${state.restores} restore(s), ${state.skippedLarge} skipped (too large)`,
      counters: {
        snapshotsHeld: state.snapshots.length,
        captures: state.captures,
        restores: state.restores,
        skippedLarge: state.skippedLarge,
      },
    };
  },
};

export default plugin;
