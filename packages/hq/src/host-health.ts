/**
 * Samples how the computer a WrongStack client runs on is doing, for the
 * heartbeat: memory, the disk that holds the project, CPU load and uptime.
 * Numbers and the OS family only; no paths, user names or process lists leave
 * the machine. Every probe is best-effort: a reading that fails is left out
 * rather than guessed.
 */
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import type { HqHostHealth } from './protocol.js';

/** Linux `MemAvailable` (what can be handed out without swapping), in bytes. */
async function linuxAvailableMemory(): Promise<number | undefined> {
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const kib = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
    return kib === undefined ? undefined : Number(kib) * 1024;
  } catch {
    return undefined;
  }
}

async function diskOf(dir: string): Promise<{ total: number; free: number } | undefined> {
  try {
    const stats = await statfs(dir);
    const total = Number(stats.blocks) * Number(stats.bsize);
    // `bavail` is what an unprivileged user can still write.
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(total) && total > 0 && Number.isFinite(free)
      ? { total, free: Math.min(free, total) }
      : undefined;
  } catch {
    return undefined;
  }
}

/** One sample. `projectRoot` picks the volume whose free space is reported. */
export async function collectHqHostHealth(projectRoot: string): Promise<HqHostHealth> {
  const platform = process.platform;
  const [available, disk] = await Promise.all([
    platform === 'linux' ? linuxAvailableMemory() : Promise.resolve(undefined),
    diskOf(projectRoot),
  ]);
  const load = os.loadavg()[0];
  return {
    platform,
    arch: process.arch,
    cpuCount: Math.max(1, os.availableParallelism?.() ?? os.cpus().length),
    // Windows has no load average and reports 0; leave it out there.
    ...(platform !== 'win32' && load !== undefined && Number.isFinite(load)
      ? { loadAvg1: Math.round(load * 100) / 100 }
      : {}),
    memTotalBytes: os.totalmem(),
    memAvailableBytes: available ?? os.freemem(),
    osUptimeSec: Math.round(os.uptime()),
    ...(disk !== undefined ? { diskTotalBytes: disk.total, diskFreeBytes: disk.free } : {}),
    processRssBytes: process.memoryUsage.rss(),
  };
}

/**
 * Keeps the newest finished sample so the heartbeat stays synchronous: each
 * `next()` returns what the previous sample found and starts a fresh one in
 * the background. At most one sample runs at a time.
 */
export class HqHostHealthSampler {
  private latest: HqHostHealth | undefined;
  private running = false;
  private readonly sample: (() => Promise<HqHostHealth | undefined>) | undefined;

  constructor(projectRoot: string, sampler?: false | (() => Promise<HqHostHealth | undefined>)) {
    this.sample =
      sampler === false ? undefined : (sampler ?? (() => collectHqHostHealth(projectRoot)));
  }

  next(): HqHostHealth | undefined {
    if (this.sample !== undefined && !this.running) {
      this.running = true;
      this.sample()
        .then(
          (health) => {
            this.latest = health;
          },
          () => undefined,
        )
        .finally(() => {
          this.running = false;
        });
    }
    return this.latest;
  }
}
