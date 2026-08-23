import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  type ContinuousMemoryProfiler,
  type MemoryProfileArtifact,
  startContinuousMemoryProfiler,
} from './continuous-memory-profiler.js';
import type { HeapDiagnosticFields, HeapSample } from './heap-watchdog-types.js';
import { wstackGlobalRoot } from './wstack-paths.js';

const MB = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MINIMUM_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_CONTINUOUS_CAPTURE_MS = 5 * 60 * 1000;
const MAX_OBSERVATIONS = 24;
const MAX_CAPTURE_SESSIONS = 12;
const MAX_CAPTURES_PER_SESSION = 6;
const SESSION_MAX_AGE_MS = 7 * 24 * HOUR_MS;

type CaptureReason =
  | 'absolute-heap'
  | 'detached-contexts'
  | 'heap-growth'
  | 'heap-load'
  | 'interval'
  | 'native-rss-growth';

export interface MemoryFlightObservation {
  at: number;
  heapUsed: number;
  rss: number;
  nativeResidual: number;
}

export interface MemoryCaptureEvent {
  reason: CaptureReason;
  capturedAt: string;
  pid: number;
  sample: HeapSample;
  stats: HeapDiagnosticFields;
  diagnosis: HeapDiagnosticFields;
  observations: readonly MemoryFlightObservation[];
}

export interface MemoryCaptureWriter {
  readonly artifactDir: string;
  capture(event: MemoryCaptureEvent): Promise<void>;
  diagnostics?(): HeapDiagnosticFields;
  stop(): Promise<void>;
}

export interface MemoryFlightRecorder {
  readonly artifactDir: string;
  observe(sample: HeapSample, stats: HeapDiagnosticFields): HeapDiagnosticFields;
  stop(): Promise<void>;
}

export interface MemoryFlightRecorderOptions {
  now?: (() => number) | undefined;
  diagnosticsRoot?: string | undefined;
  windowMs?: number | undefined;
  minimumWindowMs?: number | undefined;
  cooldownMs?: number | undefined;
  continuousCaptureMs?: number | undefined;
  warmupMs?: number | undefined;
  absoluteHeapBytes?: number | undefined;
  heapGrowthBytes?: number | undefined;
  heapGrowthBytesPerHour?: number | undefined;
  nativeGrowthBytes?: number | undefined;
  nativeGrowthBytesPerHour?: number | undefined;
  captureWriter?: MemoryCaptureWriter | undefined;
  enabled?: boolean | undefined;
}

function timestampSlug(date = new Date()): string {
  return date.toISOString().replaceAll(':', '').replaceAll('.', '-');
}

async function pruneCaptureFiles(artifactDir: string): Promise<void> {
  const entries = await fsp.readdir(artifactDir, { withFileTypes: true });
  const captures = entries
    .filter(
      (entry) => entry.isFile() && entry.name.startsWith('event-') && entry.name.endsWith('.json'),
    )
    .map((entry) => entry.name)
    .sort();
  const remove = captures.slice(0, Math.max(0, captures.length - MAX_CAPTURES_PER_SESSION));
  await Promise.all(
    remove.flatMap((eventName) => {
      const stem = eventName.slice('event-'.length, -'.json'.length);
      return [
        fsp.rm(path.join(artifactDir, eventName), { force: true }),
        fsp.rm(path.join(artifactDir, `allocations-${stem}.heapprofile`), { force: true }),
        fsp.rm(path.join(artifactDir, `allocations-${stem}.pb.gz`), { force: true }),
      ];
    }),
  );
}

async function pruneOldSessions(root: string, currentDir: string): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== path.basename(currentDir))
      .map(async (entry) => {
        const fullPath = path.join(root, entry.name);
        const stat = await fsp.stat(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      }),
  );
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const now = Date.now();
  await Promise.all(
    sessions
      .filter(
        (session, index) =>
          now - session.mtimeMs > SESSION_MAX_AGE_MS ||
          (index >= MAX_CAPTURE_SESSIONS && now - session.mtimeMs > 24 * HOUR_MS),
      )
      .map((session) => fsp.rm(session.fullPath, { recursive: true, force: true })),
  );
}

class ContinuousMemoryCaptureWriter implements MemoryCaptureWriter {
  readonly artifactDir: string;
  private readonly root: string;
  private readonly ready: Promise<void>;
  private profiler: ContinuousMemoryProfiler | undefined;
  private profilerBackend = 'initializing';
  private fallbackReason: string | undefined;
  private startError: string | undefined;
  private lastSummary:
    | {
        sampledBytes: number;
        sampledObjects: number;
        sampleCount: number;
        topStack?: string | undefined;
        topStackBytes?: number | undefined;
      }
    | undefined;
  private stopped = false;

  constructor(root: string) {
    this.root = root;
    this.artifactDir = path.join(root, `${timestampSlug()}-pid-${process.pid}`);
    this.ready = this.start().catch((error) => {
      this.startError = error instanceof Error ? error.message : String(error);
      this.profilerBackend = 'unavailable';
    });
  }

  private async start(): Promise<void> {
    const started = await startContinuousMemoryProfiler();
    this.profiler = started.profiler;
    this.profilerBackend = started.profiler.backend;
    this.fallbackReason = started.fallbackReason;
  }

  diagnostics(): HeapDiagnosticFields {
    return {
      memoryProfilerBackend: this.profilerBackend,
      ...(this.fallbackReason ? { memoryProfilerFallbackReason: this.fallbackReason } : {}),
      ...(this.startError ? { memoryProfilerStartError: this.startError } : {}),
      ...(this.lastSummary
        ? {
            memoryProfileSampledBytes: this.lastSummary.sampledBytes,
            memoryProfileSampledObjects: this.lastSummary.sampledObjects,
            memoryProfileSampleCount: this.lastSummary.sampleCount,
            memoryProfileTopStack: this.lastSummary.topStack,
            memoryProfileTopStackBytes: this.lastSummary.topStackBytes,
          }
        : {}),
    };
  }

  async capture(event: MemoryCaptureEvent): Promise<void> {
    await this.ready;
    if (this.stopped) return;
    let profile: MemoryProfileArtifact | undefined;
    let captureError = this.startError;
    if (!captureError && this.profiler) {
      try {
        profile = await this.profiler.capture();
        const top = profile.summary?.topStacks[0];
        if (profile.summary) {
          this.lastSummary = {
            sampledBytes: profile.summary.sampledBytes,
            sampledObjects: profile.summary.sampledObjects,
            sampleCount: profile.summary.sampleCount,
            topStack: top?.frames.join(' <- '),
            topStackBytes: top?.bytes,
          };
        }
      } catch (error) {
        captureError = error instanceof Error ? error.message : String(error);
      }
    }

    await fsp.mkdir(this.artifactDir, { recursive: true });
    const stem = `${timestampSlug(new Date(event.capturedAt))}-${event.reason}`;
    await fsp.writeFile(
      path.join(this.artifactDir, `event-${stem}.json`),
      `${JSON.stringify(
        {
          ...event,
          profilerBackend: profile?.backend ?? this.profilerBackend,
          ...(profile?.summary ? { allocationSummary: profile.summary } : {}),
          ...(this.fallbackReason ? { profilerFallbackReason: this.fallbackReason } : {}),
          ...(captureError ? { captureError } : {}),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    if (profile) {
      await fsp.writeFile(
        path.join(this.artifactDir, `allocations-${stem}${profile.extension}`),
        profile.data,
      );
    }
    await Promise.all([
      pruneCaptureFiles(this.artifactDir),
      fsp
        .mkdir(this.root, { recursive: true })
        .then(() => pruneOldSessions(this.root, this.artifactDir)),
    ]);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.ready;
    await this.profiler?.stop();
  }
}

function disabledWriter(artifactDir: string): MemoryCaptureWriter {
  return {
    artifactDir,
    capture: async () => undefined,
    stop: async () => undefined,
  };
}

export function createMemoryFlightRecorder(
  options: MemoryFlightRecorderOptions = {},
): MemoryFlightRecorder {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const root = options.diagnosticsRoot ?? path.join(wstackGlobalRoot(), 'diagnostics', 'memory');
  const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  const enabled =
    options.enabled ??
    (!isBunRuntime &&
      process.env['WRONGSTACK_MEMORY_FLIGHT_RECORDER'] !== '0' &&
      process.env['NODE_ENV'] !== 'test');
  const writer =
    options.captureWriter ??
    (enabled
      ? new ContinuousMemoryCaptureWriter(root)
      : disabledWriter(path.join(root, `${timestampSlug()}-pid-${process.pid}`)));
  const observations: MemoryFlightObservation[] = [];
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const minimumWindowMs = options.minimumWindowMs ?? DEFAULT_MINIMUM_WINDOW_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const continuousCaptureMs = options.continuousCaptureMs ?? DEFAULT_CONTINUOUS_CAPTURE_MS;
  const warmupMs = options.warmupMs ?? 60_000;
  let lastSignalCaptureAt = Number.NEGATIVE_INFINITY;
  let lastContinuousCaptureAt = startedAt;
  let captureInFlight = false;
  let capturePromise: Promise<void> | undefined;

  const observe = (sample: HeapSample, stats: HeapDiagnosticFields): HeapDiagnosticFields => {
    const at = now();
    const postGcHeapUsed =
      typeof stats['postGcHeapUsed'] === 'number' ? stats['postGcHeapUsed'] : 0;
    const postMajorGcHeapUsed =
      typeof stats['postMajorGcHeapUsed'] === 'number' ? stats['postMajorGcHeapUsed'] : 0;
    const lastGcAgoMs = typeof stats['lastGcAgoMs'] === 'number' ? stats['lastGcAgoMs'] : -1;
    const lastMajorGcAgoMs =
      typeof stats['lastMajorGcAgoMs'] === 'number' ? stats['lastMajorGcAgoMs'] : -1;
    const retainedHeapUsed =
      postMajorGcHeapUsed > 0 && lastMajorGcAgoMs >= 0 && lastMajorGcAgoMs <= windowMs
        ? postMajorGcHeapUsed
        : postGcHeapUsed > 0 && lastGcAgoMs >= 0 && lastGcAgoMs <= minimumWindowMs
          ? postGcHeapUsed
          : sample.heapUsed;
    observations.push({
      at,
      heapUsed: retainedHeapUsed,
      rss: sample.rss,
      nativeResidual: sample.nativeResidual ?? 0,
    });
    while (
      observations.length > MAX_OBSERVATIONS ||
      (observations.length > 1 && at - (observations[0]?.at ?? at) > windowMs)
    ) {
      observations.shift();
    }

    const first = observations[0] ?? observations.at(-1);
    const elapsedMs = first ? Math.max(0, at - first.at) : 0;
    const heapGrowthBytes = first ? retainedHeapUsed - first.heapUsed : 0;
    const rssGrowthBytes = first ? sample.rss - first.rss : 0;
    const nativeGrowthBytes = first ? (sample.nativeResidual ?? 0) - first.nativeResidual : 0;
    const heapGrowthBytesPerHour =
      elapsedMs > 0 ? Math.round((heapGrowthBytes / elapsedMs) * HOUR_MS) : 0;
    const rssGrowthBytesPerHour =
      elapsedMs > 0 ? Math.round((rssGrowthBytes / elapsedMs) * HOUR_MS) : 0;
    const nativeGrowthBytesPerHour =
      elapsedMs > 0 ? Math.round((nativeGrowthBytes / elapsedMs) * HOUR_MS) : 0;

    let signal = 'stable';
    if ((sample.detachedContexts ?? 0) > 0) signal = 'detached-contexts';
    else if (heapGrowthBytes >= 32 * MB && heapGrowthBytesPerHour > 0) signal = 'js-retention';
    else if (nativeGrowthBytes >= 64 * MB && nativeGrowthBytesPerHour > 0) signal = 'native-rss';

    const diagnosis: HeapDiagnosticFields = {
      memorySignal: signal,
      memoryWindowMs: elapsedMs,
      retainedHeapUsed,
      transientHeapBytes: Math.max(0, sample.heapUsed - retainedHeapUsed),
      heapGrowthBytes,
      rssGrowthBytes,
      nativeGrowthBytes,
      heapGrowthBytesPerHour,
      rssGrowthBytesPerHour,
      nativeGrowthBytesPerHour,
      memoryArtifactDir: writer.artifactDir,
      ...(writer.diagnostics?.() ?? {}),
    };

    let reason: CaptureReason | undefined;
    if (at - startedAt >= warmupMs) {
      if ((sample.detachedContexts ?? 0) > 0) reason = 'detached-contexts';
      else if (sample.load >= 0.45) reason = 'heap-load';
      else if (sample.heapUsed >= (options.absoluteHeapBytes ?? 768 * MB)) {
        reason = 'absolute-heap';
      } else if (
        elapsedMs >= minimumWindowMs &&
        heapGrowthBytes >= (options.heapGrowthBytes ?? 32 * MB) &&
        heapGrowthBytesPerHour >= (options.heapGrowthBytesPerHour ?? 192 * MB)
      ) {
        reason = 'heap-growth';
      } else if (
        elapsedMs >= minimumWindowMs &&
        nativeGrowthBytes >= (options.nativeGrowthBytes ?? 128 * MB) &&
        nativeGrowthBytesPerHour >= (options.nativeGrowthBytesPerHour ?? 256 * MB)
      ) {
        reason = 'native-rss-growth';
      }
    }

    const signalCaptureDue = reason !== undefined && at - lastSignalCaptureAt >= cooldownMs;
    const intervalCaptureDue = at - lastContinuousCaptureAt >= continuousCaptureMs;
    const captureReason = signalCaptureDue ? reason : intervalCaptureDue ? 'interval' : undefined;
    if (enabled && captureReason && !captureInFlight) {
      if (captureReason !== 'interval') lastSignalCaptureAt = at;
      lastContinuousCaptureAt = at;
      captureInFlight = true;
      diagnosis['memoryCaptureReason'] = captureReason;
      capturePromise = writer
        .capture({
          reason: captureReason,
          capturedAt: new Date(at).toISOString(),
          pid: process.pid,
          sample,
          stats,
          diagnosis: { ...diagnosis },
          observations: observations.map((observation) => ({ ...observation })),
        })
        .catch(() => {
          // Diagnostics must never surface as an unhandled runtime rejection.
        })
        .finally(() => {
          captureInFlight = false;
          capturePromise = undefined;
        });
    }
    return diagnosis;
  };

  return {
    artifactDir: writer.artifactDir,
    observe,
    stop: async () => {
      await capturePromise;
      await writer.stop();
    },
  };
}
