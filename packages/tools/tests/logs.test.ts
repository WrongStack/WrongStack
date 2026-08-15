import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logsTool } from '../src/logs.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logs-tool-'));
});

afterEach(async () => {
  // On Windows a spawned `docker` child (started with cwd = tmpDir) can still
  // hold a lock on the dir when teardown runs, making rmdir throw EBUSY. Retry,
  // then ignore — a leaked temp dir on an ephemeral CI runner is harmless and
  // must not fail an otherwise-passing test.
  await fs
    .rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    .catch(() => {});
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

describe('logsTool', () => {
  it('has correct metadata', () => {
    expect(logsTool.name).toBe('logs');
    expect(logsTool.permission).toBe('confirm');
    expect(logsTool.mutating).toBe(false);
  });

  it('returns none when no service or path provided', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({}, ctx, makeOpts());
    expect(result.source).toBe('none');
    expect(result.entries).toEqual([]);
  });

  it('handles service param (docker)', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp' }, ctx, makeOpts());
    expect(result).toHaveProperty('source');
    expect(result).toHaveProperty('entries');
  });

  it('handles lines default', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp' }, ctx, makeOpts());
    expect(result).toHaveProperty('total');
  });

  it('returns entries for service docker', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp' }, ctx, makeOpts());
    expect(result).toHaveProperty('source');
    expect(result).toHaveProperty('total');
  });

  it('always reports stream_mode false (streaming is not supported)', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp' }, ctx, makeOpts());
    expect(result.stream_mode).toBe(false);
  });

  it('handles filter for service', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp', filter: 'error' }, ctx, makeOpts());
    expect(result).toHaveProperty('total');
  });

  it('handles since for service', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'myapp', since: '1h' }, ctx, makeOpts());
    expect(result).toHaveProperty('total');
  });

  it('reports stream_mode false for file paths too', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    await fs.writeFile(filePath, '2024-01-01 INFO hello\n2024-01-02 ERROR world', 'utf8');
    const ctx = makeCtx();
    const result = await logsTool.execute({ path: 'app.log' }, ctx, makeOpts());
    expect(result.stream_mode).toBe(false);
  });

  it('handles filter for file path', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    await fs.writeFile(filePath, '2024-01-01 INFO hello\n2024-01-02 ERROR world', 'utf8');
    const ctx = makeCtx();
    const result = await logsTool.execute({ path: 'app.log', filter: 'ERROR' }, ctx, makeOpts());
    expect(result).toHaveProperty('total');
  });

  it('parses log entries from file', async () => {
    const filePath = path.join(tmpDir, 'app.log');
    await fs.writeFile(filePath, '2024-01-01 INFO hello\n2024-01-02 ERROR world', 'utf8');
    const ctx = makeCtx();
    const result = await logsTool.execute({ path: 'app.log' }, ctx, makeOpts());
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('parses ISO-timestamped, level-prefixed, and plain lines', async () => {
    const filePath = path.join(tmpDir, 'mixed.log');
    await fs.writeFile(
      filePath,
      [
        '2024-01-01T10:00:00Z [WARN] disk almost full', // timestamped branch
        'ERROR something broke', // level-prefixed branch
        'a plain line with no markers', // fallback branch
      ].join('\n'),
      'utf8',
    );
    const ctx = makeCtx();
    const result = await logsTool.execute({ path: 'mixed.log' }, ctx, makeOpts());
    const levels = result.entries.map((e) => e.level);
    expect(levels).toContain('warn');
    expect(levels).toContain('error');
    expect(levels).toContain('info'); // plain fallback defaults to info
    expect(result.entries.find((e) => e.level === 'warn')?.timestamp).toContain('2024-01-01T10');
  });

  it('truncates to the tail window and reports truncated=true', async () => {
    const filePath = path.join(tmpDir, 'big.log');
    await fs.writeFile(filePath, ['line1', 'line2', 'line3', 'line4'].join('\n'), 'utf8');
    const ctx = makeCtx();
    const result = await logsTool.execute({ path: 'big.log', lines: 2 }, ctx, makeOpts());
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeLessThanOrEqual(2);
  });

  it('returns empty for an invalid docker service name', async () => {
    const ctx = makeCtx();
    const result = await logsTool.execute({ service: 'bad;name|rm' }, ctx, makeOpts());
    expect(result.source).toBe('docker:bad;name|rm');
    expect(result.entries).toEqual([]);
  });

  it('rejects an unsafe filter regex', async () => {
    const ctx = makeCtx();
    await expect(
      logsTool.execute({ path: 'x.log', filter: '(a+)+' }, ctx, makeOpts()),
    ).rejects.toThrow(/logs:/);
  });
});
