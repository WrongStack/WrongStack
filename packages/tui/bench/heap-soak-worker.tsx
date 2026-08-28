import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough, Writable } from 'node:stream';
import { writeHeapSnapshot } from 'node:v8';
import { type DOMElement, render } from 'ink';
import { createRef, type ReactElement, type RefObject } from 'react';
import { ScrollableHistory } from '../src/components/scrollable-history.js';
import type { HistoryEntry } from '../src/history-entry.js';
import { Box } from '../src/ink.js';
import {
  buildHeapSoakWorkload,
  HEAP_SOAK_SEED,
  heapSoakWorkloadFingerprint,
  workloadCharacterCount,
} from './heap-soak-workload.js';

interface WorkerOptions {
  width: number;
  viewportRows: number;
  entries: number;
  steps: number;
  plateauSamples: number;
  gcPasses: number;
  seed: number;
  output: string;
  snapshot: string | null;
  unmountedSnapshot: string | null;
}

interface MemoryPoint {
  phase: 'baseline' | 'growth' | 'plateau' | 'unmounted';
  index: number;
  entryCount: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  timestampMs: number;
}

interface MountedStructureCounts {
  inkElements: number;
  textNodes: number;
  yogaNodes: number;
  staticNodes: number;
  textCharacters: number;
  maxDepth: number;
  byNodeName: Record<string, number>;
}

class NullTerminal extends Writable {
  readonly isTTY = false;
  readonly rows: number;
  readonly columns: number;
  bytesWritten = 0;

  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.bytesWritten += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    callback();
  }
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value ?? '<missing>'}`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): WorkerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value pairs; invalid argument near ${key ?? '<end>'}`);
    }
    values.set(key.slice(2), value);
  }
  const snapshot = values.get('snapshot');
  const unmountedSnapshot = values.get('unmounted-snapshot');
  return {
    width: parsePositiveInteger(values.get('width'), 'width'),
    viewportRows: parsePositiveInteger(values.get('viewport-rows'), 'viewport-rows'),
    entries: parsePositiveInteger(values.get('entries'), 'entries'),
    steps: parsePositiveInteger(values.get('steps'), 'steps'),
    plateauSamples: parsePositiveInteger(values.get('plateau-samples'), 'plateau-samples'),
    gcPasses: parsePositiveInteger(values.get('gc-passes'), 'gc-passes'),
    seed: parsePositiveInteger(values.get('seed') ?? String(HEAP_SOAK_SEED), 'seed'),
    output: resolve(values.get('output') ?? ''),
    snapshot: snapshot && snapshot !== 'none' ? resolve(snapshot) : null,
    unmountedSnapshot:
      unmountedSnapshot && unmountedSnapshot !== 'none' ? resolve(unmountedSnapshot) : null,
  };
}

function forceGc(passes: number): void {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('global.gc is unavailable; run this worker with node --expose-gc');
  }
  for (let pass = 0; pass < passes; pass++) globalThis.gc();
}

function memoryPoint(
  phase: MemoryPoint['phase'],
  index: number,
  entryCount: number,
  startedAt: number,
): MemoryPoint {
  const usage = process.memoryUsage();
  return {
    phase,
    index,
    entryCount,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    timestampMs: performance.now() - startedAt,
  };
}

function countMountedStructures(root: DOMElement | null): MountedStructureCounts {
  const counts: MountedStructureCounts = {
    inkElements: 0,
    textNodes: 0,
    yogaNodes: 0,
    staticNodes: 0,
    textCharacters: 0,
    maxDepth: 0,
    byNodeName: {},
  };
  if (!root) return counts;
  const stack: Array<{ node: DOMElement['childNodes'][number] | DOMElement; depth: number }> = [
    { node: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const { node, depth } = current;
    counts.maxDepth = Math.max(counts.maxDepth, depth);
    counts.byNodeName[node.nodeName] = (counts.byNodeName[node.nodeName] ?? 0) + 1;
    if (node.nodeName === '#text') {
      counts.textNodes++;
      counts.textCharacters += node.nodeValue.length;
      continue;
    }
    counts.inkElements++;
    if (node.yogaNode) counts.yogaNodes++;
    if (node.internal_static) counts.staticNodes++;
    for (let index = node.childNodes.length - 1; index >= 0; index--) {
      stack.push({ node: node.childNodes[index]!, depth: depth + 1 });
    }
  }
  return counts;
}

function plateauSlope(samples: readonly MemoryPoint[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const sampleSpan = last.index - first.index;
  return sampleSpan > 0 ? (last.heapUsed - first.heapUsed) / sampleSpan : 0;
}

function plateauCheckpointIndexes(sampleCount: number): ReadonlySet<number> {
  const lastIndex = sampleCount - 1;
  return new Set([
    0,
    Math.floor(lastIndex / 4),
    Math.floor(lastIndex / 2),
    Math.floor((lastIndex * 3) / 4),
    lastIndex,
  ]);
}

function app(
  rootRef: RefObject<DOMElement | null>,
  entries: HistoryEntry[],
  width: number,
  viewportRows: number,
  onMeasure: (rows: number) => void,
): ReactElement {
  return (
    <Box ref={rootRef} width={width} height={viewportRows} flexDirection="column">
      <ScrollableHistory
        entries={entries}
        scrollOffset={0}
        viewportRows={viewportRows}
        maxWidth={width}
        onMeasure={onMeasure}
        showModelReasoning={true}
      />
    </Box>
  );
}

async function snapshot(path: string | null): Promise<string | null> {
  if (!path) return null;
  await mkdir(dirname(path), { recursive: true });
  return writeHeapSnapshot(path);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const stdout = new NullTerminal(options.width, options.viewportRows);
  const stderr = new NullTerminal(options.width, options.viewportRows);
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const rootRef = createRef<DOMElement>();
  const samples: MemoryPoint[] = [];
  const startedAt = performance.now();
  let estimatedRows = 0;
  let renderCommits = 0;
  let renderTimeMs = 0;
  let currentCount = 0;
  const onMeasure = (rows: number): void => {
    estimatedRows = rows;
  };
  const instance = render(app(rootRef, [], options.width, options.viewportRows, onMeasure), {
    stdout: stdout as NodeJS.WriteStream,
    stderr: stderr as NodeJS.WriteStream,
    stdin,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: false,
    incrementalRendering: false,
    onRender: ({ renderTime }) => {
      renderCommits++;
      renderTimeMs += renderTime;
    },
  });
  await instance.waitUntilRenderFlush();
  forceGc(options.gcPasses);
  samples.push(memoryPoint('baseline', 0, 0, startedAt));
  // Allocate retained application payload only after the empty-renderer baseline.
  // The workload remains live through unmount, separating app-state retention
  // from memory released specifically by the Ink/React renderer lifecycle.
  const workload = buildHeapSoakWorkload({ entryCount: options.entries, seed: options.seed });
  const plateauCheckpoints = plateauCheckpointIndexes(options.plateauSamples);

  for (let step = 1; step <= options.steps; step++) {
    currentCount = Math.ceil((workload.length * step) / options.steps);
    instance.rerender(
      app(rootRef, workload.slice(0, currentCount), options.width, options.viewportRows, onMeasure),
    );
    await instance.waitUntilRenderFlush();
    forceGc(options.gcPasses);
    samples.push(memoryPoint('growth', step, currentCount, startedAt));
  }

  for (let index = 0; index < options.plateauSamples; index++) {
    instance.rerender(
      app(rootRef, workload.slice(), options.width, options.viewportRows, onMeasure),
    );
    await instance.waitUntilRenderFlush();
    forceGc(options.gcPasses);
    const point = memoryPoint('plateau', index, workload.length, startedAt);
    // Retaining every observation makes the benchmark itself grow linearly
    // with plateauSamples and contaminates the heap slope being measured.
    // Five fixed checkpoints preserve the trend without an unbounded probe.
    if (plateauCheckpoints.has(index)) samples.push(point);
  }

  const mountedStructures = countMountedStructures(rootRef.current);
  forceGc(options.gcPasses);
  const mountedMemory = memoryPoint('plateau', options.plateauSamples, workload.length, startedAt);
  const mountedSnapshot = await snapshot(options.snapshot);

  instance.unmount();
  await instance.waitUntilExit();
  forceGc(options.gcPasses);
  const unmountedMemory = memoryPoint('unmounted', 0, 0, startedAt);
  const unmountedSnapshot = await snapshot(options.unmountedSnapshot);
  const plateau = samples.filter((sample) => sample.phase === 'plateau');
  const report = {
    schemaVersion: 1,
    scenario: {
      width: options.width,
      viewportRows: options.viewportRows,
      entries: options.entries,
      steps: options.steps,
      plateauSamples: options.plateauSamples,
      gcPasses: options.gcPasses,
      seed: options.seed,
    },
    workload: {
      fingerprint: heapSoakWorkloadFingerprint(workload),
      characters: workloadCharacterCount(workload),
    },
    renderer: {
      renderCommits,
      renderTimeMs,
      estimatedRows,
      terminalBytesWritten: stdout.bytesWritten,
      mountedStructures,
    },
    memory: {
      samples,
      mounted: mountedMemory,
      unmounted: unmountedMemory,
      retainedAfterUnmountBytes: Math.max(0, unmountedMemory.heapUsed - samples[0]!.heapUsed),
      releasedOnUnmountBytes: Math.max(0, mountedMemory.heapUsed - unmountedMemory.heapUsed),
      plateauSlopeBytesPerSample: plateauSlope(plateau),
    },
    artifacts: { mountedSnapshot, unmountedSnapshot },
    elapsedMs: performance.now() - startedAt,
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

await main();
