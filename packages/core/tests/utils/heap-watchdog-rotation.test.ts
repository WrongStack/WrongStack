/**
 * The heap flight recorder must stay bounded on disk.
 *
 * `startHeapWatchdog` appended to `~/.wrongstack/logs/heap.jsonl` with no cap,
 * no rotation and no retention. On a real install that file reached **1.03 GB
 * over 54 days** — sitting in the same directory as a `wrongstack.log` that had
 * been rotating at 10 MB the whole time. One logger in that directory was
 * bounded and its sibling was not.
 *
 * Rotation now mirrors `DefaultLogger` exactly: past `maxFileBytes`, the live
 * file becomes `<file>.1` (replacing any previous one) so total disk settles at
 * ~2× the cap.
 *
 * The property that actually repairs an affected machine is the third test: a
 * file that is ALREADY over the cap must rotate on the first write of the next
 * process, without anyone running a cleanup command.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHeapWatchdog } from '../../src/utils/heap-watchdog.js';

let dir: string;
let logPath: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'heap-rotate-'));
  logPath = path.join(dir, 'heap.jsonl');
});

afterEach(async () => {
  // The append chain may still hold an in-flight write; let it settle before
  // removing the directory (Windows ENOTEMPTY race).
  await new Promise((r) => setTimeout(r, 50));
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function sizeOf(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return -1;
  }
}

/** Run one watchdog to completion so exactly one sampling write lands. */
async function writeOneSample(maxFileBytes?: number): Promise<void> {
  const stop = startHeapWatchdog({
    logPath,
    sampleEveryMs: 60_000,
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
  });
  await stop();
  await new Promise((r) => setTimeout(r, 30));
}

describe('heap.jsonl rotation', () => {
  it('rotates a file that has outgrown the cap', async () => {
    await fsp.writeFile(logPath, 'x'.repeat(4096), 'utf8');
    await writeOneSample(1024);

    expect(await sizeOf(`${logPath}.1`)).toBe(4096);
    // The live file restarted: it holds the new sample only, not the old bulk.
    const live = await sizeOf(logPath);
    expect(live).toBeGreaterThan(0);
    expect(live).toBeLessThan(4096);
  });

  it('leaves a file under the cap alone', async () => {
    await fsp.writeFile(logPath, 'y'.repeat(100), 'utf8');
    await writeOneSample(1024 * 1024);

    expect(await sizeOf(`${logPath}.1`)).toBe(-1);
    expect(await fsp.readFile(logPath, 'utf8')).toContain('y'.repeat(100));
  });

  it('repairs an already-oversized file on the first write, with no cleanup step', async () => {
    // The shape of the reported 1.03 GB file: huge before this process starts.
    // `writesSinceRotateCheck` begins at 0, so the modulo check fires on write
    // number one rather than number 100 — an affected machine heals by simply
    // running the app again.
    await fsp.writeFile(logPath, 'z'.repeat(64 * 1024), 'utf8');
    await writeOneSample(8 * 1024);

    expect(await sizeOf(`${logPath}.1`)).toBe(64 * 1024);
    expect(await sizeOf(logPath)).toBeLessThan(8 * 1024);
  });

  it('replaces the previous .1 instead of accumulating generations', async () => {
    // Two rotations must still leave exactly two files. Otherwise the cap
    // bounds each file but not the directory, which is the same bug wearing
    // a different shape.
    await fsp.writeFile(`${logPath}.1`, 'old'.repeat(10), 'utf8');
    await fsp.writeFile(logPath, 'a'.repeat(4096), 'utf8');
    await writeOneSample(1024);

    expect(await sizeOf(`${logPath}.1`)).toBe(4096); // the previous .1 is gone
    expect(await sizeOf(`${logPath}.2`)).toBe(-1);
    const entries = (await fsp.readdir(dir)).filter((f) => f.startsWith('heap.jsonl'));
    expect(entries.sort()).toEqual(['heap.jsonl', 'heap.jsonl.1']);
  });

  it('maxFileBytes: 0 disables rotation for callers that want raw capture', async () => {
    await fsp.writeFile(logPath, 'b'.repeat(4096), 'utf8');
    await writeOneSample(0);

    expect(await sizeOf(`${logPath}.1`)).toBe(-1);
    expect(await sizeOf(logPath)).toBeGreaterThan(4096);
  });

  // SECURITY.md rule 3: validate a guard by injection. `maxFileBytes: 0` is
  // the pre-fix behaviour exactly — unbounded append — so the test above is
  // simultaneously a feature test and the proof that these assertions can
  // fail. Without rotation the file only ever grows, which is what the 1.03 GB
  // file was. Pinned explicitly so the relationship is not lost.
  it('injection: without rotation the file only grows', async () => {
    await fsp.writeFile(logPath, 'c'.repeat(4096), 'utf8');
    await writeOneSample(0);
    const first = await sizeOf(logPath);
    await writeOneSample(0);
    const second = await sizeOf(logPath);

    expect(first).toBeGreaterThan(4096);
    expect(second).toBeGreaterThan(first);
    expect(await sizeOf(`${logPath}.1`)).toBe(-1);
  });

  it('defaults to a 10 MB cap, matching DefaultLogger', async () => {
    // A 9 MB file must survive; the default must not be so small that normal
    // flight-recorder history is discarded.
    await fsp.writeFile(logPath, 'd'.repeat(9 * 1024 * 1024), 'utf8');
    await writeOneSample(); // no maxFileBytes → default

    expect(await sizeOf(`${logPath}.1`)).toBe(-1);
    expect(await sizeOf(logPath)).toBeGreaterThan(9 * 1024 * 1024);
  });
});
