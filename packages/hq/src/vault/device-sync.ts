/**
 * Keeps an enrolled machine in step with its HQ key vault without anyone
 * pressing Sync.
 *
 * Two triggers, one action:
 *  - **push** — HQ sends `hq.vault_changed {hqId, revision}` to every
 *    connected publisher after an operator change (`notice-bus.ts`);
 *  - **poll** — a slow check of HQ's unauthenticated revision counter, for a
 *    machine whose HQ connection is off, and to catch up after downtime.
 *
 * Either one runs a signed, sealed `sync()` only when HQ's revision is above
 * the one this machine last synced (`hq-device.json`, shared by every process
 * on the machine), so a notice reaching five processes costs one fetch, not
 * five — the others see the revision already recorded. A sync rewrites the
 * profile config, and every running host already watches that file and
 * rebuilds its provider, so nothing else needs telling.
 *
 * One scheduler per process and machine (`startHqVaultBackgroundSync` keeps
 * it so): the CLI host and the WebUI host it embeds share it.
 */
import type { HqVaultChangedNotice } from '../protocol/vault.js';
import {
  type HqCredentialService,
  type HqImportReport,
  HqVaultDeviceRevokedError,
} from './device-service.js';
import { onHqVaultNotice } from './notice-bus.js';

/** How often to poll HQ's revision counter (a GET of two numbers). */
export const HQ_VAULT_POLL_INTERVAL_MS = 5 * 60_000;
/** A notice waits up to this long, so the processes it reaches do not all fetch at once. */
export const HQ_VAULT_NOTICE_JITTER_MS = 4_000;
/** The first poll after start waits this long (plus jitter): a short command exits first. */
export const HQ_VAULT_FIRST_POLL_MS = 20_000;

export interface HqVaultSyncSchedulerOptions {
  service: Pick<HqCredentialService, 'device' | 'sync' | 'revision'>;
  /** After a sync that changed something. */
  onSynced?: ((report: HqImportReport) => void) | undefined;
  /** A failed check or sync (HQ unreachable, revoked, …); never thrown. */
  warn?: ((message: string) => void) | undefined;
  pollIntervalMs?: number | undefined;
  firstPollMs?: number | undefined;
  jitterMs?: number | undefined;
  random?: (() => number) | undefined;
}

export class HqVaultSyncScheduler {
  private pending: ReturnType<typeof setTimeout> | undefined;
  private poller: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private wanted: number | undefined;
  private stopped = false;
  private pollFailing = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: HqVaultSyncSchedulerOptions) {
    this.unsubscribe = onHqVaultNotice((notice) => this.notice(notice));
  }

  /** Begin polling (the first check after `firstPollMs`). */
  start(): this {
    this.schedulePoll(this.options.firstPollMs ?? HQ_VAULT_FIRST_POLL_MS);
    return this;
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    if (this.pending) clearTimeout(this.pending);
    if (this.poller) clearTimeout(this.poller);
    this.pending = undefined;
    this.poller = undefined;
  }

  /** A `hq.vault_changed` notice: sync soon if it is for this machine's HQ and news. */
  notice(notice: HqVaultChangedNotice): void {
    void this.consider(notice.hqId, notice.revision).then((due) => {
      if (!due || this.stopped) return;
      this.wanted = Math.max(this.wanted ?? 0, notice.revision);
      if (this.pending) return;
      const delay = Math.floor(
        this.random() * (this.options.jitterMs ?? HQ_VAULT_NOTICE_JITTER_MS),
      );
      this.pending = setTimeout(() => {
        this.pending = undefined;
        void this.run();
      }, delay);
      this.pending.unref?.();
    });
  }

  /** Check HQ's revision now and sync if it moved; resolves when done. */
  async poll(): Promise<void> {
    const device = await this.enrolledDevice();
    if (!device) return;
    let answer: { hqId: string; revision: number };
    try {
      answer = await this.options.service.revision();
    } catch (error) {
      // Offline, or an HQ without the vault: the next poll tries again. Said
      // once per streak, not every five minutes.
      if (!this.pollFailing) {
        this.options.warn?.(`HQ key vault check skipped: ${(error as Error).message}`);
      }
      this.pollFailing = true;
      return;
    }
    this.pollFailing = false;
    if (await this.consider(answer.hqId, answer.revision)) {
      this.wanted = Math.max(this.wanted ?? 0, answer.revision);
      await this.run();
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private random(): number {
    return (this.options.random ?? Math.random)();
  }

  private async enrolledDevice() {
    const device = await this.options.service.device().catch(() => undefined);
    return device && device.status !== 'revoked' ? device : undefined;
  }

  /** True when `revision` of `hqId` is newer than what this machine has. */
  private async consider(hqId: string, revision: number): Promise<boolean> {
    const device = await this.enrolledDevice();
    if (!device || device.hq.hqId !== hqId) return false;
    return device.syncedRevision === undefined || revision > device.syncedRevision;
  }

  /** One sync at a time; a notice arriving meanwhile is re-checked afterwards. */
  private run(): Promise<void> {
    if (this.running) return this.running;
    const target = this.wanted;
    this.running = (async () => {
      try {
        // Another process may have synced while this one waited.
        const device = await this.enrolledDevice();
        if (!device || target === undefined) return;
        if (device.syncedRevision !== undefined && device.syncedRevision >= target) return;
        const report = await this.options.service.sync();
        if (report.added.length + report.updated.length + report.removed.length > 0) {
          this.options.onSynced?.(report);
        }
      } catch (error) {
        if (error instanceof HqVaultDeviceRevokedError) {
          this.options.warn?.(error.message);
          this.stop();
          return;
        }
        this.options.warn?.(`HQ key vault sync failed: ${(error as Error).message}`);
      } finally {
        this.running = undefined;
        // A newer notice arrived while this sync ran: go again (the re-check
        // above skips it if this sync already brought that revision).
        const again = !this.stopped && this.wanted !== undefined && this.wanted !== target;
        if (again) void this.run();
        else this.wanted = undefined;
      }
    })();
    return this.running;
  }

  private schedulePoll(base: number): void {
    if (this.stopped) return;
    const jitter = Math.floor(this.random() * Math.min(base, 60_000) * 0.5);
    this.poller = setTimeout(() => {
      this.poller = undefined;
      void this.poll().finally(() =>
        this.schedulePoll(this.options.pollIntervalMs ?? HQ_VAULT_POLL_INTERVAL_MS),
      );
    }, base + jitter);
    this.poller.unref?.();
  }
}

const started = new Map<string, HqVaultSyncScheduler>();

/**
 * Start this process's background sync for the machine whose HQ identity
 * lives under `globalRoot` (once; a second call returns the first scheduler).
 */
export function startHqVaultBackgroundSync(
  globalRoot: string,
  options: HqVaultSyncSchedulerOptions,
): HqVaultSyncScheduler {
  const existing = started.get(globalRoot);
  if (existing) return existing;
  const scheduler = new HqVaultSyncScheduler(options).start();
  started.set(globalRoot, scheduler);
  return scheduler;
}
