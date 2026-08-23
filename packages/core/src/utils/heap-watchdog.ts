/**
 * heap-watchdog — periodic V8 heap sampling for long-running CLI/WebUI sessions.
 *
 * Extracted from the TUI's heap-watchdog so that every surface (CLI headless,
 * WebUI server, TUI) shares one implementation. Long autonomous sessions (10h+)
 * have hit `FATAL ERROR: Ineffective mark-compacts near heap limit` with nothing
 * attributing WHAT grew. This watchdog:
 *
 *   - samples `process.memoryUsage()` + `v8.getHeapStatistics()` on an interval
 *   - appends a JSONL diagnostic line to `~/.wrongstack/logs/heap.jsonl` every
 *     `logEveryMs`, including caller-supplied structure sizes
 *   - fires `onWarn` when heap usage crosses WARN (60%) / CRITICAL (85%)
 *     of the V8 heap limit, once per crossing (re-arms with hysteresis)
 *   - clears stale `performance.mark()`/`performance.measure()` entries to
 *     prevent unintentional leakage from React dev tools or other dependencies
 *
 * The log line is intentionally flat JSON so `jq`/spreadsheets can plot it.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { PerformanceObserver, constants as performanceConstants } from 'node:perf_hooks';
import * as v8 from 'node:v8';
import type {
  HeapDiagnosticFields,
  HeapSample,
  HeapWatchdogOptions,
} from './heap-watchdog-types.js';
import { createMemoryFlightRecorder } from './memory-flight-recorder.js';
import { wstackGlobalRoot } from './wstack-paths.js';

export type {
  HeapDiagnosticFields,
  HeapDiagnosticValue,
  HeapSample,
  HeapWatchdogOptions,
} from './heap-watchdog-types.js';

const MB = 1024 * 1024;

export function defaultHeapLogPath(): string {
  const override = process.env['WRONGSTACK_HEAP_LOG_PATH']?.trim();
  if (override) return path.resolve(override);
  return path.join(wstackGlobalRoot(), 'logs', 'heap.jsonl');
}

export function takeHeapSample(): HeapSample {
  const m = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  let spaces: ReturnType<typeof v8.getHeapSpaceStatistics> = [];
  try {
    spaces = v8.getHeapSpaceStatistics();
  } catch {
    // Bun implements aggregate heap statistics but not V8 space statistics.
    // Keep watchdog protection active with the aggregate values it provides.
  }
  const spaceUsed = (name: string): number =>
    spaces.find((space) => space.space_name === name)?.space_used_size ?? 0;
  const limit = heap.heap_size_limit || 0;
  let activeResources = 0;
  let activeResourceTypes = '';
  try {
    const resources = process.getActiveResourcesInfo?.() ?? [];
    activeResources = resources.length;
    const counts = new Map<string, number>();
    for (const resource of resources) counts.set(resource, (counts.get(resource) ?? 0) + 1);
    activeResourceTypes = [...counts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([resource, count]) => `${resource}=${count}`)
      .join(',');
  } catch {
    // getActiveResourcesInfo can throw during OOM teardown
  }
  return {
    ts: new Date().toISOString(),
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
    nativeResidual: Math.max(0, m.rss - m.heapTotal - m.external),
    oldSpaceUsed: spaceUsed('old_space'),
    newSpaceUsed: spaceUsed('new_space'),
    largeObjectSpaceUsed: spaceUsed('large_object_space'),
    codeSpaceUsed: spaceUsed('code_space'),
    mallocedMemory: heap.malloced_memory,
    peakMallocedMemory: heap.peak_malloced_memory,
    nativeContexts: heap.number_of_native_contexts,
    detachedContexts: heap.number_of_detached_contexts,
    activeResources,
    activeResourceTypes,
    heapLimit: limit,
    load: limit > 0 ? m.heapUsed / limit : 0,
  };
}

/**
 * Start the watchdog. Returns an async stop function — await it on exit when
 * the final diagnostic sample must reach storage. All I/O is best-effort and
 * serialized; a failed append never throws into the caller.
 */
export function startHeapWatchdog(opts: HeapWatchdogOptions = {}): () => Promise<void> {
  const profileMode = process.env['WRONGSTACK_MEMORY_PROFILE'] === '1';
  const sampleEveryMs = opts.sampleEveryMs ?? (profileMode ? 5_000 : 30_000);
  const logEveryMs = opts.logEveryMs ?? (profileMode ? 5_000 : 60_000);
  const logPath = opts.logPath ?? defaultHeapLogPath();
  const warnAt = opts.warnAt ?? 0.6;
  const criticalAt = opts.criticalAt ?? 0.85;
  // Hysteresis: once fired, a level re-arms only after load falls this far
  // below its threshold — prevents a flapping boundary from spamming chat.
  const REARM_MARGIN = 0.05;

  let warnArmed = true;
  let criticalArmed = true;
  let lastLogAt = 0;
  let writeInFlight = false;
  let pendingLine: string | undefined;
  let drainPromise: Promise<void> | undefined;
  let stopped = false;
  let dirReady = false;
  const flightRecorder = createMemoryFlightRecorder();
  let gcMajorCount = 0;
  let gcMinorCount = 0;
  let gcIncrementalCount = 0;
  let gcWeakCallbackCount = 0;
  let gcDurationMs = 0;
  let postGcHeapUsed = 0;
  let postMajorGcHeapUsed = 0;
  let lastGcAt = 0;
  let lastMajorGcAt = 0;
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const kind = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind ?? 0;
      if ((kind & performanceConstants.NODE_PERFORMANCE_GC_MAJOR) !== 0) gcMajorCount++;
      if ((kind & performanceConstants.NODE_PERFORMANCE_GC_MINOR) !== 0) gcMinorCount++;
      if ((kind & performanceConstants.NODE_PERFORMANCE_GC_INCREMENTAL) !== 0) {
        gcIncrementalCount++;
      }
      if ((kind & performanceConstants.NODE_PERFORMANCE_GC_WEAKCB) !== 0) gcWeakCallbackCount++;
      gcDurationMs += entry.duration;
      postGcHeapUsed = process.memoryUsage().heapUsed;
      if ((kind & performanceConstants.NODE_PERFORMANCE_GC_MAJOR) !== 0) {
        postMajorGcHeapUsed = postGcHeapUsed;
        lastMajorGcAt = Date.now();
      }
      lastGcAt = Date.now();
    }
  });
  try {
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch {
    // GC performance entries are unavailable on some runtimes.
  }
  const collectRuntimeStats = (): HeapDiagnosticFields => ({
    gcMajorCount,
    gcMinorCount,
    gcIncrementalCount,
    gcWeakCallbackCount,
    gcDurationMs: Math.round(gcDurationMs),
    postGcHeapUsed,
    postMajorGcHeapUsed,
    lastGcAgoMs: lastGcAt > 0 ? Date.now() - lastGcAt : -1,
    lastMajorGcAgoMs: lastMajorGcAt > 0 ? Date.now() - lastMajorGcAt : -1,
  });
  const writeDiagnosticLine =
    opts.writeDiagnosticLine ??
    (async (targetPath: string, line: string): Promise<void> => {
      if (!dirReady) {
        await fsp.mkdir(path.dirname(targetPath), { recursive: true });
        dirReady = true;
      }
      await fsp.appendFile(targetPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    });

  const drainWrites = async (firstLine: string): Promise<void> => {
    let line: string | undefined = firstLine;
    while (line !== undefined) {
      try {
        await writeDiagnosticLine(logPath, line);
      } catch {
        // Diagnostic writes are best-effort. A later pending sample retries.
      }
      line = pendingLine;
      pendingLine = undefined;
    }
    writeInFlight = false;
  };

  const append = (line: string): void => {
    if (stopped) return;
    if (writeInFlight) {
      // Keep only the freshest sample while storage is slow. A promise chain
      // retained every queued JSON line and could itself become a heap leak.
      pendingLine = line;
      return;
    }
    writeInFlight = true;
    drainPromise = drainWrites(line);
  };

  const appendTerminalSample = (
    event: 'memory.flight_recorder.crash' | 'memory.flight_recorder.exit',
    error?: unknown,
    origin?: string,
  ): void => {
    if (stopped) return;
    let extras: HeapDiagnosticFields = {};
    try {
      extras = opts.collectStats?.() ?? {};
    } catch {
      // Terminal evidence must survive a broken collector.
    }
    try {
      const sample = takeHeapSample();
      const runtimeStats = collectRuntimeStats();
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(
        logPath,
        `${JSON.stringify({
          ...extras,
          ...runtimeStats,
          event,
          ...(origin ? { crashOrigin: origin } : {}),
          ...(error instanceof Error
            ? { errorName: error.name, errorMessage: error.message.slice(0, 1_000) }
            : {}),
          pid: process.pid,
          ...sample,
          exitCode: process.exitCode,
        })}\n`,
        'utf8',
      );
    } catch {
      // There is no safer fallback during process teardown.
    }
  };
  const onUncaughtException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
    appendTerminalSample('memory.flight_recorder.crash', error, origin);
  };
  const onProcessExit = (): void => {
    appendTerminalSample('memory.flight_recorder.exit');
  };
  process.on('uncaughtExceptionMonitor', onUncaughtException);
  process.on('exit', onProcessExit);

  const tick = (): void => {
    // User-timing hygiene. Node keeps every performance.mark()/measure()
    // entry in the global timeline until explicitly cleared — there is no
    // browser DevTools consuming them. React's development build (Component
    // Performance Track) measures every component render, which leaked
    // ~3 GB of PerformanceMeasure objects over a long TUI session before
    // NODE_ENV defaulted to production. Clearing here is belt-and-braces
    // against ANY dependency that emits user timings; the per-interval
    // count is logged so a regression is visible in heap.jsonl.
    let userTimings = 0;
    try {
      userTimings =
        performance.getEntriesByType('mark').length +
        performance.getEntriesByType('measure').length;
      if (userTimings > 0) {
        performance.clearMarks();
        performance.clearMeasures();
      }
    } catch {
      // performance API unavailable — nothing to clean
    }

    const s = takeHeapSample();
    let extras: HeapDiagnosticFields = {};
    try {
      extras = opts.collectStats?.() ?? {};
    } catch {
      // collectStats must not break sampling
    }
    const runtimeStats = collectRuntimeStats();
    const diagnosticStats = { ...extras, ...runtimeStats };
    const memoryDiagnosis = flightRecorder.observe(s, diagnosticStats);
    // Threshold callbacks — critical first so a single giant jump surfaces
    // the stronger message, not both.
    if (s.load >= criticalAt && criticalArmed) {
      criticalArmed = false;
      warnArmed = false;
      opts.onWarn?.(
        'critical',
        `Heap critical: ${Math.round(s.heapUsed / MB)} MB of ~${Math.round(s.heapLimit / MB)} MB V8 limit (${Math.round(s.load * 100)}%). ` +
          `An out-of-memory crash is likely soon — finish/checkpoint work and restart the session. Diagnostics: ${logPath}`,
        s,
      );
    } else if (s.load >= warnAt && warnArmed) {
      warnArmed = false;
      opts.onWarn?.(
        'warn',
        `Heap high: ${Math.round(s.heapUsed / MB)} MB of ~${Math.round(s.heapLimit / MB)} MB V8 limit (${Math.round(s.load * 100)}%). ` +
          `Memory diagnostics are being recorded to ${logPath}`,
        s,
      );
    }
    // Re-arm with hysteresis.
    if (!warnArmed && s.load < warnAt - REARM_MARGIN) warnArmed = true;
    if (!criticalArmed && s.load < criticalAt - REARM_MARGIN) criticalArmed = true;

    // Periodic diagnostic line; also force one on every fired threshold so
    // the crossing itself is always on disk even between log intervals.
    const due = Date.now() - lastLogAt >= logEveryMs;
    const crossed = s.load >= warnAt;
    const captured = typeof memoryDiagnosis['memoryCaptureReason'] === 'string';
    if (due || crossed || captured) {
      lastLogAt = Date.now();
      // Put canonical fields last so a buggy collector cannot overwrite pid,
      // timestamps or memory readings with stale values.
      append(
        JSON.stringify({
          ...extras,
          ...runtimeStats,
          ...memoryDiagnosis,
          pid: process.pid,
          ...s,
          userTimings,
        }),
      );
    }
  };

  const timer = setInterval(tick, sampleEveryMs);
  timer.unref?.();
  // Immediate first sample so a session that OOMs early still leaves a trace.
  tick();

  return async () => {
    stopped = true;
    clearInterval(timer);
    gcObserver.disconnect();
    process.removeListener('uncaughtExceptionMonitor', onUncaughtException);
    process.removeListener('exit', onProcessExit);
    await drainPromise;
    await flightRecorder.stop();
  };
}

interface SharedHeapWatchdogContributor {
  collectStats?: (() => HeapDiagnosticFields) | undefined;
  onWarn?: HeapWatchdogOptions['onWarn'];
}

const sharedContributors = new Map<number, SharedHeapWatchdogContributor>();
let nextSharedContributorId = 1;
let sharedSamplerActive = false;
let stopSharedSampler: (() => Promise<void>) | undefined;

function collectSharedStats(): HeapDiagnosticFields {
  const merged: HeapDiagnosticFields = {};
  for (const contributor of sharedContributors.values()) {
    try {
      Object.assign(merged, contributor.collectStats?.() ?? {});
    } catch {
      // One diagnostics contributor must not hide sibling counters.
    }
  }
  return merged;
}

function warnSharedContributors(
  level: 'warn' | 'critical',
  message: string,
  sample: HeapSample,
): void {
  for (const contributor of sharedContributors.values()) {
    try {
      contributor.onWarn?.(level, message, sample);
    } catch {
      // Warning handlers are observational and must not break the sampler.
    }
  }
}

/**
 * Start or join the single process-wide watchdog.
 *
 * WrongStack's CLI mounts downstream surfaces (TUI/WebUI) inside the same Node
 * process. Each surface used to start its own timer and append alternating
 * partial records for the same PID. Contributors now share one sampler while
 * still attaching surface-specific counters and warning handlers.
 *
 * The first contributor owns cadence/path/writer options. Later contributors
 * only add `collectStats` and `onWarn`. The sampler stops after the final
 * contributor unregisters.
 */
export function startSharedHeapWatchdog(opts: HeapWatchdogOptions = {}): () => Promise<void> {
  if (
    process.env['NODE_ENV'] === 'test' &&
    !sharedSamplerActive &&
    opts.logPath === undefined &&
    opts.writeDiagnosticLine === undefined
  ) {
    return async () => undefined;
  }
  const id = nextSharedContributorId++;
  sharedContributors.set(id, {
    collectStats: opts.collectStats,
    onWarn: opts.onWarn,
  });

  if (!sharedSamplerActive) {
    sharedSamplerActive = true;
    stopSharedSampler = startHeapWatchdog({
      ...opts,
      collectStats: collectSharedStats,
      onWarn: warnSharedContributors,
    });
  }

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    sharedContributors.delete(id);
    if (sharedContributors.size > 0 || !sharedSamplerActive) return;
    const stop = stopSharedSampler;
    if (!stop) return;
    sharedSamplerActive = false;
    stopSharedSampler = undefined;
    await stop();
  };
}
