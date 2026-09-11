import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultLogger } from '../../src/index.js';

describe('DefaultLogger', () => {
  let tmp: string;
  let stderrWrites: string[];
  let origWrite: typeof process.stderr.write;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-log-'));
    stderrWrites = [];
    origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stderr.write = origWrite;
    await fsp.rm(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes JSON lines to file', async () => {
    const logFile = path.join(tmp, 'app.log');
    const log = new DefaultLogger({ level: 'debug', file: logFile });
    log.info('hello', { x: 1 });
    log.debug('details');
    await log.flush();
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.msg).toBe('hello');
    expect(first.ctx).toEqual({ x: 1 });
    expect(first.level).toBe('info');
  });

  it('honours level threshold', () => {
    const log = new DefaultLogger({ level: 'warn' });
    log.info('skipped');
    log.warn('included');
    expect(stderrWrites.join('')).toContain('included');
    expect(stderrWrites.join('')).not.toContain('skipped');
  });

  it('child inherits bindings', async () => {
    const logFile = path.join(tmp, 'c.log');
    const log = new DefaultLogger({ level: 'info', file: logFile, bindings: { app: 'x' } });
    const child = log.child({ comp: 'y' });
    child.info('m');
    await log.flush();
    const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    expect(entry.app).toBe('x');
    expect(entry.comp).toBe('y');
  });

  it('serialises Error context to message+stack', async () => {
    const logFile = path.join(tmp, 'e.log');
    const log = new DefaultLogger({ level: 'error', file: logFile });
    log.error('boom', new Error('inner'));
    await log.flush();
    const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    expect(entry.ctx.message).toBe('inner');
    expect(typeof entry.ctx.stack).toBe('string');
  });

  // ── format: 'json' stderr output ────────────────────────────────────────

  it('format: json writes valid JSON lines to stderr', () => {
    const log = new DefaultLogger({ level: 'debug', format: 'json' });
    log.info('hello', { x: 1 });
    log.debug('details');
    expect(stderrWrites).toHaveLength(2);
    const info = JSON.parse(stderrWrites[0]!);
    expect(info.level).toBe('info');
    expect(info.msg).toBe('hello');
    expect(info.ctx).toEqual({ x: 1 });
    expect(typeof info.ts).toBe('string');
    const debug = JSON.parse(stderrWrites[1]!);
    expect(debug.level).toBe('debug');
    expect(debug.msg).toBe('details');
  });

  it('format: json respects level threshold for stderr', () => {
    const log = new DefaultLogger({ level: 'warn', format: 'json' });
    log.info('skipped');
    log.warn('included');
    expect(stderrWrites).toHaveLength(1);
    const entry = JSON.parse(stderrWrites[0]!);
    expect(entry.msg).toBe('included');
    expect(entry.level).toBe('warn');
  });

  it('format: json child logger inherits format and merges bindings in stderr', () => {
    const log = new DefaultLogger({ level: 'info', format: 'json', bindings: { app: 'x' } });
    const child = log.child({ comp: 'y' });
    child.info('m');
    expect(stderrWrites).toHaveLength(1);
    const entry = JSON.parse(stderrWrites[0]!);
    expect(entry.app).toBe('x');
    expect(entry.comp).toBe('y');
    expect(entry.msg).toBe('m');
  });

  it('format: json serialises Error context to stderr JSON', () => {
    const log = new DefaultLogger({ level: 'error', format: 'json' });
    log.error('boom', new Error('inner'));
    expect(stderrWrites).toHaveLength(1);
    const entry = JSON.parse(stderrWrites[0]!);
    expect(entry.level).toBe('error');
    expect(entry.msg).toBe('boom');
    expect(entry.ctx.message).toBe('inner');
    expect(typeof entry.ctx.stack).toBe('string');
  });

  it('default format is pretty (not JSON on stderr)', () => {
    const log = new DefaultLogger({ level: 'info' });
    log.info('hello');
    expect(stderrWrites).toHaveLength(1);
    // Pretty-printed lines start with the timestamp, not a JSON object
    expect(stderrWrites[0]).not.toContain('{"ts"');
    expect(stderrWrites[0]).toContain('hello');
  });

  it('rotates the file to <file>.1 once it exceeds maxFileBytes', async () => {
    const logFile = path.join(tmp, 'rotate.log');
    const log = new DefaultLogger({
      level: 'info',
      stderr: false,
      file: logFile,
      maxFileBytes: 2_000,
    });
    // Size is checked on the first write and every 100 writes after — write
    // past one check interval with lines that overshoot the cap well before.
    for (let i = 0; i < 101; i++) {
      log.info(`line ${i} ${'x'.repeat(80)}`);
    }
    await log.flush();
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    // Rotated file holds the old lines; the live file restarted small.
    expect(fs.statSync(`${logFile}.1`).size).toBeGreaterThan(2_000);
    expect(fs.statSync(logFile).size).toBeLessThan(2_000);
    // The live file continues from the rotation point — no lines lost.
    const live = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const rotated = fs.readFileSync(`${logFile}.1`, 'utf8').trim().split('\n');
    expect(live.length + rotated.length).toBe(101);
  });
});

/**
 * WS-SEC-07. This sink writes caller context and full error stacks to a JSONL
 * file users routinely attach to bug reports, and nothing scrubbed it. Live
 * feeders exist: `plugin-sdk/src/runtime/llm.ts` passes raw provider
 * `error.message`, and gateways echo strings like
 * `Incorrect API key provided: sk-…`.
 */
describe('DefaultLogger secret redaction (WS-SEC-07)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-log-scrub-'));
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  const KEY = 'sk-abcdefghij0123456789';

  it('redacts a credential in the ctx written to disk', async () => {
    const logFile = path.join(tmp, 'a.log');
    const log = new DefaultLogger({ level: 'info', file: logFile });

    log.error('provider call failed', { detail: `Incorrect API key provided: ${KEY}` });
    await log.flush();

    const raw = fs.readFileSync(logFile, 'utf8');
    expect(raw).not.toContain(KEY);
    // The surrounding diagnostic text has to survive.
    expect(raw).toContain('Incorrect API key provided');
  });

  it('redacts a credential quoted in an Error stack', async () => {
    const logFile = path.join(tmp, 'b.log');
    const log = new DefaultLogger({ level: 'info', file: logFile });
    const err = new Error(`auth failed for ${KEY}`);
    err.stack = `${err.message}\n    at call (/app/x.ts:1:1)`;

    log.error('boom', err);
    await log.flush();

    const raw = fs.readFileSync(logFile, 'utf8');
    expect(raw).not.toContain(KEY);
    expect(raw).toContain('at call');
  });

  it('redacts credentials carried in child bindings', async () => {
    const logFile = path.join(tmp, 'c.log');
    const parent = new DefaultLogger({ level: 'info', file: logFile });
    const log = parent.child({ apiKey: KEY });

    log.info('starting');
    await parent.flush();

    expect(fs.readFileSync(logFile, 'utf8')).not.toContain(KEY);
  });

  it('redacts on the stderr path too, so the two sinks cannot disagree', () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      new DefaultLogger({ level: 'info' }).error('failed', new Error(`token ${KEY} rejected`));
    } finally {
      process.stderr.write = orig;
    }

    expect(writes.join('')).not.toContain(KEY);
  });
});
