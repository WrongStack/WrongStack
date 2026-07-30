#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

function usage() {
  return `Usage: pnpm analyze:memory [options]

Options:
  --log <path>   heap.jsonl path (default: ~/.wrongstack/logs/heap.jsonl)
  --pid <n>      Analyze only one PID
  --tail <n>     Retain the latest N samples while streaming (default: 10000)
  --json         Emit machine-readable JSON
  --help         Show this help
`;
}

function positiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    log: resolve(homedir(), '.wrongstack', 'logs', 'heap.jsonl'),
    pid: undefined,
    tail: 10_000,
    json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') return { help: true, options };
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`Missing value after ${arg}`);
    if (arg === '--log') options.log = resolve(value);
    else if (arg === '--pid') options.pid = positiveInteger(value, arg);
    else if (arg === '--tail') options.tail = positiveInteger(value, arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return { help: false, options };
}

async function readTail(logPath, limit, pid) {
  const ring = new Array(limit);
  let count = 0;
  let seen = 0;
  const input = createReadStream(logPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    let sample;
    try {
      sample = JSON.parse(line);
    } catch {
      continue;
    }
    if (!sample?.rss || !sample?.pid || (pid !== undefined && sample.pid !== pid)) continue;
    ring[seen % limit] = sample;
    seen++;
    count = Math.min(count + 1, limit);
  }
  const start = seen > limit ? seen % limit : 0;
  return Array.from({ length: count }, (_, index) => ring[(start + index) % limit]);
}

function mib(value) {
  return Number(value ?? 0) / (1024 * 1024);
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarize(samples) {
  const byPid = new Map();
  for (const sample of samples) {
    const group = byPid.get(sample.pid) ?? [];
    group.push(sample);
    byPid.set(sample.pid, group);
  }
  return [...byPid.entries()]
    .map(([pid, group]) => {
      group.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      const first = group[0];
      const last = group.at(-1);
      const elapsedHours = Math.max(0, (Date.parse(last.ts) - Date.parse(first.ts)) / 3_600_000);
      const rssDelta = mib(last.rss - first.rss);
      const retainedHeap = (sample) => sample.retainedHeapUsed ?? sample.heapUsed;
      const heapDelta = mib(retainedHeap(last) - retainedHeap(first));
      const externalDelta = mib(last.external - first.external);
      const nativeDelta = mib(
        (last.nativeResidual ?? last.rss - last.heapTotal - last.external) -
          (first.nativeResidual ?? first.rss - first.heapTotal - first.external),
      );
      const signals = [];
      if (last.memorySignal && last.memorySignal !== 'stable') signals.push(last.memorySignal);
      else if (heapDelta > 128) signals.push('js-retention');
      if (externalDelta > 64) signals.push('buffer/external');
      if (nativeDelta > 128) signals.push('native/rss');
      if ((last.detachedContexts ?? 0) > (first.detachedContexts ?? 0)) {
        signals.push('detached-context');
      }
      if ((last.activeResources ?? 0) > (first.activeResources ?? 0) + 25) {
        signals.push('resource-lifecycle');
      }
      return {
        pid,
        surface: last.surface ?? '',
        sessionId: last.sessionId ?? '',
        samples: group.length,
        first: first.ts,
        last: last.ts,
        elapsedHours: round(elapsedHours, 2),
        rssLastMiB: round(mib(last.rss)),
        rssMaxMiB: round(Math.max(...group.map((sample) => mib(sample.rss)))),
        heapLastMiB: round(mib(last.heapUsed)),
        heapMaxMiB: round(Math.max(...group.map((sample) => mib(sample.heapUsed)))),
        retainedHeapLastMiB: round(mib(retainedHeap(last))),
        retainedHeapMaxMiB: round(Math.max(...group.map((sample) => mib(retainedHeap(sample))))),
        externalLastMiB: round(mib(last.external)),
        nativeResidualLastMiB: round(
          mib(last.nativeResidual ?? last.rss - last.heapTotal - last.external),
        ),
        rssDeltaMiB: round(rssDelta),
        heapDeltaMiB: round(heapDelta),
        heapMiBPerHour: elapsedHours > 0 ? round(heapDelta / elapsedHours) : 0,
        messages: last.messages,
        messageEstimatedTokens: last.messageEstimatedTokens,
        historyEntries: last.historyEntries,
        appRenders: last.appRenders,
        providerTextDeltaEvents: last.providerTextDeltaEvents,
        toolExecutedEvents: last.toolExecutedEvents,
        signals,
      };
    })
    .sort((a, b) => b.heapMaxMiB - a.heapMaxMiB);
}

function printTable(rows) {
  const columns = [
    ['PID', (row) => row.pid],
    ['surface', (row) => row.surface || '-'],
    ['samples', (row) => row.samples],
    ['rss MiB', (row) => row.rssLastMiB],
    ['heap MiB', (row) => row.heapLastMiB],
    ['retained', (row) => row.retainedHeapLastMiB],
    ['ret. Δ', (row) => row.heapDeltaMiB],
    ['MiB/h', (row) => row.heapMiBPerHour],
    ['messages', (row) => row.messages ?? '-'],
    ['history', (row) => row.historyEntries ?? '-'],
    ['signals', (row) => row.signals.join(',') || '-'],
  ];
  const widths = columns.map(([header, get]) =>
    Math.max(header.length, ...rows.map((row) => String(get(row)).length)),
  );
  const line = (values) =>
    values
      .map((value, index) => String(value).padEnd(widths[index]))
      .join('  ')
      .trimEnd();
  process.stdout.write(`${line(columns.map(([header]) => header))}\n`);
  process.stdout.write(`${line(widths.map((width) => '-'.repeat(width)))}\n`);
  for (const row of rows) process.stdout.write(`${line(columns.map(([, get]) => get(row)))}\n`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  await access(parsed.options.log);
  const samples = await readTail(parsed.options.log, parsed.options.tail, parsed.options.pid);
  const summary = summarize(samples);
  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify({ log: parsed.options.log, summary }, null, 2)}\n`);
  } else {
    process.stdout.write(`[memory-analysis] ${parsed.options.log} (${samples.length} samples)\n`);
    printTable(summary);
  }
}

main().catch((error) => {
  process.stderr.write(
    `[memory-analysis] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
