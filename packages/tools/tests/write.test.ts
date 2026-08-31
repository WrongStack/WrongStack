import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTool } from '../src/read.js';
import { writeTool } from '../src/write.js';
import { type Sandbox, mkSandbox, newSignal } from './fixtures.js';

describe('write tool', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('requires a path', async () => {
    await expect(
      writeTool.execute({ path: '', content: 'x' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/path is required/);
  });

  it('requires content', async () => {
    await expect(
      writeTool.execute({ path: 'a.txt', content: undefined as never }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/content is required/);
  });

  it('creates a new file', async () => {
    const out = await writeTool.execute({ path: 'new.txt', content: 'hello' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.created).toBe(true);
    expect(await fs.readFile(path.join(sb.dir, 'new.txt'), 'utf8')).toBe('hello');
  });

  it('preserves the dominant CRLF style when overwriting an existing file', async () => {
    const file = path.join(sb.dir, 'crlf.txt');
    await fs.writeFile(file, 'one\r\ntwo\r\nthree\r\n');
    const out = await writeTool.execute(
      { path: 'crlf.txt', content: 'one\nTWO\nthree\n' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.created).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe('one\r\nTWO\r\nthree\r\n');
  });

  it('preserves LF style when overwriting an LF file with CRLF content', async () => {
    const file = path.join(sb.dir, 'lf.txt');
    await fs.writeFile(file, 'one\ntwo\n');
    await writeTool.execute({ path: 'lf.txt', content: 'one\r\nTWO\r\n' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(await fs.readFile(file, 'utf8')).toBe('one\nTWO\n');
  });

  it('writes new files verbatim — no EOL normalization', async () => {
    const out = await writeTool.execute({ path: 'fresh.txt', content: 'a\r\nb\nc\r\n' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.created).toBe(true);
    expect(await fs.readFile(path.join(sb.dir, 'fresh.txt'), 'utf8')).toBe('a\r\nb\nc\r\n');
  });

  it('reports syntax errors in written TS content (file stays on disk)', async () => {
    const out = await writeTool.execute({ path: 'broken.ts', content: 'const x = ;\n' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.syntax_errors).toBeDefined();
    expect(out.syntax_errors?.length).toBeGreaterThan(0);
    expect(out.note).toMatch(/parse error/);
    expect(await fs.readFile(path.join(sb.dir, 'broken.ts'), 'utf8')).toBe('const x = ;\n');
  });

  it('plain .json is strict but tsconfig-style JSONC accepts comments/trailing commas', async () => {
    // A trailing comma in plain .json is a real error the model must fix.
    const bad = await writeTool.execute({ path: 'bad.json', content: '{ "a": 1, }' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(bad.syntax_errors).toBeDefined();

    // The same content in tsconfig.json is valid JSONC — must NOT be flagged.
    const jsonc = await writeTool.execute(
      { path: 'tsconfig.json', content: '{\n  // comment\n  "a": 1,\n}' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(jsonc.syntax_errors).toBeUndefined();
  });

  it('clean TS content carries no syntax_errors', async () => {
    const out = await writeTool.execute(
      { path: 'ok.ts', content: 'export const x = 1;\n' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(await fs.readFile(path.join(sb.dir, 'ok.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  it('aborted signal prevents the write from touching the filesystem', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      writeTool.execute({ path: 'aborted.txt', content: 'never' }, sb.ctx, {
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fs.access(path.join(sb.dir, 'aborted.txt'))).rejects.toThrow();
  });

  it('honors ctx.signal when opts is omitted in execute and executeStream', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const ctxWithSignal = { ...sb.ctx, signal: ctrl.signal };

    await expect(
      writeTool.execute({ path: 'aborted_ctx.txt', content: 'never' }, ctxWithSignal as any),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fs.access(path.join(sb.dir, 'aborted_ctx.txt'))).rejects.toThrow();

    const streamGen = writeTool.executeStream!(
      { path: 'aborted_stream_ctx.txt', content: 'never' },
      ctxWithSignal as any,
    );
    await expect(async () => {
      for await (const _ of streamGen) {
        // iterate
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fs.access(path.join(sb.dir, 'aborted_stream_ctx.txt'))).rejects.toThrow();
  });


  it('streams each line before finalizing a new file write', async () => {
    const events = [];
    for await (const event of writeTool.executeStream!(
      { path: 'streamed.txt', content: 'one\ntwo\nthree' },
      sb.ctx,
      { signal: newSignal() },
    )) {
      events.push(event);
    }

    expect(events.slice(0, 3)).toEqual([
      { type: 'partial_output', text: 'one\n', data: { livePreview: true } },
      { type: 'partial_output', text: 'two\n', data: { livePreview: true } },
      { type: 'partial_output', text: 'three\n', data: { livePreview: true } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'final', output: { created: true } });
    expect(await fs.readFile(path.join(sb.dir, 'streamed.txt'), 'utf8')).toBe('one\ntwo\nthree');
  });

  it('does not stream overwritten file contents', async () => {
    await fs.writeFile(path.join(sb.dir, 'existing-stream.txt'), 'old');
    const events = [];
    for await (const event of writeTool.executeStream!(
      { path: 'existing-stream.txt', content: 'new' },
      sb.ctx,
      { signal: newSignal() },
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'final', output: { created: false } });
  });

  it('overwrites existing file without prior read (auto-reads internally)', async () => {
    await fs.writeFile(path.join(sb.dir, 'existing.txt'), 'old');
    // Write tool auto-reads the file internally when not already recorded as read.
    // This allows overwriting files the user approved via confirmation without
    // requiring an explicit read tool call first.
    const out = await writeTool.execute({ path: 'existing.txt', content: 'new' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.created).toBe(false);
    expect(await fs.readFile(path.join(sb.dir, 'existing.txt'), 'utf8')).toBe('new');
  });

  it('overwrites after read', async () => {
    await fs.writeFile(path.join(sb.dir, 'existing.txt'), 'old');
    await readTool.execute({ path: 'existing.txt' }, sb.ctx, { signal: newSignal() });
    const out = await writeTool.execute({ path: 'existing.txt', content: 'new' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.created).toBe(false);
    expect(await fs.readFile(path.join(sb.dir, 'existing.txt'), 'utf8')).toBe('new');
  });
});
