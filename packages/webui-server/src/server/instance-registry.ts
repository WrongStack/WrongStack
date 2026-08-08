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

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionRegistryEntry, SessionLiveStatus } from '@wrongstack/core/storage';
import { atomicWrite } from '@wrongstack/core/utils';

export type WebUIInstanceRole = 'standalone' | 'parent-shell' | 'session-child';

export interface WebUIInstanceAuthInfo {
  /** How a same-user parent/sibling process can authenticate to this endpoint. */
  scheme: 'registry-token' | 'cookie-bootstrap' | 'none';
  /** Whether the record has a usable token in `authToken`. */
  tokenPresent: boolean;
}

/** One running WebUI / SimpleUI process. */
export interface WebUIInstanceRecord {
  /** OS process id — also the liveness key. */
  pid: number;
  /** Surface kind — 'webui' or 'simpleui'. Additional strings are tolerated for new surfaces. */
  surface: 'webui' | 'simpleui' | string;
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
  /** Runtime role. Missing means the legacy standalone WebUI/SimpleUI role. */
  role?: WebUIInstanceRole | undefined;
  /** Live session owned by this endpoint when `role === 'session-child'`. */
  sessionId?: string | undefined;
  /** Parent shell process identity, when this endpoint was spawned by a parent. */
  parentPid?: number | undefined;
  parentShellId?: string | undefined;
  /** Stable child runtime id, distinct from the session id. */
  runtimeId?: string | undefined;
  /** Whether a parent shell should treat this endpoint as attachable. */
  attachable?: boolean | undefined;
  /** Descriptive auth metadata; the same-user token remains in `authToken`. */
  auth?: WebUIInstanceAuthInfo | undefined;
  /** Health/protocol hints for future parent shells. */
  lastReadyAt?: string | undefined;
  protocolVersion?: number | undefined;
  capabilities?: string[] | undefined;
}

interface RegistryFile {
  version: 1;
  instances: WebUIInstanceRecord[];
}

export interface WebUISessionAttachEndpoint {
  host: string;
  httpPort: number;
  url: string;
  authToken?: string | undefined;
}

export type WebUISessionAttachDegradedReason =
  | 'live-session-no-webui-endpoint'
  | 'endpoint-owner-mismatch'
  | 'endpoint-missing-session-id'
  | 'endpoint-session-mismatch'
  | 'endpoint-not-session-child'
  | 'endpoint-not-attachable'
  | 'session-not-live';

export interface WebUISessionAttachCandidate {
  sessionId: string;
  projectRoot: string;
  workingDir: string;
  sessionPid: number;
  status: SessionLiveStatus;
  instance?: WebUIInstanceRecord | undefined;
  endpoint?: WebUISessionAttachEndpoint | undefined;
  attachable: boolean;
  degradedReason?: WebUISessionAttachDegradedReason | undefined;
}

function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isLiveSessionStatus(status: SessionLiveStatus): boolean {
  return status === 'active' || status === 'idle';
}

function instanceRole(instance: WebUIInstanceRecord): WebUIInstanceRole {
  return instance.role ?? 'standalone';
}

function resolveAttachability(input: {
  session: SessionRegistryEntry;
  instance?: WebUIInstanceRecord | undefined;
}): {
  attachable: boolean;
  instance?: WebUIInstanceRecord | undefined;
  endpoint?: WebUISessionAttachEndpoint | undefined;
  degradedReason?: WebUISessionAttachDegradedReason | undefined;
} {
  const { session, instance } = input;
  if (!isLiveSessionStatus(session.status)) {
    return { attachable: false, degradedReason: 'session-not-live' };
  }
  if (!instance) {
    return { attachable: false, degradedReason: 'live-session-no-webui-endpoint' };
  }
  if (instance.pid !== session.pid) {
    return { attachable: false, degradedReason: 'endpoint-owner-mismatch' };
  }
  if (!instance.sessionId) {
    return { attachable: false, instance, degradedReason: 'endpoint-missing-session-id' };
  }
  if (instance.sessionId !== session.sessionId) {
    return { attachable: false, instance, degradedReason: 'endpoint-session-mismatch' };
  }
  if (instanceRole(instance) !== 'session-child') {
    return { attachable: false, instance, degradedReason: 'endpoint-not-session-child' };
  }
  if (instance.attachable === false) {
    return { attachable: false, instance, degradedReason: 'endpoint-not-attachable' };
  }
  return {
    attachable: true,
    endpoint: {
      host: instance.host,
      httpPort: instance.httpPort,
      url: instance.url,
      ...(instance.authToken ? { authToken: instance.authToken } : {}),
    },
  };
}

export function joinSessionRegistryWithWebUIInstances(input: {
  sessions: SessionRegistryEntry[];
  instances: WebUIInstanceRecord[];
  projectRoot?: string | undefined;
  projectSlug?: string | undefined;
}): WebUISessionAttachCandidate[] {
  const targetRoot = input.projectRoot ? normalizeRoot(input.projectRoot) : undefined;
  const sessions = input.sessions.filter((session) => {
    if (input.projectSlug && session.projectSlug !== input.projectSlug) return false;
    if (targetRoot && normalizeRoot(session.projectRoot) !== targetRoot) return false;
    return true;
  });

  return sessions.map((session) => {
    const instance =
      input.instances.find((candidate) => candidate.sessionId === session.sessionId) ??
      input.instances.find(
        (candidate) =>
          candidate.pid === session.pid &&
          normalizeRoot(candidate.projectRoot) === normalizeRoot(session.projectRoot),
      );
    const resolved = resolveAttachability({ session, instance });
    return {
      sessionId: session.sessionId,
      projectRoot: session.projectRoot,
      workingDir: session.workingDir,
      sessionPid: session.pid,
      status: session.status,
      ...(instance ? { instance } : {}),
      ...(resolved.endpoint ? { endpoint: resolved.endpoint } : {}),
      attachable: resolved.attachable,
      ...(resolved.degradedReason ? { degradedReason: resolved.degradedReason } : {}),
    };
  });
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
