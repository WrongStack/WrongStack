import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetOutputSpoolForTests,
  createOutputSpool,
  spoolNote,
  toolOutputDir,
} from '../src/_output-spool.js';
import { spawnStream } from '../src/_spawn-stream.js';

// vitest.setup.ts points WRONGSTACK_HOME at a per-worker temp dir, so
// toolOutputDir() is hermetic — these tests never touch the real global root.

afterEach(async () => {
  _resetOutputSpoolForTests();
  await fsp.rm(toolOutputDir(), { recursive: true, force: true });
});

describe('createOutputSpool', () => {
  it('creates no file for output under the threshold', () => {
    const spool = createOutputSpool({ tool: 'small', thresholdBytes: 1024 });
    spool.write('hello ');
    spool.write('world');
    expect(spool.finalize()).toBeNull();
  });

  it('spools the FULL output to disk once the threshold is crossed', async () => {
    const spool = createOutputSpool({ tool: 'big', thresholdBytes: 100 });
    const chunkA = 'a'.repeat(80);
    const chunkB = 'b'.repeat(80);
    const chunkC = 'c'.repeat(80);
    spool.write(chunkA);
    spool.write(chunkB); // crosses the threshold — file opens here
    spool.write(chunkC);
    const info = spool.finalize();
    expect(info).not.toBeNull();
    expect(info!.bytes).toBe(240);
    expect(info!.droppedBytes).toBe(0);
    // The file contains the complete output including the pre-threshold head.
    await expect.poll(async () => (await fsp.readFile(info!.path, 'utf8')).length).toBe(240);
    const content = await fsp.readFile(info!.path, 'utf8');
    expect(content).toBe(chunkA + chunkB + chunkC);
  });

  it('uses UTF-8 bytes rather than JavaScript character count for the threshold', async () => {
    const spool = createOutputSpool({ tool: 'unicode', thresholdBytes: 10 });
    spool.write('😀😀😀');

    const info = spool.finalize();

    expect(info?.bytes).toBe(12);
    await expect.poll(async () => fsp.readFile(info!.path, 'utf8')).toBe('😀😀😀');
  });

  it('finalize is idempotent and write() after finalize is a no-op', () => {
    const spool = createOutputSpool({ tool: 'idem', thresholdBytes: 10 });
    spool.write('x'.repeat(50));
    const first = spool.finalize();
    spool.write('more');
    const second = spool.finalize();
    expect(first?.path).toBe(second?.path);
    expect(second?.bytes).toBe(50);
  });

  it('spoolNote mentions the path and total bytes', () => {
    const note = spoolNote({ path: 'C:/tmp/x.log', bytes: 12345, droppedBytes: 0 });
    expect(note).toContain('C:/tmp/x.log');
    expect(note).toContain('12345');
    expect(note).not.toContain('dropped');
  });

  it('spoolNote reports dropped bytes when backpressure occurred', () => {
    const note = spoolNote({ path: '/x.log', bytes: 100, droppedBytes: 42 });
    expect(note).toContain('42 bytes dropped under backpressure');
  });

  it('sweeps spool files older than the retention window on first open', async () => {
    const dir = toolOutputDir();
    await fsp.mkdir(dir, { recursive: true });
    const oldLog = path.join(dir, 'old.log');
    const freshLog = path.join(dir, 'fresh.log');
    const notALog = path.join(dir, 'keep.txt');
    await fsp.writeFile(oldLog, 'old');
    await fsp.writeFile(freshLog, 'fresh');
    await fsp.writeFile(notALog, 'keep');
    // Backdate the old log well past the 7-day retention window.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fsp.utimes(oldLog, eightDaysAgo, eightDaysAgo);

    _resetOutputSpoolForTests(); // allow the once-per-process sweep to run again
    const spool = createOutputSpool({ tool: 'sweep', thresholdBytes: 10 });
    spool.write('z'.repeat(50)); // crosses threshold → open() → triggers the sweep
    spool.finalize();

    await expect.poll(async () => (await fsp.stat(oldLog).catch(() => null)) === null).toBe(true);
    // The fresh .log and the non-.log file are left untouched.
    expect(await fsp.stat(freshLog).then(() => true)).toBe(true);
    expect(await fsp.stat(notALog).then(() => true)).toBe(true);
  });

  it('drops chunks under disk backpressure instead of buffering them on the heap', () => {
    const spool = createOutputSpool({ tool: 'bp', thresholdBytes: 10 });
    spool.write('a'.repeat(20)); // crosses threshold → opens the file
    // A burst far larger than the 4 MB writable high-water mark, written
    // synchronously so the stream can't drain between writes.
    spool.write('b'.repeat(5 * 1024 * 1024));
    spool.write('c'.repeat(1000)); // arrives while writableLength > HWM → dropped
    const info = spool.finalize();
    expect(info).not.toBeNull();
    expect(info!.droppedBytes).toBeGreaterThan(0);
  });
});

describe('spawnStream spool integration', () => {
  it('appends a spool marker to stdout and exposes the path for oversized output', async () => {
    const ctrl = new AbortController();
    // ~150 KB of output with a tiny maxBytes so the spool activates fast.
    const gen = spawnStream({
      cmd: 'node',
      args: ['-e', "process.stdout.write('y'.repeat(150000))"],
      cwd: process.cwd(),
      signal: ctrl.signal,
      maxBytes: 10_000,
    });
    let result: Awaited<ReturnType<typeof gen.next>>['value'];
    for (;;) {
      const { value, done } = await gen.next();
      if (done) {
        result = value;
        break;
      }
    }
    const r = result as {
      stdout: string;
      spoolPath?: string;
      spoolBytes?: number;
    };
    expect(r.spoolPath).toBeTruthy();
    expect(r.spoolBytes).toBe(150000);
    expect(r.stdout).toContain('[output truncated — full 150000 bytes at ');
    const onDisk = await fsp.readFile(r.spoolPath!, 'utf8');
    expect(onDisk.length).toBe(150000);
  });

  it('does not spool when output stays under maxBytes', async () => {
    const ctrl = new AbortController();
    const gen = spawnStream({
      cmd: 'node',
      args: ['-e', "process.stdout.write('ok')"],
      cwd: process.cwd(),
      signal: ctrl.signal,
    });
    let result: Awaited<ReturnType<typeof gen.next>>['value'];
    for (;;) {
      const { value, done } = await gen.next();
      if (done) {
        result = value;
        break;
      }
    }
    const r = result as { stdout: string; spoolPath?: string };
    expect(r.spoolPath).toBeUndefined();
    expect(r.stdout).not.toContain('[output truncated');
  });

  it('retains process output according to UTF-8 bytes', async () => {
    const ctrl = new AbortController();
    const gen = spawnStream({
      cmd: 'node',
      args: ['-e', "process.stdout.write('😀'.repeat(100))"],
      cwd: process.cwd(),
      signal: ctrl.signal,
      maxBytes: 17,
    });
    let result: Awaited<ReturnType<typeof gen.next>>['value'];
    for (;;) {
      const { value, done } = await gen.next();
      if (done) {
        result = value;
        break;
      }
    }
    const output = result as { stdout: string; truncated: boolean };
    const retained = output.stdout.split('\n[output truncated', 1)[0]!;

    expect(retained).toBe('😀'.repeat(4));
    expect(Buffer.byteLength(retained, 'utf8')).toBe(16);
    expect(output.truncated).toBe(true);
  });
});
