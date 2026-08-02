import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyMemoryAnchors } from '../src/anchors/verify.js';
import type { Sage } from '../src/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-verify-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeMemory(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'mem_test',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: 'Test memory.',
    importance: 0.5,
    confidence: 0.5,
    freshness: 0.5,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('verifyMemoryAnchors', () => {
  it('verifies command anchors whose executable resolves', async () => {
    const memory = makeMemory({
      anchors: [{ type: 'command', command: `"${process.execPath}" --version` }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('verified');
    expect(result.anchors[0]?.status).toBe('verified');
  });

  it('marks command anchors with a missing executable stale', async () => {
    const memory = makeMemory({
      anchors: [{ type: 'command', command: 'definitely-not-a-real-command-xyz-123' }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('stale');
    expect(result.anchors[0]?.reason).toContain('was not found');
  });

  it('returns unknown for anchor with no path', async () => {
    const memory = makeMemory({
      anchors: [{ type: 'symbol' }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('unknown');
    expect(result.anchors[0]?.reason).toContain('Anchor has no path');
  });

  it('returns stale for anchor outside project root', async () => {
    const memory = makeMemory({
      anchors: [{ type: 'file', path: '../outside.ts' }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('stale');
    expect(result.anchors[0]?.reason).toContain('outside the project root');
  });

  it('returns stale for non-existent path', async () => {
    const memory = makeMemory({
      anchors: [{ type: 'file', path: 'nonexistent.ts' }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('stale');
    expect(result.anchors[0]?.reason).toContain('no longer exists');
  });

  it('verifies a directory anchor', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    const memory = makeMemory({
      anchors: [{ type: 'directory', path: 'src' }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('verified');
  });

  it('returns stale when directory anchor points to a file', async () => {
    await fs.writeFile(path.join(tmpDir, 'notadir'), 'content', 'utf8');
    const memory = makeMemory({
      anchors: [{ type: 'directory', path: 'notadir' }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('stale');
    expect(result.anchors[0]?.reason).toContain('non-directory');
  });

  it('verifies a package directory anchor', async () => {
    await fs.mkdir(path.join(tmpDir, 'packages', 'demo'), { recursive: true });
    const memory = makeMemory({
      anchors: [{ type: 'package', path: 'packages/demo' }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('verified');
  });

  it('returns stale when package anchor points to a file', async () => {
    await fs.writeFile(path.join(tmpDir, 'notapkg'), 'content', 'utf8');
    const memory = makeMemory({
      anchors: [{ type: 'package', path: 'notapkg' }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('stale');
    expect(result.anchors[0]?.reason).toContain('non-directory');
  });

  it('returns stale when file anchor points to a directory', async () => {
    await fs.mkdir(path.join(tmpDir, 'adir'), { recursive: true });
    const memory = makeMemory({
      anchors: [{ type: 'file', path: 'adir' }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('stale');
    expect(result.anchors[0]?.reason).toContain('non-file');
  });

  it('detects content hash change', async () => {
    const file = path.join(tmpDir, 'source.ts');
    await fs.writeFile(file, 'original content', 'utf8');
    const memory = makeMemory({
      anchors: [{ type: 'file', path: 'source.ts', contentHash: 'sha256:wronghash' }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('stale');
    expect(result.anchors[0]?.reason).toContain('content hash changed');
    expect(result.anchors[0]?.contentHash).toBeDefined();
  });

  it('detects missing symbol in file', async () => {
    const file = path.join(tmpDir, 'source.ts');
    await fs.writeFile(file, 'export const foo = 1;\n', 'utf8');
    const memory = makeMemory({
      anchors: [{ type: 'symbol', path: 'source.ts', symbol: 'NonExistentSymbol' }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('stale');
    expect(result.anchors[0]?.reason).toContain('no longer exists');
  });

  it('accepts signal to abort', async () => {
    const abort = new AbortController();
    abort.abort();
    const memory = makeMemory({
      anchors: [{ type: 'file', path: 'source.ts' }],
    });
    await expect(verifyMemoryAnchors(tmpDir, memory, undefined, abort.signal)).rejects.toThrow();
  });

  it('returns verified for a valid file anchor with matching content hash', async () => {
    const file = path.join(tmpDir, 'source.ts');
    await fs.writeFile(file, 'export const x = 1;\n', 'utf8');
    const { createHash } = await import('node:crypto');
    const hash = `sha256:${createHash('sha256').update('export const x = 1;\n').digest('hex')}`;
    const memory = makeMemory({
      anchors: [{ type: 'file', path: 'source.ts', contentHash: hash }],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('verified');
  });

  it('returns unknown for empty anchors list', async () => {
    const result = await verifyMemoryAnchors(tmpDir, makeMemory());
    expect(result.status).toBe('unknown');
  });

  it('aggregates correctly: stale takes precedence over unknown', async () => {
    const memory = makeMemory({
      anchors: [
        { type: 'file', path: 'nonexistent.ts' },
        { type: 'command', command: 'test' },
      ],
    });
    const result = await verifyMemoryAnchors(tmpDir, memory);
    expect(result.status).toBe('stale');
  });

  it('includes checkedAt timestamp', async () => {
    const memory = makeMemory({ anchors: [{ type: 'command', command: 'test' }] });
    const result = await verifyMemoryAnchors(tmpDir, memory, '2026-06-01T00:00:00.000Z');
    expect(result.checkedAt).toBe('2026-06-01T00:00:00.000Z');
  });
});
