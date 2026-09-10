/**
 * A PR must not be able to waive the audit gate that is judging it.
 *
 * `pnpm audit` reads `auditConfig.ignoreGhsas` from the branch under test, so
 * adding a GHSA id in the same commit that introduces the vulnerable dependency
 * made the gate report success. Reproduced during the 2026-09-10 audit: three
 * added lines flipped a critical advisory from `exit 1` to `exit 0 (1 ignored)`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { extractIgnoredGhsas, main } from '../../../../scripts/check-audit-suppressions.mjs';

function workspaceYaml(ids: string[]): string {
  return [
    'packages:',
    '  - "packages/*"',
    'auditConfig:',
    '  ignoreGhsas:',
    ...ids.map((id) => `    - ${id}`),
    'minimumReleaseAge: 1440',
    '',
  ].join('\n');
}

function run(baseIds: string[] | null, headIds: string[]): number {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-suppress-'));
  const basePath = path.join(dir, 'base.yaml');
  const headPath = path.join(dir, 'head.yaml');
  if (baseIds !== null) writeFileSync(basePath, workspaceYaml(baseIds));
  writeFileSync(headPath, workspaceYaml(headIds));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return main([basePath, headPath]);
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe('extractIgnoredGhsas', () => {
  it('reads the ids under ignoreGhsas', () => {
    expect([...extractIgnoredGhsas(workspaceYaml(['GHSA-aaaa-bbbb-cccc']))]).toEqual([
      'GHSA-aaaa-bbbb-cccc',
    ]);
  });

  it('returns empty when the key is absent', () => {
    expect(extractIgnoredGhsas('packages:\n  - "packages/*"\n').size).toBe(0);
  });

  it('stops at the end of the block, so unrelated list items do not leak in', () => {
    const yaml = [
      'auditConfig:',
      '  ignoreGhsas:',
      '    - GHSA-real-0000-0000',
      'onlyBuiltDependencies:',
      '  - esbuild',
      '  - node-pty',
      '',
    ].join('\n');
    expect([...extractIgnoredGhsas(yaml)]).toEqual(['GHSA-real-0000-0000']);
  });

  it('tolerates quotes, comments and blank lines', () => {
    const yaml = [
      'auditConfig:',
      '  ignoreGhsas:',
      '    # why this one is safe',
      '',
      '    - "GHSA-quoted-1111-1111"',
      '    - GHSA-trailing-2222-2222 # inline note',
      '',
    ].join('\n');
    expect([...extractIgnoredGhsas(yaml)].sort()).toEqual([
      'GHSA-quoted-1111-1111',
      'GHSA-trailing-2222-2222',
    ]);
  });

  it('reads the real repository file without throwing', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../../..');
    const text = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    const ids = extractIgnoredGhsas(text);
    // Every id must look like a GHSA id — proof the block scan did not swallow
    // `onlyBuiltDependencies` or `minimumReleaseAgeExclude` entries below it.
    for (const id of ids) expect(id).toMatch(/^GHSA-/);
  });
});

describe('check-audit-suppressions', () => {
  it('passes when the list is unchanged', () => {
    expect(run(['GHSA-aaaa-bbbb-cccc'], ['GHSA-aaaa-bbbb-cccc'])).toBe(0);
  });

  it('fails when the PR adds a suppression', () => {
    expect(run(['GHSA-aaaa-bbbb-cccc'], ['GHSA-aaaa-bbbb-cccc', 'GHSA-new-9999-9999'])).toBe(1);
  });

  it('fails when the PR introduces the whole block', () => {
    expect(run([], ['GHSA-new-9999-9999'])).toBe(1);
  });

  it('fails when the base file does not exist at all', () => {
    // A missing base must not read as "nothing added" — that would let the
    // first PR to create the file suppress anything it liked.
    expect(run(null, ['GHSA-new-9999-9999'])).toBe(1);
  });

  it('allows removing a suppression, which only makes the gate stricter', () => {
    expect(run(['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff'], ['GHSA-aaaa-bbbb-cccc'])).toBe(0);
  });

  it('allows a pure reorder', () => {
    expect(run(['GHSA-a-1', 'GHSA-b-2'], ['GHSA-b-2', 'GHSA-a-1'])).toBe(0);
  });

  it('reports usage when arguments are missing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main([])).toBe(2);
    err.mockRestore();
  });
});
