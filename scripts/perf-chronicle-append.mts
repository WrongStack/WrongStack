#!/usr/bin/env -S node --import tsx
/**
 * Measure the two levers that decide Chronicle's disk cost, against real
 * node:sqlite — transaction granularity and `PRAGMA synchronous`.
 *
 * Why a script and not a unit test: the unit suite already asserts the SHAPE
 * (`file-observer-io.test.ts` pins that a reconcile burst reaches the journal
 * as one `appendBatch` call, and `sqlite-journal.test.ts` pins the pragma).
 * What a test cannot assert is the COST, because fsync latency is a property
 * of the host's disk, not of the code. This prints that cost so a regression
 * is visible as a number on the machine that has the disk.
 *
 * The two levers do not stack the way they first appear:
 *
 *   - Batching is what matters for bursts. The file observer used to call
 *     `journal.append()` once per changed file; node:sqlite is a synchronous
 *     binding, so the surrounding `Promise.all` overlapped nothing and a
 *     2000-file branch switch paid 2000 serial transactions.
 *   - `synchronous` only matters for the paths that still append ONE event at
 *     a time (the provider, tool and decision adapters). Once a burst is
 *     batched there is a single fsync either way, so FULL and NORMAL converge.
 *
 * Usage: pnpm perf:chronicle [--events <n>] [--help]
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChronicleSqliteJournal } from '../packages/core/src/chronicle/sqlite-journal.js';
import type { ChronicleEventInput } from '../packages/core/src/chronicle/types.js';

const USAGE = `Usage: pnpm perf:chronicle [options]

Options:
  --events <n>   Events per variant (default: 2000)
  --help         Show this help
`;

interface Options {
  events: number;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = { events: 2000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--events') {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 1) {
        process.stderr.write(`Invalid value for --events: ${raw ?? '(missing)'}\n\n${USAGE}`);
        process.exit(2);
      }
      options.events = value;
      continue;
    }
    process.stderr.write(`Unknown argument: ${arg}\n\n${USAGE}`);
    process.exit(2);
  }
  return options;
}

/** Shaped like what the file observer emits when it reconciles a change. */
function makeInputs(count: number): ChronicleEventInput[] {
  return Array.from({ length: count }, (_, i) => ({
    eventType: 'file.external.modified',
    scope: { installationId: 'perf', machineId: 'perf', sessionId: 'perf-session' },
    correlation: { traceId: 'perf-trace', spanId: `span-${i}` },
    outcome: 'success' as const,
    resource: {
      kind: 'file',
      id: `file:src/module-${i}.ts`,
      path: `packages/core/src/module-${i}.ts`,
      contentHashAfter: `${i}`.padStart(64, 'a'),
    },
    attributes: {
      operation: 'edit',
      actor: 'external',
      source: 'external',
      size: 4096 + i,
      mtimeMs: 1_700_000_000_000 + i,
      observedBy: 'fs.watch',
    },
  }));
}

interface Result {
  label: string;
  elapsedMs: number;
  transactions: number;
}

async function run(
  label: string,
  durability: 'normal' | 'full',
  mode: 'per-event' | 'batched',
  count: number,
): Promise<Result> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-chronicle-'));
  const journal = new ChronicleSqliteJournal({ directory: dir, durability });
  const inputs = makeInputs(count);
  const started = performance.now();
  if (mode === 'per-event') {
    // The pre-batching shape: every append started at once and awaited
    // together, which the synchronous binding turns into one transaction each.
    await Promise.all(inputs.map((input) => journal.append(input)));
  } else {
    await journal.appendBatch(inputs);
  }
  const elapsedMs = performance.now() - started;
  const transactions = journal.stats().batches;
  journal.close();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  return { label, elapsedMs, transactions };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const count = options.events;
  process.stdout.write(
    `\nChronicle append — ${count} events per variant, real node:sqlite + WAL\n\n`,
  );
  process.stdout.write(
    `${'variant'.padEnd(26)}${'wall'.padStart(10)}${'txns'.padStart(9)}${'per event'.padStart(13)}\n`,
  );
  process.stdout.write(`${'-'.repeat(58)}\n`);

  const results: Result[] = [];
  for (const [label, durability, mode] of [
    ['FULL   + per-event', 'full', 'per-event'],
    ['FULL   + batched', 'full', 'batched'],
    ['NORMAL + per-event', 'normal', 'per-event'],
    ['NORMAL + batched', 'normal', 'batched'],
  ] as const) {
    const result = await run(label, durability, mode, count);
    results.push(result);
    process.stdout.write(
      `${label.padEnd(26)}${result.elapsedMs.toFixed(0).padStart(7)} ms` +
        `${result.transactions.toString().padStart(7)} tx` +
        `${(result.elapsedMs / count).toFixed(3).padStart(10)} ms\n`,
    );
  }

  const before = results[0]!;
  const after = results[3]!;
  process.stdout.write(
    `\nBurst path (what the file observer does): ${(before.elapsedMs / after.elapsedMs).toFixed(1)}x` +
      ` faster than the pre-batching shape.\n` +
      `Single-append path (provider/tool/decision adapters) is the only place ` +
      `synchronous still moves the number.\n\n`,
  );

  // Cheap guard so the script fails loudly if batching ever stops batching.
  if (after.transactions !== 1) {
    process.stderr.write(
      `FAIL: batched mode used ${after.transactions} transactions, expected 1.\n`,
    );
    process.exitCode = 1;
  }
}

await main();
