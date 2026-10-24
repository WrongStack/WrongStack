/**
 * HQ alerts-config persistence — `<dataDir>/alerts-config.json`.
 *
 * W2 #13 (RFC hq-improvements-2026-09.md): operator-configurable alert
 * thresholds and per-rule snoozes survive HQ server restarts. Lives in its
 * own JSON file (not appended to `alerts.jsonl`, which is the audit trail)
 * because:
 *
 *   - The audit trail is immutable history; snoozes are mutable operator
 *     state. Mixing them would require in-place rewrites of an append-only
 *     log, which we deliberately don't do.
 *   - Snooze writes are rare (operator action) but happen mid-session;
 *     atomic-replace semantics are right for them. JSONL append is for the
 *     fires-and-history stream, not for current state.
 *
 * Same design constraints as {@link module:hq/auth-store}:
 *   - Reads fail CLOSED with one exception: ENOENT returns an empty file
 *     (fresh install / first boot).
 *   - All writes go through {@link atomicWrite} with `mode: 0o600` and the
 *     Windows-hardened path, so a shared host cannot read the snooze state.
 *   - Read-modify-write cycles use {@link mutateHqAlertsConfig} which takes
 *     a {@link withFileLock} under the hood. The 2026-08-25 deferred
 *     heartbeat (1 s floor) is inherited automatically — callers MUST NOT
 *     add their own lock or setTimeout deferral.
 *   - Best-effort on disk failure; degradation to in-memory-only is
 *     acceptable. Callers wrap in try/catch and log on failure.
 *
 * @module hq/alerts-config
 */

import * as syncFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  atomicWrite,
  restrictFilePermissions,
  SECRET_FILE_MODE,
  withFileLock,
} from '@wrongstack/persistence';

import type { HqAlertRuleConfig } from './alerts.js';

/** Current alerts-config schema version. Bump on breaking shape changes. */
export const HQ_ALERTS_CONFIG_VERSION = 1 as const;

/**
 * On-disk shape of `<dataDir>/alerts-config.json`.
 *
 * `thresholds` is partial — fields absent fall back to the alert engine's
 * built-in defaults. `snoozes` maps ruleId → epoch-ms deadline; expired
 * entries are filtered at seed time.
 */
export interface HqAlertsConfigFile {
  version: typeof HQ_ALERTS_CONFIG_VERSION;
  updatedAt: string;
  thresholds?: HqAlertRuleConfig;
  snoozes?: Record<string, number>;
}

/** Empty config — what a brand-new HQ install starts with. */
export function emptyHqAlertsConfig(): HqAlertsConfigFile {
  return {
    version: HQ_ALERTS_CONFIG_VERSION,
    updatedAt: new Date().toISOString(),
  };
}

/** Path to `alerts-config.json` under the given data directory. */
export function hqAlertsConfigFilePath(dataDir: string): string {
  return path.join(dataDir, 'alerts-config.json');
}

/**
 * Read `alerts-config.json` from disk. Returns `emptyHqAlertsConfig()` when
 * the file does NOT exist (ENOENT) — the only case treated as intentional
 * open mode.
 *
 * Throws for all other read failures (EACCES, EIO, malformed JSON, an
 * unsupported schema version). A corrupt or unreadable alerts-config must
 * never silently open the engine with default thresholds AND a different
 * snooze set; the operator either fixes the file or starts fresh.
 *
 * Callers that want to handle errors gracefully (e.g. the live-reload
 * watcher, which should preserve the last-known-good state) should catch
 * the thrown error.
 */
export async function readHqAlertsConfig(dataDir: string): Promise<HqAlertsConfigFile> {
  const file = hqAlertsConfigFilePath(dataDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyHqAlertsConfig();
    throw new Error(
      `HQ alerts-config at ${file} cannot be read: ${(err as Error).message}. ` +
        'Fix the file permissions or delete it to start with an empty alerts state.',
    );
  }
  let parsed: HqAlertsConfigFile;
  try {
    // Notepad / PowerShell 5 save this hand-edited file with a UTF-8 BOM.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as HqAlertsConfigFile;
  } catch (err) {
    throw new Error(
      `HQ alerts-config at ${file} is not valid JSON: ${(err as Error).message}. ` +
        'Fix the file or delete it to start with an empty alerts state.',
    );
  }
  if (parsed.version !== HQ_ALERTS_CONFIG_VERSION) {
    throw new Error(
      `HQ alerts-config at ${file} has unsupported version ${String(parsed.version)} ` +
        `(expected ${String(HQ_ALERTS_CONFIG_VERSION)}). ` +
        'Remove or update the file to match the current schema version.',
    );
  }
  return parsed;
}

/**
 * Write `alerts-config.json` atomically, owner-only. Creates the data
 * directory if needed. Throws on I/O failure — callers (the dashboard's
 * snooze API, the alerts eval CLI) should surface the error to the
 * operator.
 *
 * The redaction here is minimal (no secrets in the file), but the file IS
 * owner-only because:
 *   - snooze deadlines leak operator workflow timing
 *   - thresholds reveal the operator's alerting philosophy
 *   - both are diagnostic metadata that the operator expects to keep
 *     private from other accounts on a shared host
 */
export async function writeHqAlertsConfig(
  dataDir: string,
  file: HqAlertsConfigFile,
): Promise<void> {
  const target = hqAlertsConfigFilePath(dataDir);
  const payload: HqAlertsConfigFile = {
    ...file,
    version: HQ_ALERTS_CONFIG_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(target, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: SECRET_FILE_MODE,
  });
  await restrictFilePermissions(target, { label: 'hq-alerts-config' });
}

export interface MutateHqAlertsConfigOptions {
  /**
   * Lock timeout in ms. Default 30 000, matching the locked pattern from
   * the kanban tool bug (see the persistence memory entry): under
   * cross-process contention, `withFileLock` polls for up to 15 s per
   * acquire attempt, and a brief network-filesystem stall can eat a full
   * cycle. 30 s gives one retry's worth of headroom and is the same value
   * the kanban tool now uses.
   */
  lockTimeoutMs?: number;
  /**
   * Stale threshold for the lock in ms. Default 30 000. When the live
   * holder's heartbeat fails to refresh for this long, an orphan lock is
   * assumed and a new acquire proceeds (handled by the persistence
   * layer's heartbeat; orphan cleanup is out of scope for this module).
   */
  lockStaleMs?: number;
}

/**
 * Load → mutate → write. The mutator receives the current file (or an
 * empty one) and returns the next file. Use this for any read-modify-write
 * cycle to avoid clobbering concurrent edits from another CLI invocation.
 *
 * Wraps the cycle in `withFileLock` so two concurrent `wstack hq alerts`
 * subcommands cannot tear-write. The 2026-08-25 deferred heartbeat (1 s
 * floor, decision-memory binding) is inherited automatically — callers
 * MUST NOT add their own setTimeout deferral or `Math.max(50, …)` floor.
 */
export async function mutateHqAlertsConfig(
  dataDir: string,
  mutator: (current: HqAlertsConfigFile) => HqAlertsConfigFile | Promise<HqAlertsConfigFile>,
  opts: MutateHqAlertsConfigOptions = {},
): Promise<HqAlertsConfigFile> {
  const target = hqAlertsConfigFilePath(dataDir);
  const lockTimeoutMs = opts.lockTimeoutMs ?? 30_000;
  const lockStaleMs = opts.lockStaleMs ?? 30_000;
  return withFileLock(
    target,
    async () => {
      const current = await readHqAlertsConfig(dataDir);
      const next = await mutator(current);
      await writeHqAlertsConfig(dataDir, next);
      return next;
    },
    { timeoutMs: lockTimeoutMs, staleMs: lockStaleMs },
  );
}

/**
 * Watch `alerts-config.json` for changes and invoke `onChange` with the
 * freshly-read file. Returns a `close()` function that stops watching.
 *
 * Mirrors `watchHqAuthFile`:
 *   - Debounce 200 ms (editors do tmp+rename, which emits multiple events).
 *   - Poll the parent directory, not the file itself, so atomic-rename
 *     events surface reliably.
 *   - Best-effort: a watcher failure logs via `warn` and the watcher
 *     stays dormant. The operator must restart the server to resume
 *     external-edit detection.
 *   - On read failure the `warn` callback fires and the watcher stays
 *     active so a future valid write re-triggers the callback.
 */
export function watchHqAlertsConfig(
  dataDir: string,
  onChange: (file: HqAlertsConfigFile) => void,
  opts: { warn?: (msg: string) => void; debounceMs?: number } = {},
): { close: () => void } {
  const file = hqAlertsConfigFilePath(dataDir);
  const debounceMs = opts.debounceMs ?? 200;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  let watcher: syncFs.FSWatcher;
  try {
    watcher = syncFs.watch(path.dirname(file), { recursive: false });
  } catch (err) {
    opts.warn?.(`HQ alerts-config watcher could not start: ${(err as Error).message}`);
    return { close: () => {} };
  }

  const trigger = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void readHqAlertsConfig(dataDir).then(
        (next) => {
          if (!closed) onChange(next);
        },
        (err) => {
          opts.warn?.(`HQ alerts-config read failed: ${(err as Error).message}`);
        },
      );
    }, debounceMs);
  };

  // Without a listener an FSWatcher 'error' event is an uncaught exception
  // (Windows emits transient EPERMs on dir churn). Degrade to "no watcher"
  // — same as the creation-failure path above.
  watcher.on('error', (err: Error) => {
    opts.warn?.(`HQ alerts-config watcher error: ${err.message}`);
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  });

  watcher.on('change', (eventType: string, filename: string | Buffer | null) => {
    const name = typeof filename === 'string' ? filename : '';
    // Windows reports a deleted watched directory as an endless 'rename' storm
    // of its own absolute path (never error/close). Stop instead of spinning.
    if (path.isAbsolute(name)) {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
      opts.warn?.(`HQ alerts-config watcher stopped: ${path.dirname(file)} was removed`);
      return;
    }
    if (eventType === 'rename' || eventType === 'change') {
      if (!name || name === 'alerts-config.json' || name === path.basename(file)) {
        trigger();
      }
    }
  });

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
