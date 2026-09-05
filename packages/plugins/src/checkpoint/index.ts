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

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';

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
  /** Snapshots dropped to respect the retained-bytes budget. */
  evictedForBytes: number;
  hookUnregister: null | (() => void);
}

const state: CheckpointState = {
  snapshots: [],
  nextId: 1,
  captures: 0,
  restores: 0,
  skippedLarge: 0,
  evictedForBytes: 0,
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
  /**
   * Ceiling on total retained snapshot content, in bytes. The snapshot
   * count alone is not a memory bound — one snapshot holds every file a
   * write touched, so `maxSnapshots x maxFileBytes x files-per-write` is
   * the real worst case. Oldest snapshots are dropped past this.
   */
  maxTotalBytes: number;
}

const DEFAULTS: CheckpointConfig = {
  enabled: true,
  autoCapture: true,
  maxSnapshots: 50,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 64 * 1_048_576,
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
    maxTotalBytes:
      typeof r['maxTotalBytes'] === 'number' && r['maxTotalBytes'] >= 1024
        ? r['maxTotalBytes']
        : DEFAULTS.maxTotalBytes,
    maxFileBytes:
      typeof r['maxFileBytes'] === 'number' && r['maxFileBytes'] >= 1024
        ? r['maxFileBytes']
        : DEFAULTS.maxFileBytes,
  };
}

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

async function resolveProjectPath(rawPath: string, cwd = process.cwd()): Promise<string | null> {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const root = resolve(cwd);
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const rel = relative(root, resolved);
  const lexicallyInside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!lexicallyInside) return null;
  // Lexically inside is not sufficient: checkpoints hold file CONTENT, so a
  // project-local symlink/junction whose real target escaped the project
  // must be rejected like any other outside path. Not-yet-existing leaves
  // resolve via their nearest existing ancestor so brand-new files keep
  // being captured.
  if (await realResolutionEscapes(resolved, root)) return null;
  return resolved;
}

/**
 * True when the canonical resolution of `absPath` — following symlinks, via
 * the nearest existing ancestor when the leaf does not exist yet — lies
 * outside `root`. The non-existing tail cannot re-escape on its own: the
 * caller already established `absPath` is lexically inside `root`.
 */
async function realResolutionEscapes(absPath: string, root: string): Promise<boolean> {
  let real: string;
  try {
    real = await realpath(absPath);
  } catch {
    let current = dirname(absPath);
    let hops = 0;
    while (hops < 64 && !(await pathExists(current))) {
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
      hops++;
    }
    if (!(await pathExists(current))) return false;
    try {
      real = await realpath(current);
    } catch {
      return false;
    }
  }
  const realRel = relative(root, real);
  return realRel !== '' && realRel !== '.' && (realRel.startsWith('..') || isAbsolute(realRel));
}

/** Async existence probe (stat-based) so hot paths never touch sync fs APIs. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tiny non-cryptographic content fingerprint (DJB2) used by the
 * `checkpoint:captured` custom event. Consumers compare hashes per
 * path to detect file changes between captures — same hash means
 * no observable change, different hash means the file mutated.
 *
 * Capped at 64 KB to keep the cost bounded on very large files; the
 * first 64 KB is more than enough to distinguish real edits.
 */
function hashContent(s: string): number {
  const cap = Math.min(s.length, 65536);
  let h = 5381;
  for (let i = 0; i < cap; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

async function captureFile(
  path: string,
  maxBytes: number,
): Promise<Snapshot['files'][number] | 'too-large'> {
  try {
    const st = await stat(path);
    if (st.size > maxBytes) return 'too-large';
    const content = await readFile(path, 'utf-8');
    return { path, content, bytes: st.size };
  } catch {
    // File does not exist yet — record that so restore knows the file
    // was created by the tool call (restore reports it, never deletes).
    return { path, content: null, bytes: 0 };
  }
}

async function captureFileForHook(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Snapshot['files'][number] | 'too-large'> {
  try {
    signal.throwIfAborted();
    const st = await stat(path);
    if (st.size > maxBytes) return 'too-large';
    const content = await readFile(path, 'utf-8');
    signal.throwIfAborted();
    return { path, content, bytes: st.size };
  } catch (err) {
    if (signal.aborted) throw err;
    return { path, content: null, bytes: 0 };
  }
}

/** Retained bytes across all snapshots — surfaced by status/health(). */
export function retainedSnapshotBytes(): number {
  let total = 0;
  for (const snap of state.snapshots) {
    for (const f of snap.files) total += f.content === null ? 0 : f.content.length;
  }
  return total;
}

function pushSnapshot(snapshot: Snapshot, maxSnapshots: number, maxTotalBytes: number): void {
  state.snapshots.push(snapshot);
  if (state.snapshots.length > maxSnapshots) {
    state.snapshots.splice(0, state.snapshots.length - maxSnapshots);
  }
  // A count-only ring is not a memory bound: one snapshot holds every file
  // a single write touched, each up to `maxFileBytes`. With the default 50
  // snapshots that is already tens of MiB, and `maxSnapshots` goes to 500 —
  // all of it live for the whole session, captured automatically on every
  // write. Evict oldest-first until the retained total fits the budget,
  // always keeping the newest snapshot so a restore is still possible.
  while (state.snapshots.length > 1 && retainedSnapshotBytes() > maxTotalBytes) {
    state.snapshots.shift();
    state.evictedForBytes += 1;
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
    state.evictedForBytes = 0;
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
      const hook = async (
        input: { toolName?: string | undefined; toolInput?: unknown },
        runtime: { signal: AbortSignal } = { signal: new AbortController().signal },
      ) => {
        const ti = (input.toolInput ?? {}) as Record<string, unknown>;
        const raw =
          ti['path'] ??
          ti['file_path'] ??
          ti['filePath'] ??
          ti['TargetFile'] ??
          ti['targetFile'] ??
          ti['file'];
        if (typeof raw !== 'string' || raw.length === 0) return;
        const safePath = await resolveProjectPath(raw);
        if (!safePath) return;
        const captured = await captureFileForHook(safePath, cfg.maxFileBytes, runtime.signal);
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
          cfg.maxTotalBytes,
        );
        state.captures += 1;
        api.metrics.counter('captures');

        // Cross-plugin coordination: announce the capture so plugins
        // that read the file post-write (spec-linker, diff-summary,
        // etc.) can avoid a redundant disk read or use the captured
        // bytes as a change-detection signal. The hash is a tiny
        // DJB2 over the captured content (null content => 0).
        api.emitCustom?.('checkpoint:captured', {
          path: safePath,
          bytes: captured.bytes,
          hadContent: captured.content !== null,
          // 32-bit unsigned hash of the captured bytes. Collisions
          // are tolerable (consumers should compare hashes per-path,
          // not across paths).
          contentHash: captured.content !== null ? hashContent(captured.content) : 0,
          when: new Date().toISOString(),
        });
      };
      state.hookUnregister = api.registerHook('PreToolUse', 'write|edit', hook as never, {
        name: 'checkpoint-guard',
        stage: 'validate',
        // Checkpointing is recovery automation, not an enforcement boundary.
        // A transient read failure must not stall normal/YOLO writes.
        failurePolicy: 'open',
      });
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
        let paths: string[] = [];
        const rawInput = input as unknown as Record<string, unknown>;
        const raw =
          rawInput['paths'] ??
          rawInput['path'] ??
          rawInput['files'] ??
          rawInput['file'] ??
          rawInput['filePath'] ??
          rawInput['file_path'] ??
          rawInput['TargetFile'] ??
          rawInput['targetFile'];
        if (typeof raw === 'string' && raw.trim().length > 0) {
          paths = [raw.trim()];
        } else if (Array.isArray(raw)) {
          paths = raw.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
        }
        if (paths.length === 0) return { ok: false, error: 'paths must not be empty' };
        const files: Snapshot['files'] = [];
        const rejectedOutsideProject: string[] = [];
        let skipped = 0;
        for (const p of paths) {
          const safePath = await resolveProjectPath(p);
          if (!safePath) {
            rejectedOutsideProject.push(p);
            continue;
          }
          const captured = await captureFile(safePath, cfg.maxFileBytes);
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
        pushSnapshot(snapshot, cfg.maxSnapshots, cfg.maxTotalBytes);
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
            retainedBytes: retainedSnapshotBytes(),
            evictedForBytes: state.evictedForBytes,
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
        const raw = (input ?? {}) as Record<string, unknown>;
        const rawId =
          (typeof input.id === 'string' && input.id.trim().length > 0
            ? input.id.trim()
            : undefined) ??
          (typeof raw['snapshotId'] === 'string' ? raw['snapshotId'] : undefined) ??
          (typeof raw['snapshot_id'] === 'string' ? raw['snapshot_id'] : undefined);
        const rawPath =
          (typeof input.path === 'string' && input.path.trim().length > 0
            ? input.path.trim()
            : undefined) ??
          (typeof raw['filePath'] === 'string' ? raw['filePath'] : undefined) ??
          (typeof raw['file_path'] === 'string' ? raw['file_path'] : undefined) ??
          (typeof raw['TargetFile'] === 'string' ? raw['TargetFile'] : undefined) ??
          (typeof raw['targetFile'] === 'string' ? raw['targetFile'] : undefined) ??
          (typeof raw['file'] === 'string' ? raw['file'] : undefined);
        const snapshot = rawId
          ? state.snapshots.find((s) => s.id === rawId)
          : state.snapshots[state.snapshots.length - 1];
        if (!snapshot) {
          return {
            ok: false,
            error: rawId ? `no snapshot with id "${rawId}"` : 'no snapshots captured yet',
          };
        }
        const targetPath = rawPath ? ((await resolveProjectPath(rawPath)) ?? rawPath) : null;
        const targets = targetPath
          ? snapshot.files.filter((f) => f.path === targetPath || f.path === rawPath)
          : snapshot.files;
        if (targets.length === 0) {
          return { ok: false, error: `snapshot ${snapshot.id} has no entry for "${rawPath}"` };
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
            await mkdir(dirname(f.path), { recursive: true });
            await writeFile(f.path, f.content);
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
      retainedBytes: retainedSnapshotBytes(),
      evictedForBytes: state.evictedForBytes,
    };
    state.snapshots = [];
    state.nextId = 1;
    state.captures = 0;
    state.restores = 0;
    state.skippedLarge = 0;
    state.evictedForBytes = 0;
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
        // Retained snapshot bytes: the count-based ring alone does not
        // bound memory, so surface the number the byte budget acts on.
        retainedBytes: retainedSnapshotBytes(),
        evictedForBytes: state.evictedForBytes,
      },
    };
  },
};

export default plugin;
