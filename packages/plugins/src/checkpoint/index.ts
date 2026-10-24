/**
 * checkpoint plugin — in-session file snapshots with one-call undo.
 *
 * Before every `write`/`edit` the plugin captures the file's current
 * content (a `PreToolUse` hook reads the file from disk *before* the
 * tool mutates it). Snapshots are held in project/session rings scoped
 * to their host, so the agent can restore captured edits made outside git
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
 *   "maxFileBytes": 1048576, // skip files larger than this (1 MiB)
 *   "maxTotalBytes": 67108864 // retained content budget across this host
 * }
 * ```
 *
 * Toggle off with `{ "name": "checkpoint", "enabled": false }` in
 * `config.plugins`, or `"enabled": false` in the options above.
 *
 * @public
 */

import { type Plugin, ToolValidationError } from '@wrongstack/contracts/types';
import type { Snapshot } from './snapshot.js';
import {
  type CheckpointHost,
  type CheckpointState,
  endSession,
  hosts,
  nextSnapshotId,
  scopeFor,
  scopeSignal,
  stateBytes,
  states,
} from './state.js';
import { captureFile, resolveProjectPath, restoreFile } from './storage.js';

export type { Snapshot } from './snapshot.js';

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
      typeof r['maxSnapshots'] === 'number' &&
      Number.isInteger(r['maxSnapshots']) &&
      r['maxSnapshots'] >= 1 &&
      r['maxSnapshots'] <= 500
        ? r['maxSnapshots']
        : DEFAULTS.maxSnapshots,
    maxTotalBytes:
      typeof r['maxTotalBytes'] === 'number' &&
      Number.isSafeInteger(r['maxTotalBytes']) &&
      r['maxTotalBytes'] >= 1024
        ? r['maxTotalBytes']
        : DEFAULTS.maxTotalBytes,
    maxFileBytes:
      typeof r['maxFileBytes'] === 'number' &&
      Number.isSafeInteger(r['maxFileBytes']) &&
      r['maxFileBytes'] >= 1024
        ? r['maxFileBytes']
        : DEFAULTS.maxFileBytes,
  };
}

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

function hashContent(s: string): number {
  const cap = Math.min(s.length, 65536);
  let h = 5381;
  for (let i = 0; i < cap; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** Retained bytes across all active hosts, projects and sessions. */
export function retainedSnapshotBytes(): number {
  return states().reduce((sum, state) => sum + stateBytes(state), 0);
}

function pushSnapshot(
  host: CheckpointHost,
  state: CheckpointState,
  snapshot: Snapshot,
  maxSnapshots: number,
  maxTotalBytes: number,
): void {
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
  while (
    [...host.scopes.values()].reduce((sum, scope) => sum + stateBytes(scope), 0) > maxTotalBytes
  ) {
    let oldest: { scope: CheckpointState; snapshot: Snapshot } | undefined;
    for (const scope of host.scopes.values()) {
      for (const candidate of scope.snapshots) {
        if (candidate === snapshot) continue;
        // Monotonic ids preserve capture order even when timestamps tie or the clock moves back.
        if (!oldest || Number(candidate.id.slice(3)) < Number(oldest.snapshot.id.slice(3)))
          oldest = { scope, snapshot: candidate };
      }
    }
    if (!oldest) break; // Keep the newly captured snapshot even when it alone exceeds the budget.
    oldest.scope.snapshots.splice(oldest.scope.snapshots.indexOf(oldest.snapshot), 1);
    oldest.scope.evictedForBytes += 1;
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
        type: 'integer',
        minimum: 1,
        maximum: 500,
        default: 50,
        description: 'Snapshot ring size — oldest snapshots are dropped first.',
      },
      maxFileBytes: {
        type: 'integer',
        minimum: 1024,
        default: 1_048_576,
        description: 'Files larger than this are not captured.',
      },
      maxTotalBytes: {
        type: 'integer',
        minimum: 1024,
        default: DEFAULTS.maxTotalBytes,
        description:
          'Retained snapshot content budget across this host; oldest snapshots are evicted, keeping the newest snapshot even if it exceeds this budget.',
      },
    },
  },

  setup(api) {
    const host = hosts.reset(api);
    const baseRoot = api.config.cwd ?? process.cwd();
    const cfg = readConfig(api.config.extensions?.['checkpoint']);
    host.sessionUnregister =
      api.onEvent?.('session.ended', (event) => endSession(host, event?.id)) ?? null;

    // ── Auto-capture hook ─────────────────────────────────────────────
    if (cfg.enabled && cfg.autoCapture) {
      const hook = async (
        input: {
          toolName?: string | undefined;
          toolInput?: unknown;
          cwd?: string | undefined;
          sessionId?: string | undefined;
        },
        runtime: { signal: AbortSignal } = { signal: new AbortController().signal },
      ) => {
        const state = await scopeFor(host, baseRoot, input);
        const signal = scopeSignal(host, state, runtime.signal);
        signal.throwIfAborted();
        const ti = (input.toolInput ?? {}) as Record<string, unknown>;
        const raw =
          ti['path'] ??
          ti['file_path'] ??
          ti['filePath'] ??
          ti['TargetFile'] ??
          ti['targetFile'] ??
          ti['file'];
        if (typeof raw !== 'string' || raw.length === 0) return;
        const safePath = await resolveProjectPath(raw, state.root);
        if (!safePath) return;
        const captured = await captureFile(safePath, cfg.maxFileBytes, signal);
        if (captured === 'too-large') {
          state.skippedLarge += 1;
          return;
        }
        signal.throwIfAborted();
        pushSnapshot(
          host,
          state,
          {
            id: nextSnapshotId(),
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
      host.extensionUnregister = api.registerHook('PreToolUse', 'write|edit', hook as never, {
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
      async execute(input: { paths: string[]; label?: string | undefined }, ctx, options) {
        const state = await scopeFor(host, baseRoot, ctx);
        const signal = scopeSignal(host, state, options?.signal);
        signal.throwIfAborted();
        if (!cfg.enabled) throw new Error('checkpoint is disabled');
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
        if (paths.length === 0) {
          throw new ToolValidationError({ message: 'paths must not be empty', field: 'paths' });
        }
        const rejectedOutsideProject: string[] = [];
        const safePaths: string[] = [];
        for (const p of paths) {
          const safePath = await resolveProjectPath(p, state.root);
          if (safePath) safePaths.push(safePath);
          else rejectedOutsideProject.push(p);
        }
        if (rejectedOutsideProject.length > 0) {
          throw new ToolValidationError({
            message: `paths must stay within the current project directory: ${rejectedOutsideProject.join(', ')}`,
            field: 'paths',
          });
        }
        const files: Snapshot['files'] = [];
        let skipped = 0;
        for (const safePath of safePaths) {
          const captured = await captureFile(safePath, cfg.maxFileBytes, signal);
          if (captured === 'too-large') {
            skipped += 1;
            state.skippedLarge += 1;
            continue;
          }
          files.push(captured);
        }
        if (files.length === 0) {
          throw new Error(
            `all files were skipped (larger than maxFileBytes=${cfg.maxFileBytes}); nothing was snapshotted`,
          );
        }
        const snapshot: Snapshot = {
          id: nextSnapshotId(),
          createdAt: new Date().toISOString(),
          origin: input.label?.trim() ? `manual:${input.label.trim()}` : 'manual',
          files,
        };
        signal.throwIfAborted();
        pushSnapshot(host, state, snapshot, cfg.maxSnapshots, cfg.maxTotalBytes);
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
      async execute(input: { limit?: number | undefined }, ctx, options) {
        const state = await scopeFor(host, baseRoot, ctx);
        scopeSignal(host, state, options?.signal).throwIfAborted();
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
            retainedBytes: stateBytes(state),
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
      async execute(input: { id?: string | undefined; path?: string | undefined }, ctx, options) {
        const state = await scopeFor(host, baseRoot, ctx);
        const signal = scopeSignal(host, state, options?.signal);
        signal.throwIfAborted();
        if (!cfg.enabled) throw new Error('checkpoint is disabled');
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
          throw new Error(rawId ? `no snapshot with id "${rawId}"` : 'no snapshots captured yet');
        }
        const targetPath = rawPath ? await resolveProjectPath(rawPath, state.root) : null;
        if (rawPath && !targetPath)
          throw new ToolValidationError({
            message: 'Restore path must stay within the current project directory',
            field: 'path',
          });
        const targets = targetPath
          ? snapshot.files.filter((f) => f.path === targetPath || f.path === rawPath)
          : snapshot.files;
        if (targets.length === 0) {
          throw new Error(`snapshot ${snapshot.id} has no entry for "${rawPath}"`);
        }
        // Validate the whole selection before writing any file.
        for (const file of targets) {
          signal.throwIfAborted();
          try {
            if ((await resolveProjectPath(file.path, state.root)) !== file.path)
              throw new Error('path moved outside the project or changed its target');
          } catch (error) {
            throw new Error(
              `checkpoint_restore ${snapshot.id}: failed to restore ${file.path}: ${String(error)}`,
              { cause: error },
            );
          }
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
            await restoreFile(f, state.root, signal);
            restored.push(f.path);
          } catch (err) {
            errors.push({ path: f.path, error: err instanceof Error ? err.message : String(err) });
            if (signal.aborted) break;
          }
        }
        if (restored.length > 0) {
          state.restores += 1;
          api.metrics.counter('restores');
        }
        if (errors.length > 0) {
          const failed = errors.map((e) => `${e.path} (${e.error})`).join('; ');
          throw new Error(
            `checkpoint_restore ${snapshot.id}: ${errors.length} file(s) failed to restore: ${failed}` +
              (restored.length > 0 ? `. Restored: ${restored.join(', ')}` : ''),
          );
        }
        return {
          ok: true,
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
    const host = hosts.get(api);
    if (!host) return;
    const final = {
      snapshotsHeld: [...host.scopes.values()].reduce(
        (sum, scope) => sum + scope.snapshots.length,
        0,
      ),
    };
    hosts.remove(api);
    api.log.info('checkpoint: teardown complete', { final });
  },

  async health() {
    const active = states();
    const state = {
      snapshots: active.flatMap((scope) => scope.snapshots),
      captures: 0,
      restores: 0,
      skippedLarge: 0,
      evictedForBytes: 0,
    };
    for (const scope of active) {
      state.captures += scope.captures;
      state.restores += scope.restores;
      state.skippedLarge += scope.skippedLarge;
      state.evictedForBytes += scope.evictedForBytes;
    }
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
