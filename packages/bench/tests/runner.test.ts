import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapWithConcurrency, runWstack } from '../src/runner.js';
import type { ModelCell } from '../src/types.js';

let dir: string;
let okEntry: string;
let junkEntry: string;
let slowEntry: string;

const cell: ModelCell = { label: 'fake', provider: 'p', model: 'm' };

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-runner-'));

  // A fake wstack that emits a valid --output-json line (plus some noise
  // before it, to prove the parser scans from the end).
  okEntry = path.join(dir, 'ok.js');
  await fs.writeFile(
    okEntry,
    [
      'process.stdout.write("starting up...\\n");',
      'const out = { status: "completed", finalText: "done", usage: { input: 1200, output: 340, iterations: 7, cost: 0.0123, elapsedMs: 999 } };',
      'process.stdout.write(JSON.stringify(out) + "\\n");',
      'process.exit(0);',
    ].join('\n'),
    'utf8',
  );

  // A fake that prints no JSON at all → crashed status.
  junkEntry = path.join(dir, 'junk.js');
  await fs.writeFile(
    junkEntry,
    'process.stdout.write("no json here\\n"); process.exit(3);',
    'utf8',
  );

  // A fake that hangs → timeout status.
  slowEntry = path.join(dir, 'slow.js');
  await fs.writeFile(slowEntry, 'setTimeout(() => process.exit(0), 60000);', 'utf8');
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('runWstack', () => {
  it('parses the --output-json usage block', async () => {
    const run = await runWstack({
      nodeBin: process.execPath,
      wstackEntry: okEntry,
      homeDir: dir,
      workdir: dir,
      cell,
      prompt: 'do the thing',
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('completed');
    expect(run.finalText).toBe('done');
    expect(run.tokensIn).toBe(1200);
    expect(run.tokensOut).toBe(340);
    expect(run.iterations).toBe(7);
    expect(run.costUsd).toBeCloseTo(0.0123, 6);
    expect(run.exitCode).toBe(0);
  });

  it('treats --output-json status "done" as completed', async () => {
    const entry = path.join(dir, 'done.js');
    await fs.writeFile(
      entry,
      'process.stdout.write(JSON.stringify({ status: "done", finalText: "Hi", usage: { input: 10, output: 2, iterations: 1, cost: 0 } }) + "\\n");\n',
      'utf8',
    );
    const run = await runWstack({
      nodeBin: process.execPath,
      wstackEntry: entry,
      homeDir: dir,
      workdir: dir,
      cell,
      prompt: 'hi',
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('completed');
    expect(run.finalText).toBe('Hi');
    expect(run.tokensIn).toBe(10);
  });

  it('reports crashed when no JSON payload is emitted', async () => {
    const run = await runWstack({
      nodeBin: process.execPath,
      wstackEntry: junkEntry,
      homeDir: dir,
      workdir: dir,
      cell,
      prompt: 'x',
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('crashed');
    expect(run.exitCode).toBe(3);
    expect(run.crashDetail).toMatch(/exit 3/);
  });

  it('times out and kills a hung process', async () => {
    const run = await runWstack({
      nodeBin: process.execPath,
      wstackEntry: slowEntry,
      homeDir: dir,
      workdir: dir,
      cell,
      prompt: 'x',
      timeoutMs: 800,
    });
    expect(run.status).toBe('timeout');
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return n;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });
});
