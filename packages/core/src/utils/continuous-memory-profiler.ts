import { Session } from 'node:inspector/promises';

const DEFAULT_SAMPLE_INTERVAL_BYTES = 512 * 1024;
const DEFAULT_STACK_DEPTH = 64;
const MAX_SUMMARY_STACKS = 20;
const MAX_FRAMES_PER_STACK = 12;

type Numeric = number | bigint;

interface PprofFunction {
  id: Numeric;
  name: Numeric;
  filename: Numeric;
}

interface PprofLocation {
  id: Numeric;
  line: Array<{ functionId: Numeric; line: Numeric }>;
}

interface PprofProfile {
  function: PprofFunction[];
  location: PprofLocation[];
  sample: Array<{ locationId: Numeric[]; value: Numeric[] }>;
  stringTable: { strings: string[] };
}

export interface MemoryAllocationStack {
  bytes: number;
  objects: number;
  frames: string[];
}

export interface MemoryAllocationSummary {
  sampledBytes: number;
  sampledObjects: number;
  sampleCount: number;
  topStacks: MemoryAllocationStack[];
}

export interface MemoryProfileArtifact {
  backend: 'datadog-pprof' | 'node-inspector';
  data: Buffer | string;
  extension: '.heapprofile' | '.pb.gz';
  summary?: MemoryAllocationSummary | undefined;
}

export interface ContinuousMemoryProfiler {
  readonly backend: MemoryProfileArtifact['backend'];
  capture(): Promise<MemoryProfileArtifact>;
  stop(): Promise<void>;
}

export interface ContinuousMemoryProfilerStart {
  profiler: ContinuousMemoryProfiler;
  fallbackReason?: string | undefined;
}

interface DatadogPprofModule {
  encode(profile: unknown): Promise<Buffer>;
  heap: {
    profile(): PprofProfile;
    start(intervalBytes: number, stackDepth: number): void;
    stop(): void;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numeric(value: Numeric | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function summarizePprof(profile: PprofProfile): MemoryAllocationSummary {
  const strings = profile.stringTable.strings;
  const functions = new Map(profile.function.map((entry) => [numeric(entry.id), entry]));
  const locations = new Map(profile.location.map((entry) => [numeric(entry.id), entry]));
  const stacks = new Map<string, MemoryAllocationStack>();
  let sampledBytes = 0;
  let sampledObjects = 0;

  for (const sample of profile.sample) {
    const objects = numeric(sample.value[0]);
    const bytes = numeric(sample.value[1]);
    sampledObjects += objects;
    sampledBytes += bytes;
    const frames = sample.locationId.slice(0, MAX_FRAMES_PER_STACK).flatMap((locationId) => {
      const location = locations.get(numeric(locationId));
      const line = location?.line[0];
      const fn = line ? functions.get(numeric(line.functionId)) : undefined;
      if (!fn) return [];
      const name = strings[numeric(fn.name)] || '(anonymous)';
      const filename = strings[numeric(fn.filename)] || '';
      const lineNumber = numeric(line?.line);
      return [filename ? `${name} (${filename}${lineNumber > 0 ? `:${lineNumber}` : ''})` : name];
    });
    if (frames.length === 0) frames.push('(unknown)');
    const key = frames.join('\n');
    const existing = stacks.get(key);
    if (existing) {
      existing.bytes += bytes;
      existing.objects += objects;
    } else {
      stacks.set(key, { bytes, objects, frames });
    }
  }

  return {
    sampledBytes,
    sampledObjects,
    sampleCount: profile.sample.length,
    topStacks: [...stacks.values()]
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, MAX_SUMMARY_STACKS),
  };
}

async function startDatadogProfiler(): Promise<ContinuousMemoryProfiler> {
  const moduleName = '@datadog/pprof';
  const pprof = (await import(moduleName)) as unknown as DatadogPprofModule;
  pprof.heap.start(DEFAULT_SAMPLE_INTERVAL_BYTES, DEFAULT_STACK_DEPTH);
  let stopped = false;

  return {
    backend: 'datadog-pprof',
    capture: async () => {
      if (stopped) throw new Error('Continuous memory profiler is stopped');
      const profile = pprof.heap.profile();
      return {
        backend: 'datadog-pprof',
        data: await pprof.encode(profile),
        extension: '.pb.gz',
        summary: summarizePprof(profile),
      };
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      pprof.heap.stop();
    },
  };
}

async function startInspectorProfiler(): Promise<ContinuousMemoryProfiler> {
  const session = new Session();
  session.connect();
  try {
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: DEFAULT_SAMPLE_INTERVAL_BYTES,
      includeObjectsCollectedByMajorGC: false,
      includeObjectsCollectedByMinorGC: false,
    });
  } catch (error) {
    try {
      session.disconnect();
    } catch {
      // The connection may already be torn down after a startup failure.
    }
    throw error;
  }

  let stopped = false;
  return {
    backend: 'node-inspector',
    capture: async () => {
      if (stopped) throw new Error('Continuous memory profiler is stopped');
      const result = await session.post('HeapProfiler.stopSampling');
      await session.post('HeapProfiler.startSampling', {
        samplingInterval: DEFAULT_SAMPLE_INTERVAL_BYTES,
        includeObjectsCollectedByMajorGC: false,
        includeObjectsCollectedByMinorGC: false,
      });
      return {
        backend: 'node-inspector',
        data: JSON.stringify(result.profile),
        extension: '.heapprofile',
      };
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await session.post('HeapProfiler.disable');
      } catch {
        // Profiling is diagnostic-only; shutdown must remain reliable.
      }
      try {
        session.disconnect();
      } catch {
        // Already disconnected.
      }
    },
  };
}

/**
 * Start allocation sampling inside the current process.
 *
 * The native pprof backend samples continuously without opening an inspector
 * port. The optional dependency may be missing on unsupported platforms, so
 * Node's built-in Inspector sampling remains a functional fallback.
 */
export async function startContinuousMemoryProfiler(): Promise<ContinuousMemoryProfilerStart> {
  try {
    return { profiler: await startDatadogProfiler() };
  } catch (error) {
    const fallbackReason = errorMessage(error);
    return {
      profiler: await startInspectorProfiler(),
      fallbackReason,
    };
  }
}
