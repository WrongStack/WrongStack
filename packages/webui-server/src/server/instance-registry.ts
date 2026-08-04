/**
 * Running-instance registry for the standalone WebUI server.
 *
 * Every live `wstack --webui` process records itself in a single JSON file under the
 * wstack home dir (`~/.wrongstack/webui-instances.json`) so a user running
 * several instances (one per project, or several per project on different
 * ports) can see at a glance which ports are open for which path.
 *
 * Design notes:
 * - **Self-healing**: every register/unregister/list prunes entries whose PID
 *   is no longer alive (`process.kill(pid, 0)`), so a crashed instance that
 *   never got to unregister doesn't leave a ghost behind.
 * - **Atomic writes**: the file is rewritten via `atomicWrite` (tmp + rename),
 *   so a concurrent reader never sees a half-written file. Two instances
 *   starting at the *exact* same millisecond could still race the
 *   read-modify-write — acceptable for a best-effort tracking file, and the
 *   next register() heals any dropped entry.
 * - **Best-effort**: a failure to read/write the registry must NEVER take the
 *   server down. Callers wrap these in `.catch()`.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { atomicWrite } from '@wrongstack/core/utils';

/** One running WebUI / SimpleUI process. */
export interface WebUIInstanceRecord {
  /** OS process id — also the liveness key. */
  pid: number;
  /** Surface kind — 'webui' or 'simpleui'. */
  surface: 'webui' | 'simpleui';
  /** Port serving both HTTP and WebSocket. */
  httpPort: number;
  /** Bind host (e.g. 127.0.0.1 or 0.0.0.0). */
  host: string;
  /** Absolute project root the instance booted against. */
  projectRoot: string;
  /** Display name (basename of projectRoot). */
  projectName: string;
  /** ISO timestamp when the instance registered. */
  startedAt: string;
  /** Convenience open-in-browser URL. */
  url: string;
  /**
   * Access token for this instance's HTTP API, so a same-project sibling
   * process (TUI/REPL) can authenticate the `POST /api/fleet/ping`
   * push-on-write nudge.
   *
   * Security scan 2026-08-04, finding H3: the API used to require no
   * credential at all on a loopback bind. Closing that meant the one
   * legitimate non-browser caller needed a way to obtain the token, and this
   * registry — already `0o600`, already read by exactly those siblings — is
   * where it belongs.
   *
   * Be precise about what this is worth. Storing the token here raises the bar
   * against a *different-user* or sandboxed local process, which cannot read
   * the file. It does nothing against a process running as the same user: that
   * process can read this file, and could read `~/.wrongstack/projects/*` —
   * the very transcripts the API exposes — without going near the API at all.
   * The same reasoning already applies to HQ's `auth.json`.
   *
   * Optional so an older record (or a surface that has no token) still parses.
   */
  authToken?: string | undefined;
}

interface RegistryFile {
  version: 1;
  instances: WebUIInstanceRecord[];
}

/** Default wstack home dir (`~/.wrongstack`). Callers may override the base. */
export function defaultBaseDir(): string {
  return path.join(os.homedir(), '.wrongstack');
}

/** Resolve the registry file path for a given base dir. */
export function registryPath(baseDir: string = defaultBaseDir()): string {
  return path.join(baseDir, 'webui-instances.json');
}

/**
 * Liveness probe. `process.kill(pid, 0)` sends no signal — it only checks the
 * process exists. ESRCH ⇒ dead; EPERM ⇒ alive but owned by another user (still
 * counts as alive). Any other error is treated conservatively as "alive" so we
 * never prune an instance we simply failed to probe.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function load(file: string): Promise<RegistryFile> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as RegistryFile;
    if (parsed?.version === 1 && Array.isArray(parsed.instances)) {
      return parsed;
    }
  } catch {
    // Missing or corrupt → start fresh.
  }
  return { version: 1, instances: [] };
}

async function save(file: string, instances: WebUIInstanceRecord[]): Promise<void> {
  await atomicWrite(file, `${JSON.stringify({ version: 1, instances }, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Drop dead processes and (optionally) one specific pid. */
function prune(instances: WebUIInstanceRecord[], excludePid?: number): WebUIInstanceRecord[] {
  return instances.filter((i) => i.pid !== excludePid && isPidAlive(i.pid));
}

/**
 * Register (or refresh) this instance. Prunes dead entries and any stale entry
 * for our own PID before adding the current record. Best-effort — rejects only
 * on a hard fs error, which callers swallow.
 */
export async function registerInstance(
  record: WebUIInstanceRecord,
  baseDir: string = defaultBaseDir(),
): Promise<void> {
  const file = registryPath(baseDir);
  const data = await load(file);
  const instances = prune(data.instances, record.pid);
  instances.push(record);
  await save(file, instances);
}

/** Remove this instance (called on graceful shutdown). Also prunes dead pids. */
export async function unregisterInstance(
  pid: number,
  baseDir: string = defaultBaseDir(),
): Promise<void> {
  const file = registryPath(baseDir);
  const data = await load(file);
  const instances = prune(data.instances, pid);
  await save(file, instances);
}

/** List live instances, pruning any dead entries encountered. */
export async function listInstances(
  baseDir: string = defaultBaseDir(),
): Promise<WebUIInstanceRecord[]> {
  const file = registryPath(baseDir);
  const data = await load(file);
  const live = prune(data.instances);
  // Persist the pruned view so `cat`-ing the file also shows reality, but never
  // fail the list on a write error.
  if (live.length !== data.instances.length) {
    await save(file, live).catch(() => {});
  }
  return live;
}

/** Human-readable table of running instances for `wstack --webui --list`. */
export function formatInstances(instances: WebUIInstanceRecord[]): string {
  if (instances.length === 0) {
    return 'No WebUI instances are currently running.';
  }
  const lines = [`Running WebUI instances (${instances.length}):`, ''];
  for (const i of instances) {
    lines.push(
      `  • ${i.url}  ·  pid ${i.pid}`,
      `      project: ${i.projectName}  (${i.projectRoot})`,
      `      since:   ${i.startedAt}`,
    );
  }
  return lines.join('\n');
}
