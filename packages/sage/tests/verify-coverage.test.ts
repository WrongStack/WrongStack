import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anchorVerificationCoverage as coverage } from '../src/anchors/verify.js';
import type { AnchorVerificationResult, MemoryAnchor } from '../src/types.js';

let directory: string;
const originalPath = process.env['PATH'];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-anchor-coverage-'));
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  await fs.rm(directory, { recursive: true, force: true });
});

describe('anchor verification completion coverage', () => {
  it('verifies roster and custom roles and rejects invalid or missing roles', async () => {
    await expect(
      coverage.verifyAnchor(directory, { type: 'agent', role: 'reviewer' }),
    ).resolves.toEqual(expect.objectContaining({ status: 'verified' }));
    await expect(
      coverage.verifyAnchor(directory, { type: 'agent', role: '!invalid' }),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'stale', reason: expect.stringContaining('invalid role') }),
    );
    await expect(coverage.verifyAnchor(directory, { type: 'agent' })).resolves.toEqual(
      expect.objectContaining({ status: 'stale' }),
    );

    const role = 'coverage-custom-agent';
    await fs.mkdir(path.join(directory, '.wrongstack', 'agents', role), { recursive: true });
    await expect(coverage.verifyAnchor(directory, { type: 'agent', role })).resolves.toEqual(
      expect.objectContaining({ status: 'verified' }),
    );
    await expect(
      coverage.verifyAnchor(directory, { type: 'agent', role: 'coverage-missing-agent' }),
    ).resolves.toEqual(expect.objectContaining({ status: 'stale' }));
  });

  it('detects symlinks that escape the project root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-anchor-outside-'));
    try {
      const outsideFile = path.join(outside, 'outside.ts');
      await fs.writeFile(outsideFile, 'export const outside = true;');
      await fs.symlink(outsideFile, path.join(directory, 'link.ts'), 'file');
      await expect(
        coverage.verifyAnchor(directory, { type: 'file', path: 'link.ts' }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'stale',
          reason: expect.stringContaining('symlink outside'),
        }),
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('verifies symbols with regex characters and calculates git blob hashes', async () => {
    const body = 'export const value.test = true;\n';
    const file = path.join(directory, 'source.ts');
    await fs.writeFile(file, body);
    const expectedHash = createHash('sha256').update(body).digest('hex');
    const initial = await coverage.verifyAnchor(directory, {
      type: 'git',
      path: 'source.ts',
      symbol: 'value.test',
    });
    expect(initial).toEqual(
      expect.objectContaining({
        status: 'verified',
        contentHash: `sha256:${expectedHash}`,
        gitBlobHash: expect.any(String),
      }),
    );

    await expect(
      coverage.verifyAnchor(directory, {
        type: 'git',
        path: 'source.ts',
        gitBlobHash: 'wrong',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'stale',
        reason: expect.stringContaining('Git blob hash'),
      }),
    );
  });

  it('returns unknown when git cannot be executed', async () => {
    await fs.writeFile(path.join(directory, 'source.ts'), 'content');
    process.env['PATH'] = '';
    await expect(
      coverage.verifyAnchor(directory, { type: 'git', path: 'source.ts' }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'unknown',
        reason: expect.stringContaining('could not be calculated'),
      }),
    );
  });

  it('uses the resolved-root fallback and passes a live signal to file reads', async () => {
    await fs.writeFile(path.join(directory, 'source.ts'), 'export const live = true;');
    await expect(coverage.resolveRealRoot(path.join(directory, 'missing'))).resolves.toBe(
      path.join(directory, 'missing'),
    );
    await expect(
      coverage.verifyAnchor(
        directory,
        { type: 'file', path: 'source.ts' },
        new AbortController().signal,
      ),
    ).resolves.toEqual(expect.objectContaining({ status: 'verified' }));
  });

  it('covers symbol, aggregate, and containment helper boundaries', () => {
    expect(coverage.containsSymbol('const value.test = 1', 'value.test')).toBe(true);
    expect(coverage.containsSymbol('const other = 1', 'missing')).toBe(false);
    expect(coverage.isInside(directory, directory)).toBe(true);
    expect(coverage.isInside(directory, path.join(directory, 'child'))).toBe(true);
    expect(coverage.isInside(directory, path.dirname(directory))).toBe(false);

    const anchor: MemoryAnchor = { type: 'file', path: 'a.ts' };
    const result = (status: AnchorVerificationResult['status']): AnchorVerificationResult => ({
      anchor,
      status,
      reason: status,
    });
    expect(coverage.aggregateStatus([])).toBe('unknown');
    expect(coverage.aggregateStatus([result('contradicted'), result('stale')])).toBe(
      'contradicted',
    );
    expect(coverage.aggregateStatus([result('stale'), result('unknown')])).toBe('stale');
    expect(coverage.aggregateStatus([result('verified'), result('verified')])).toBe('verified');
    expect(coverage.aggregateStatus([result('verified'), result('unknown')])).toBe('unknown');
  });
});
