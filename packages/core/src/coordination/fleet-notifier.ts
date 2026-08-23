/**
 * FleetNotifier — push-on-write nudge to local WebUI servers.
 *
 * The cross-process source of truth is the file-based SessionRegistry, which
 * every WebUI server already watches (`fs.watch`, ~150ms) and polls (5s). This
 * notifier is a best-effort *latency* optimisation on top: after a process
 * writes its session/agent status to the registry, it sends a tiny
 * fire-and-forget `POST /api/fleet/ping` to every WebUI running against the
 * same project (discovered from `~/.wrongstack/webui-instances.json`). The
 * WebUI responds by re-broadcasting the (already-fresh) registry immediately —
 * so a TUI/REPL agent's activity reaches the Fleet HQ map in ~milliseconds
 * instead of waiting on the watch/poll.
 *
 * Design notes:
 * - **Never the source of truth.** If no WebUI is running, the file system +
 *   watch/poll still carry everything. Every failure here is swallowed.
 * - **Coalesced.** Bursts of events (tool calls, deltas) collapse into one POST
 *   per ~50ms so we never hammer the WebUI per token.
 * - **Discovery cached** for a couple seconds to avoid a disk read per event.
 * - **Loopback only / self-excluded.** Targets the local instances file; a
 *   `0.0.0.0`/`::` bind is dialled on `127.0.0.1`, and the caller's own pid is
 *   skipped so a WebUI never pings itself.
 *
 * @module fleet-notifier
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPidAlive } from '../utils/pid.js';

const INSTANCES_FILE = 'webui-instances.json';
const DISCOVERY_TTL_MS = 2_500;
const COALESCE_MS = 50;
const POST_TIMEOUT_MS = 500;

interface InstanceRecordLike {
  pid: number;
  httpPort: number;
  host: string;
  projectRoot: string;
  /**
   * The target instance's API token, recorded in the registry so this
   * non-browser caller can authenticate (H3). Optional: an older record, or an
   * instance that never wrote one, simply gets an unauthenticated POST — which
   * the target will reject. That is the correct failure mode for a
   * best-effort latency optimisation; the registry watch/poll still carries
   * everything.
   */
  authToken?: string;
}

/** A ping target: where to POST, and the token that authenticates it. */
interface PingTarget {
  url: string;
  token?: string | undefined;
}

/** Shared probe — see utils/pid.ts. */
const pidAlive = isPidAlive;

/** Normalise a project root for cross-process comparison (case-insensitive on Windows). */
function normRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export interface FleetNotifierOptions {
  /** WrongStack global dir (`~/.wrongstack`) holding `webui-instances.json`. */
  baseDir: string;
  /** This process's project root — only WebUIs on the same project are pinged. */
  projectRoot: string;
  /** This process's pid, so a WebUI never pings itself. */
  selfPid?: number | undefined;
  /**
   * Injectable POST for tests. Defaults to a timed `fetch`.
   *
   * The second parameter carries the target's API token (H3). It is optional
   * so an existing `(url) => …` stub stays assignable.
   */
  post?: ((url: string, token?: string | undefined) => Promise<void>) | undefined;
}

export class FleetNotifier {
  private readonly baseDir: string;
  private projectRoot: string;
  private readonly selfPid: number;
  private readonly doPost: (url: string, token?: string | undefined) => Promise<void>;

  private cache: { at: number; targets: PingTarget[] } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: FleetNotifierOptions) {
    this.baseDir = opts.baseDir;
    this.projectRoot = normRoot(opts.projectRoot);
    this.selfPid = opts.selfPid ?? process.pid;
    this.doPost = opts.post ?? defaultPost;
  }

  /** Coalesced, best-effort nudge. Safe to call on every status change. */
  notify(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, COALESCE_MS);
    /* v8 ignore next -- timer.unref is always a function on Node Timeout objects */
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Resolve same-project WebUI ping URLs (cached briefly). Exposed for tests. */
  async endpoints(): Promise<string[]> {
    return (await this.targets()).map((t) => t.url);
  }

  /** Ping targets with their tokens (cached briefly). */
  private async targets(): Promise<PingTarget[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < DISCOVERY_TTL_MS) return this.cache.targets;
    const targets = await this.discover();
    this.cache = { at: now, targets };
    return targets;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Re-scope notifications after an in-process project switch. */
  setProjectRoot(projectRoot: string): void {
    this.projectRoot = normRoot(projectRoot);
    this.cache = null;
  }

  private async flush(): Promise<void> {
    const targets = await this.targets();
    await Promise.all(targets.map((t) => this.doPost(t.url, t.token).catch(() => undefined)));
  }

  private async discover(): Promise<PingTarget[]> {
    try {
      const raw = await fs.readFile(path.join(this.baseDir, INSTANCES_FILE), 'utf8');
      const data = JSON.parse(raw) as { instances?: InstanceRecordLike[] };
      const list = Array.isArray(data?.instances) ? data.instances : [];
      return list
        .filter((i) => i && typeof i.httpPort === 'number')
        .filter((i) => i.pid !== this.selfPid)
        .filter((i) => normRoot(i.projectRoot) === this.projectRoot)
        .filter((i) => pidAlive(i.pid))
        .map((i) => {
          const host = i.host === '0.0.0.0' || i.host === '::' || !i.host ? '127.0.0.1' : i.host;
          return {
            url: `http://${host}:${i.httpPort}/api/fleet/ping`,
            token: typeof i.authToken === 'string' ? i.authToken : undefined,
          };
        });
    } catch {
      // Missing/corrupt instances file → no WebUIs to notify.
      return [];
    }
  }
}

async function defaultPost(url: string, token?: string | undefined): Promise<void> {
  await fetch(url, {
    method: 'POST',
    // The API requires a token on every bind (H3). Sent as a header rather
    // than a query param so it never lands in an access log or the URL.
    ...(token ? { headers: { 'x-ws-token': token } } : {}),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
}
