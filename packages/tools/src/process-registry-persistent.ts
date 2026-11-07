/**
 * PersistentProcessRegistry — filesystem-backed process registry that survives
 * process restarts and coordinates protection across multiple WrongStack instances
 * running in different terminals.
 *
 * Key features:
 * - PIDs stored in ~/.wrongstack/process-registry.json
 * - File locking for cross-instance coordination
 * - Heartbeat mechanism to detect stale entries
 * - Protection whitelist that blocks kill commands targeting WrongStack processes
 * - Multi-instance awareness: all instances share the same protection state
 */

// Note: spawn imported for potential future use with child process tracking
import * as fs from 'node:fs/promises';
// Note: fsSync imported for potential future use with synchronous file operations
import * as os from 'node:os';
import * as path from 'node:path';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import { getProcessRegistry, type ProcessRegistryImpl } from './process-registry.js';
import type { PersistentProcessEntry } from './process-registry-lock.js';
import {
  acquireLock,
  isNodeError,
  readRegistryFile,
  registryEntryKey,
  writeRegistryFile,
} from './process-registry-lock.js';

export type { PersistentProcessEntry, PersistentRegistryData } from './process-registry-lock.js';
export { acquireLock, registryEntryKey } from './process-registry-lock.js';

const REGISTRY_FILE = 'process-registry.json';

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when an entry describes a process on this host. A legacy entry written
 * before hostnames were stored has none and is treated as local.
 *
 * PIDs are host-local: on a shared home directory (NFS, roaming profile) every
 * machine writes the same registry file, so a consumer that reasons about
 * *this* process table (kill protection, name matching) must ask this first.
 */
export function isEntryFromThisHost(entry: PersistentProcessEntry): boolean {
  return !entry.hostname || entry.hostname === os.hostname();
}

function emitStructuredLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  message: string,
  error?: unknown,
): void {
  const payload: {
    level: 'debug' | 'info' | 'warn' | 'error';
    event: string;
    message: string;
    error?: string;
    timestamp: string;
  } = {
    level,
    event,
    message,
    timestamp: new Date().toISOString(),
  };

  if (error !== undefined) {
    payload.error = toErrorMessage(error);
  }

  console.log(JSON.stringify(payload));
}
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_THRESHOLD_MS = 30_000;
const LOCKFILE = '.process-registry.lock';

/**
 * Generate a unique instance ID for this WrongStack process.
 * Combines hostname + pid + random suffix for uniqueness across restarts.
 */
function generateInstanceId(): string {
  const hostname = os.hostname();
  const pid = process.pid;
  const random = Math.random().toString(36).slice(2, 8);
  return `${hostname}:${pid}:${random}`;
}

/**
 * PersistentProcessRegistry wraps the in-memory ProcessRegistryImpl and
 * synchronizes entries to a filesystem-backed store for cross-instance coordination.
 */
export class PersistentProcessRegistry {
  private readonly instanceId: string;
  private readonly registryPath: string;
  private readonly lockPath: string;
  private readonly baseRegistry: ProcessRegistryImpl;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatRunning = false;
  private cleanupRunning = false;
  private isShuttingDown = false;
  private readonly onProcessExit = (): void => {
    this.runInBackground(
      this.syncToPersistent(),
      'process_registry.exit_sync_failed',
      'PersistentProcessRegistry: exit sync failed',
    );
  };

  constructor(baseRegistry?: ProcessRegistryImpl) {
    this.instanceId = generateInstanceId();
    const globalRoot = wstackGlobalRoot();
    this.registryPath = path.join(globalRoot, REGISTRY_FILE);
    this.lockPath = path.join(globalRoot, LOCKFILE);
    this.baseRegistry = baseRegistry ?? getProcessRegistry();

    // Ensure the .wrongstack directory exists
    this.ensureDirectory().catch((err) => {
      emitStructuredLog(
        'warn',
        'process_registry.dir_create_failed',
        'PersistentProcessRegistry: failed to create .wrongstack directory',
        err,
      );
    });
  }

  private async ensureDirectory(): Promise<void> {
    const dir = path.dirname(this.registryPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'EEXIST') throw err;
    }
  }

  private runInBackground(operation: Promise<void>, event: string, message: string): void {
    void operation.catch((err) => {
      emitStructuredLog('warn', event, message, err);
    });
  }

  /**
   * Start the heartbeat and periodic cleanup tasks.
   */
  start(): void {
    if (this.heartbeatInterval) return;
    this.isShuttingDown = false;

    // Register this instance's processes with the persistent registry
    this.heartbeat();

    // Heartbeat every 5 seconds to mark entries as alive
    this.heartbeatInterval = setInterval(() => {
      this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatInterval.unref?.();

    // Cleanup stale entries every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, STALE_THRESHOLD_MS);
    this.cleanupInterval.unref?.();

    // Register main process on startup
    this.registerMainProcess();

    // Sync on significant events
    process.on('exit', this.onProcessExit);
  }

  /**
   * Stop the heartbeat and clean up.
   */
  stop(): void {
    this.isShuttingDown = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    process.off('exit', this.onProcessExit);
    this.runInBackground(
      this.syncToPersistent(),
      'process_registry.stop_sync_failed',
      'PersistentProcessRegistry: stop sync failed',
    );
  }

  /**
   * Register the main WrongStack process as protected.
   */
  registerMainProcess(): void {
    const mainPid = process.pid;

    this.runInBackground(
      this.updatePersistentEntry({
        pid: mainPid,
        name: 'wrongstack-main',
        command: process.argv.slice(0, 3).join(' '),
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
        instanceId: this.instanceId,
        hostname: os.hostname(),
        protected: true,
        spawnMode: 'main',
        parentPid: process.ppid,
        platform: process.platform,
      }),
      'process_registry.main_register_failed',
      'PersistentProcessRegistry: failed to register main process',
    );
  }

  /**
   * Register a spawned child process with the persistent registry.
   */
  registerChildProcess(
    pid: number,
    name: string,
    command: string,
    sessionId?: string,
    spawnMode: 'spawn' | 'fork' = 'spawn',
  ): void {
    const entry: PersistentProcessEntry = {
      pid,
      name,
      command,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      instanceId: this.instanceId,
      hostname: os.hostname(),
      protected: true, // All WrongStack child processes are protected by default
      spawnMode,
      parentPid: process.pid,
      platform: process.platform,
    };
    if (sessionId) {
      entry.sessionId = sessionId;
    }
    this.runInBackground(
      this.updatePersistentEntry(entry),
      'process_registry.child_register_failed',
      'PersistentProcessRegistry: failed to register child process',
    );
  }

  /**
   * Update or add an entry in the persistent registry.
   */
  private async updatePersistentEntry(entry: PersistentProcessEntry): Promise<void> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);

      // Update or insert. The host+PID key keeps a same-numbered process on
      // another machine (shared home directory) from replacing this entry.
      data.instances.set(registryEntryKey(entry.hostname, entry.pid), entry);

      // Also update the in-memory registry. `child: null` is the documented
      // shape for cross-instance mirror entries (no live handle here) — the
      // base registry's lookup/kill/staleness paths all tolerate it.
      this.baseRegistry.register({
        pid: entry.pid,
        name: entry.name,
        command: entry.command,
        startedAt: entry.startedAt,
        sessionId: entry.sessionId,
        protected: entry.protected,
        child: null,
      });

      await writeRegistryFile(this.registryPath, data);
    } finally {
      await release();
    }
  }

  /**
   * Unregister a process from the persistent registry.
   */
  async unregister(pid: number): Promise<void> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      data.instances.delete(registryEntryKey(os.hostname(), pid));
      await writeRegistryFile(this.registryPath, data);
    } finally {
      await release();
    }
  }

  /**
   * Send heartbeat to mark all this instance's processes as alive.
   */
  private heartbeat(): void {
    if (this.isShuttingDown || this.heartbeatRunning) return;

    this.heartbeatRunning = true;
    void this.syncToPersistent()
      .catch((err) => {
        emitStructuredLog(
          'warn',
          'process_registry.heartbeat_failed',
          'PersistentProcessRegistry: heartbeat failed',
          err,
        );
      })
      .finally(() => {
        this.heartbeatRunning = false;
      });
  }

  private cleanup(): void {
    if (this.isShuttingDown || this.cleanupRunning) return;

    this.cleanupRunning = true;
    void this.cleanupStaleEntries()
      .catch((err) => {
        emitStructuredLog(
          'warn',
          'process_registry.periodic_cleanup_failed',
          'PersistentProcessRegistry: periodic cleanup failed',
          err,
        );
      })
      .finally(() => {
        this.cleanupRunning = false;
      });
  }

  /**
   * Sync this instance's processes to the persistent registry.
   */
  private async syncToPersistent(): Promise<void> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      const now = Date.now();

      // Update heartbeat for all processes belonging to this instance
      const updatedInstances = new Map<string, PersistentProcessEntry>();

      for (const [_pidStr, entry] of data.instances) {
        if (entry.instanceId === this.instanceId) {
          entry.lastHeartbeat = now;
        }
        // Only keep non-stale entries (or entries from this instance)
        if (
          entry.instanceId === this.instanceId ||
          now - entry.lastHeartbeat < STALE_THRESHOLD_MS
        ) {
          updatedInstances.set(_pidStr, entry);
        }
      }

      data.instances = updatedInstances;
      data.lastCleanup = now;
      await writeRegistryFile(this.registryPath, data);
    } catch (err) {
      emitStructuredLog(
        'warn',
        'process_registry.sync_failed',
        'PersistentProcessRegistry: sync failed',
        err,
      );
    } finally {
      await release();
    }
  }

  /**
   * Remove entries for processes that are no longer running.
   */
  private async cleanupStaleEntries(): Promise<void> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      const now = Date.now();
      const stalePids: string[] = [];

      for (const [_pidStr, entry] of data.instances) {
        const age = now - entry.lastHeartbeat;

        if (age > STALE_THRESHOLD_MS) {
          // A foreign entry's PID says nothing about this host's process table:
          // checking it locally either spares an unrelated process or removes a
          // live remote entry. Its heartbeat age is the only signal we have.
          if (!isEntryFromThisHost(entry)) {
            stalePids.push(_pidStr);
            continue;
          }
          // Check if process is actually dead
          try {
            if (process.platform !== 'win32') {
              process.kill(entry.pid, 0);
            } else {
              // On Windows, try to open the process
              emitStructuredLog(
                'debug',
                'process_registry.stale_pid_check',
                `PersistentProcessRegistry: checking stale pid ${entry.pid} (${age}ms old)`,
              );
            }
          } catch {
            // Process is dead - mark for removal
            stalePids.push(_pidStr);
          }
        }
      }

      if (stalePids.length > 0) {
        for (const pidStr of stalePids) {
          data.instances.delete(pidStr);
        }
        await writeRegistryFile(this.registryPath, data);
      }
    } catch (err) {
      emitStructuredLog(
        'warn',
        'process_registry.cleanup_failed',
        'PersistentProcessRegistry: cleanup failed',
        err,
      );
    } finally {
      await release();
    }
  }

  /**
   * Check if a PID belongs to a WrongStack process and should be protected.
   */
  async isProtectedPid(pid: number): Promise<boolean> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      const entry = data.instances.get(registryEntryKey(os.hostname(), pid));

      if (!entry) return false;

      // Check if stale
      if (Date.now() - entry.lastHeartbeat > STALE_THRESHOLD_MS) {
        return false;
      }

      return entry.protected;
    } finally {
      await release();
    }
  }

  /**
   * Get all protected PIDs from all WrongStack instances.
   */
  async getAllProtectedPids(): Promise<number[]> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      const now = Date.now();
      const protectedPids: number[] = [];

      for (const [_pidStr, entry] of data.instances) {
        if (!isEntryFromThisHost(entry)) continue;
        if (entry.protected && now - entry.lastHeartbeat < STALE_THRESHOLD_MS) {
          protectedPids.push(entry.pid);
        }
      }

      return protectedPids;
    } finally {
      await release();
    }
  }

  /**
   * Get complete status of all tracked processes across all instances.
   */
  async getGlobalStatus(): Promise<{
    instances: Map<string, PersistentProcessEntry[]>;
    totalProcesses: number;
    protectedCount: number;
    staleCount: number;
  }> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      const now = Date.now();
      const instances = new Map<string, PersistentProcessEntry[]>();
      let protectedCount = 0;
      let staleCount = 0;

      for (const [_pidStr, entry] of data.instances) {
        const instanceEntries = instances.get(entry.instanceId) ?? [];
        instanceEntries.push(entry);
        instances.set(entry.instanceId, instanceEntries);

        if (entry.protected) protectedCount++;
        if (now - entry.lastHeartbeat > STALE_THRESHOLD_MS) staleCount++;
      }

      return {
        instances,
        totalProcesses: data.instances.size,
        protectedCount,
        staleCount,
      };
    } finally {
      await release();
    }
  }

  /**
   * Get the instance ID for this process.
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Check if a kill command should be blocked.
   * Returns true if the kill should be blocked (target is a WrongStack process).
   */
  async shouldBlockKill(pid: number): Promise<boolean> {
    const protectedPids = await this.getAllProtectedPids();
    return protectedPids.includes(pid);
  }

  /**
   * Add a pattern-based protection rule.
   * Processes whose command matches any protected pattern are protected.
   */
  async addProtectedPattern(pattern: string): Promise<void> {
    const release = await acquireLock(this.lockPath);
    try {
      const data = await readRegistryFile(this.registryPath);
      if (!data.protectedPatterns.includes(pattern)) {
        data.protectedPatterns.push(pattern);
        await writeRegistryFile(this.registryPath, data);
      }
    } finally {
      await release();
    }
  }
}

// Singleton instance
let _persistentRegistry: PersistentProcessRegistry | undefined;

export function getPersistentProcessRegistry(): PersistentProcessRegistry {
  if (!_persistentRegistry) {
    _persistentRegistry = new PersistentProcessRegistry();
  }
  return _persistentRegistry;
}

export function resetPersistentProcessRegistry(): void {
  if (_persistentRegistry) {
    _persistentRegistry.stop();
    _persistentRegistry = undefined;
  }
}
