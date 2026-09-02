/**
 * MailboxHealthWatchdog — probes the mailbox HTTP bridge and posts a
 * status message when it goes down.
 *
 * Designed to be embedded inside the WrongStack REPL/TUI/WebUI process —
 * NOT a standalone agent. WrongStack has its own cross-agent
 * coordination channel, so the cheapest reliable signal is "ask the
 * bridge if it's alive, and if it's not, tell the rest of the team
 * via the same channel the bridge exposes."
 *
 * Usage:
 *
 *   const mailbox = getSharedProjectMailbox(projectDir);
 *   const watchdog = new MailboxHealthWatchdog({
 *     mailbox,
 *     url: 'http://127.0.0.1:7788',
 *     probeIntervalMs: 15_000,
 *     onAlert: (event) => console.warn(event),
 *   });
 *   await watchdog.start();
 *   // ...later...
 *   await watchdog.stop();
 *
 * The watchdog is a passive observer: it does NOT start the bridge.
 * Starting the bridge is the user's job (`wstack mailbox serve` or
 * `/mailbox-serve`). The watchdog then reports on what the user did.
 *
 * ## Scope: the HTTP bridge, NOT the project mailbox owner
 *
 * Do not reach for this to check whether the mailbox is up. The two processes
 * are unrelated:
 *
 * - The **project mailbox owner** (`mailbox-project-server.ts`) is required
 *   and self-healing — clients spawn it on demand and it idles out after five
 *   minutes. Its liveness is `MailboxProjectServerConnection.probeStatus()`,
 *   which is what the TUI/WebUI connections-health surfaces call.
 * - The **HTTP bridge** this watchdog probes is an optional façade that exists
 *   so EXTERNAL agents can reach the mailbox over HTTP. Since 2026-08-07 its
 *   feature gate (`features.mailboxBridge`) defaults to `'off'`, so on a
 *   default install there is nothing here to watch — which is why this class
 *   has no production caller. It stays exported for operators who turn the
 *   bridge on; construct it only alongside a bridge you actually started.
 */

import type { Mailbox, MailboxSendInput } from './mailbox-types.js';

export interface MailboxHealthWatchdogOptions {
  /** Project mailbox to probe-and-report on. Required. */
  mailbox: Mailbox;
  /** URL of the mailbox bridge (no trailing slash). Required. */
  url: string;
  /** Probe interval in milliseconds. Default: 15_000. */
  probeIntervalMs?: number;
  /** Per-probe timeout in milliseconds. Default: 3_000. */
  probeTimeoutMs?: number;
  /**
   * After this many consecutive failures the watchdog posts an alert.
   * Default: 2 (so a single transient timeout doesn't trigger spam).
   */
  failureThreshold?: number;
  /**
   * Optional callback for local observability — fired on every state
   * transition. The mailbox post is independent of this callback.
   */
  onAlert?: ((event: MailboxHealthEvent) => void) | undefined;
  /**
   * Agent id used to post the alert message. Default: 'mailbox-bridge-watchdog'.
   */
  from?: string;
}

export type MailboxHealthEvent =
  | { kind: 'probe-failed'; status?: number; error?: string }
  | { kind: 'alert-posted'; consecutiveFailures: number }
  | { kind: 'recovery-posted'; downtimeMs: number }
  | { kind: 'started'; intervalMs: number }
  | { kind: 'stopped' };

export const MAILBOX_HEALTH_DEFAULT_INTERVAL_MS = 15_000;
export const MAILBOX_HEALTH_DEFAULT_TIMEOUT_MS = 3_000;
export const MAILBOX_HEALTH_DEFAULT_FAILURE_THRESHOLD = 2;
export const MAILBOX_HEALTH_DEFAULT_FROM = 'mailbox-bridge-watchdog';

export class MailboxHealthWatchdog {
  private readonly mailbox: Mailbox;
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private readonly from: string;
  private readonly onAlert?: ((event: MailboxHealthEvent) => void) | undefined;

  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private downSince: number | null = null;
  private alerting = false;
  private inFlight = false;
  private aborted = false;

  constructor(opts: MailboxHealthWatchdogOptions) {
    this.mailbox = opts.mailbox;
    this.url = opts.url.replace(/\/$/, '');
    this.intervalMs = opts.probeIntervalMs ?? MAILBOX_HEALTH_DEFAULT_INTERVAL_MS;
    this.timeoutMs = opts.probeTimeoutMs ?? MAILBOX_HEALTH_DEFAULT_TIMEOUT_MS;
    this.failureThreshold = opts.failureThreshold ?? MAILBOX_HEALTH_DEFAULT_FAILURE_THRESHOLD;
    this.from = opts.from ?? MAILBOX_HEALTH_DEFAULT_FROM;
    this.onAlert = opts.onAlert;
    validateWatchdogOptions({
      probeIntervalMs: this.intervalMs,
      probeTimeoutMs: this.timeoutMs,
      failureThreshold: this.failureThreshold,
    });
  }

  /** Start probing on `intervalMs`. Idempotent — second call is a no-op. */
  async start(): Promise<void> {
    if (this.timer !== null || this.aborted) return;
    this.aborted = false;
    this.emit({ kind: 'started', intervalMs: this.intervalMs });
    // First probe immediately so the operator sees a baseline within
    // `timeoutMs` instead of waiting `intervalMs` for the first tick.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Don't keep the event loop alive solely for this timer.
    this.timer.unref?.();
  }

  /** Stop probing. Safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.emit({ kind: 'stopped' });
    this.aborted = true;
  }

  /** True between start() and stop(). */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Number of consecutive failed probes since the last successful probe. */
  get currentFailureStreak(): number {
    return this.consecutiveFailures;
  }

  /** True iff the watchdog currently considers the bridge down. */
  isBridgeDown(): boolean {
    return this.downSince !== null;
  }

  private emit(event: MailboxHealthEvent): void {
    try {
      this.onAlert?.(event);
    } catch {
      /* observer must not crash us */
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return; // skip if previous probe still running
    this.inFlight = true;
    try {
      const ok = await this.probe();
      if (ok) {
        this.recordSuccess();
      } else {
        this.recordFailure({ kind: 'probe-failed' });
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async probe(): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/healthz`, {
        signal: ctrl.signal,
        // Don't follow redirects — they could mask the bridge being down.
        redirect: 'manual',
      });
      clearTimeout(timer);
      // 2xx = healthy. Anything else (3xx redirect, 4xx/5xx, etc.) = down.
      return res.ok;
    } catch (err) {
      clearTimeout(timer);
      this.emit({ kind: 'probe-failed', error: (err as Error).message });
      return false;
    }
  }

  private recordSuccess(): void {
    if (this.downSince !== null && this.alerting) {
      // Was down — emit recovery.
      const downtimeMs = Date.now() - this.downSince;
      this.downSince = null;
      this.consecutiveFailures = 0;
      this.alerting = false;
      this.emit({ kind: 'recovery-posted', downtimeMs });
      void this.postRecovery(downtimeMs).catch(() => {
        /* post is best-effort */
      });
    } else {
      this.consecutiveFailures = 0;
      this.downSince = null;
      this.alerting = false;
    }
  }

  private recordFailure(event: MailboxHealthEvent): void {
    this.consecutiveFailures += 1;
    this.emit(event);
    if (this.downSince === null) this.downSince = Date.now();
    if (this.consecutiveFailures >= this.failureThreshold && !this.alerting) {
      this.alerting = true;
      this.emit({ kind: 'alert-posted', consecutiveFailures: this.consecutiveFailures });
      void this.postDown().catch(() => {
        /* post is best-effort */
      });
    }
  }

  private async postDown(): Promise<void> {
    await this.mailbox.send(
      buildDownAlert({
        from: this.from,
        url: this.url,
        consecutiveFailures: this.consecutiveFailures,
      }),
    );
  }

  private async postRecovery(downtimeMs: number): Promise<void> {
    await this.mailbox.send(
      buildRecoveryAlert({
        from: this.from,
        url: this.url,
        downtimeMs,
        consecutiveFailures: this.consecutiveFailures,
      }),
    );
  }
}

// ── Pure builders ─────────────────────────────────────────────────────────
//
// Exported so snapshot tests can pin the exact subject + body an
// external dashboard or alert consumer parses. Changing this string
// is a breaking change for downstream tooling — run the snapshot test
// first, update consumers, then commit.

export interface DownAlertInput {
  from: string;
  url: string;
  consecutiveFailures: number;
}

export function buildDownAlert(input: DownAlertInput): MailboxSendInput {
  return {
    from: input.from,
    to: '*',
    type: 'status',
    subject: 'mailbox-bridge-down: HTTP /healthz not responding',
    body: [
      `The mailbox HTTP bridge at ${input.url} failed ${input.consecutiveFailures} consecutive /healthz probes.`,
      '',
      'Consequences:',
      '- External agents (Claude Code, Aider, scripts) cannot read or send messages.',
      '- WrongStack-internal agents continue to work — they reach the project mailbox over IPC, not the HTTP bridge.',
      '',
      'Likely causes:',
      '- The `wstack mailbox serve` (or `/mailbox-serve` slash command) process exited.',
      '- The bridge was killed or restarted on a different port.',
      '- Loopback network issue.',
      '',
      'Fix: re-run `wstack mailbox serve` (or `/mailbox-serve` in REPL).',
    ].join('\n'),
    priority: 'high',
  };
}

export interface RecoveryAlertInput {
  from: string;
  url: string;
  downtimeMs: number;
  consecutiveFailures: number;
}

export function buildRecoveryAlert(input: RecoveryAlertInput): MailboxSendInput {
  const downtimeSec = Math.round(input.downtimeMs / 1000);
  return {
    from: input.from,
    to: '*',
    type: 'status',
    subject: `mailbox-bridge-up: recovered after ${downtimeSec}s`,
    body: [
      `The mailbox HTTP bridge at ${input.url} is responding to /healthz again.`,
      '',
      `Downtime: ${downtimeSec}s`,
      `Consecutive failures before recovery: ${input.consecutiveFailures}.`,
      '',
      'External agents can resume mailbox traffic.',
    ].join('\n'),
    priority: 'normal',
  };
}

// ── Config validation ─────────────────────────────────────────────────────

export interface WatchdogConfig {
  probeIntervalMs: number;
  probeTimeoutMs: number;
  failureThreshold: number;
}

/**
 * Throws if the watchdog config is invalid. Called from the
 * MailboxHealthWatchdog constructor so misconfiguration fails fast
 * (at startup), not silently after the first probe.
 */
export function validateWatchdogOptions(cfg: WatchdogConfig): void {
  if (!Number.isFinite(cfg.probeIntervalMs) || cfg.probeIntervalMs <= 0) {
    throw new RangeError(
      `MailboxHealthWatchdog: probeIntervalMs must be a positive finite number, got ${cfg.probeIntervalMs}`,
    );
  }
  if (!Number.isFinite(cfg.probeTimeoutMs) || cfg.probeTimeoutMs <= 0) {
    throw new RangeError(
      `MailboxHealthWatchdog: probeTimeoutMs must be a positive finite number, got ${cfg.probeTimeoutMs}`,
    );
  }
  if (cfg.probeTimeoutMs >= cfg.probeIntervalMs) {
    throw new RangeError(
      `MailboxHealthWatchdog: probeTimeoutMs (${cfg.probeTimeoutMs}) must be less than probeIntervalMs (${cfg.probeIntervalMs}) — otherwise the watchdog races against itself`,
    );
  }
  if (!Number.isInteger(cfg.failureThreshold) || cfg.failureThreshold < 1) {
    throw new RangeError(
      `MailboxHealthWatchdog: failureThreshold must be a positive integer, got ${cfg.failureThreshold}`,
    );
  }
}
