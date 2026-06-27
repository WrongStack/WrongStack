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
 *   const mailbox = new GlobalMailbox(projectDir);
 *   const watchdog = new MailboxHealthWatchdog({
 *     mailbox,
 *     url: 'http://127.0.0.1:7788',
 *     probeIntervalMs: 15_000,
 *     onAlert: (event) => console.warn('mailbox bridge', event.kind),
 *   });
 *   await watchdog.start();
 *   // ...later...
 *   await watchdog.stop();
 *
 * The watchdog is a passive observer: it does NOT start the bridge.
 * Starting the bridge is the user's job (`wstack mailbox serve` or
 * `/mailbox-serve`). The watchdog then reports on what the user did.
 */

import type { GlobalMailbox } from './global-mailbox.js';

export interface MailboxHealthWatchdogOptions {
  /** Project mailbox to probe-and-report on. Required. */
  mailbox: GlobalMailbox;
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
  private readonly mailbox: GlobalMailbox;
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
  }

  /** Start probing on `intervalMs`. Idempotent — second call is a no-op. */
  async start(): Promise<void> {
    if (this.timer !== null || this.aborted) return;
    this.aborted = false;
    this.emit({ kind: 'started', intervalMs: this.intervalMs });
    // First probe immediately so the operator sees a baseline within
    // `timeoutMs` instead of waiting `intervalMs` for the first tick.
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
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
    try { this.onAlert?.(event); } catch { /* observer must not crash us */ }
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
      void this.postRecovery(downtimeMs).catch(() => { /* post is best-effort */ });
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
      void this.postDown().catch(() => { /* post is best-effort */ });
    }
  }

  private async postDown(): Promise<void> {
    await this.mailbox.send({
      from: this.from,
      to: '*',
      type: 'status',
      subject: 'mailbox-bridge-down: HTTP /healthz not responding',
      body: [
        `The mailbox HTTP bridge at ${this.url} failed ${this.consecutiveFailures} consecutive /healthz probes.`,
        '',
        'Consequences:',
        '- External agents (Claude Code, Aider, scripts) cannot read or send messages.',
        '- WrongStack-internal agents continue to work — they use GlobalMailbox directly, not the HTTP bridge.',
        '',
        'Likely causes:',
        '- The `wstack mailbox serve` (or `/mailbox-serve` slash command) process exited.',
        '- The bridge was killed or restarted on a different port.',
        '- Loopback network issue.',
        '',
        'Fix: re-run `wstack mailbox serve` (or `/mailbox-serve` in REPL).',
      ].join('\n'),
      priority: 'high',
    });
  }

  private async postRecovery(downtimeMs: number): Promise<void> {
    await this.mailbox.send({
      from: this.from,
      to: '*',
      type: 'status',
      subject: `mailbox-bridge-up: recovered after ${Math.round(downtimeMs / 1000)}s`,
      body: [
        `The mailbox HTTP bridge at ${this.url} is responding to /healthz again.`,
        '',
        `Downtime: ${Math.round(downtimeMs / 1000)}s`,
        `Consecutive failures before recovery: ${this.consecutiveFailures}.`,
        '',
        'External agents can resume mailbox traffic.',
      ].join('\n'),
      priority: 'normal',
    });
  }
}