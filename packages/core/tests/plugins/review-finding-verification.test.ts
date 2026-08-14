/**
 * Tests for the Chimera finding disk-verification pass (P0-2).
 *
 * Verifies that verifyFindingsAgainstDisk attaches grounded verification
 * verdicts (file exists, line in range, code-anchor proximity) and never
 * throws — unreadable/missing files degrade to explicit failure reasons.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChimeraFinding } from '../../src/plugins/review-finding-types.js';
import {
  extractFindingAnchor,
  resolveFindingPath,
  verifyFindingsAgainstDisk,
} from '../../src/plugins/review-finding-verification.js';

function makeFinding(overrides: Partial<ChimeraFinding> = {}): ChimeraFinding {
  const base: ChimeraFinding = {
    id: 'finding-1',
    fingerprint: 'fp',
    severity: 'high',
    title: 'Null dereference in getUser()',
    description: 'user may be undefined when the session is expired',
    createdAt: new Date().toISOString(),
    status: 'active',
    source: 'chimera',
    originReport: {
      reportId: 'report-1',
      sessionId: 'sess-1',
      agentId: 'chimera-review',
      reviewerModel: 'test-model',
    },
  };
  return { ...base, ...overrides };
}

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finding-verify-'));
  // 15 lines so the custom-anchor-window test can cite line 10 (in range)
  // with the anchor `getUser` on line 1 — outside the default window(2),
  // inside a window of 12.
  await fs.writeFile(
    path.join(dir, 'auth.ts'),
    [
      'export function getUser(token?: string) {',
      '  if (!token) return null;',
      '  return users[token];',
      '}',
      '',
      '// -- filler --',
      'export function refreshSession() {',
      '  const session = loadSession();',
      '  if (!session) return null;',
      '  return session;',
      '}',
      '',
      '// -- filler --',
      'export const ANCHOR_PAD = true;',
      '',
    ].join('\n'),
  );
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('extractFindingAnchor', () => {
  it('prefers a camelCase code identifier over prose', () => {
    expect(
      extractFindingAnchor('Null dereference', 'getUser returns null when token missing'),
    ).toBe('getUser');
  });

  it('prefers snake_case identifiers', () => {
    expect(extractFindingAnchor('Config issue', 'parse_config_file never validates size')).toBe(
      'parse_config_file',
    );
  });

  it('extracts backticked code tokens with high priority', () => {
    expect(extractFindingAnchor('Missing validation', 'check `userToken` before proceeding')).toBe(
      'userToken',
    );
  });

  it('falls back to the longest meaningful token when nothing is code-like', () => {
    expect(extractFindingAnchor('Rate limit', 'the endpoint allows unbounded requests')).toBe(
      'unbounded',
    );
  });

  it('returns undefined when only stopwords are present', () => {
    expect(extractFindingAnchor('Issue', 'the of and to')).toBeUndefined();
  });

  it('returns undefined for empty text', () => {
    expect(extractFindingAnchor('', '')).toBeUndefined();
  });
});

describe('resolveFindingPath', () => {
  it('resolves a repo-relative citation inside the workspace', () => {
    const resolved = resolveFindingPath('src/auth.ts', dir);
    expect(resolved).toBe(path.join(dir, 'src', 'auth.ts'));
  });

  it('normalizes a leading ./ prefix', () => {
    expect(resolveFindingPath('./src/auth.ts', dir)).toBe(path.join(dir, 'src', 'auth.ts'));
  });

  it('normalizes backslashes', () => {
    expect(resolveFindingPath('src\\auth.ts', dir)).toBe(path.join(dir, 'src', 'auth.ts'));
  });

  it('rejects traversal escaping the workspace', () => {
    expect(resolveFindingPath('../secret.ts', dir)).toBeNull();
    expect(resolveFindingPath('../../etc/passwd', dir)).toBeNull();
  });

  it('rejects absolute paths outside the workspace', () => {
    expect(resolveFindingPath('/etc/passwd', dir)).toBeNull();
  });
});

describe('verifyFindingsAgainstDisk', () => {
  it('verifies a finding whose anchor appears at the cited line', async () => {
    const finding = makeFinding({ location: { file: 'auth.ts', line: 3 } });
    const verified = (await verifyFindingsAgainstDisk([finding], { cwd: dir }))[0]!;
    expect(verified.verification).toMatchObject({
      status: 'verified',
      reason: 'anchor_found',
    });
    // The anchor comes from the finding's title (default names `getUser`),
    // which lives on line 1 — inside the window of the cited line 3. The
    // evidence is the matching line, not the cited line.
    expect(verified.verification?.evidence).toContain('getUser');
  });

  it('verifies within the anchor window around the cited line', async () => {
    // anchor `getUser` is on line 1; cite line 2 (one below)
    const finding = makeFinding({ location: { file: 'auth.ts', line: 2 } });
    const verified = (await verifyFindingsAgainstDisk([finding], { cwd: dir }))[0]!;
    expect(verified.verification?.status).toBe('verified');
  });

  it('fails when the cited file does not exist', async () => {
    const finding = makeFinding({ location: { file: 'missing.ts', line: 1 } });
    const verified = (await verifyFindingsAgainstDisk([finding], { cwd: dir }))[0]!;
    expect(verified.verification).toMatchObject({
      status: 'failed',
      reason: 'file_missing',
    });
  });

  it('fails when the cited line is past the end of the file', async () => {
    const finding = makeFinding({ location: { file: 'auth.ts', line: 999 } });
    const verified = (await verifyFindingsAgainstDisk([finding], { cwd: dir }))[0]!;
    expect(verified.verification).toMatchObject({
      status: 'failed',
      reason: 'line_out_of_range',
    });
  });

  it('fails when the citation escapes the workspace', async () => {
    const finding = makeFinding({ location: { file: '../outside.ts', line: 1 } });
    const verified = (await verifyFindingsAgainstDisk([finding], { cwd: dir }))[0]!;
    expect(verified.verification).toMatchObject({
      status: 'failed',
      reason: 'outside_workspace',
    });
  });

  it('leaves findings without a location untouched', async () => {
    const finding = makeFinding();
    const verified = (await verifyFindingsAgainstDisk([finding], { cwd: dir }))[0]!;
    expect(verified.verification).toBeUndefined();
    expect(verified).toEqual(finding);
  });

  it('marks unverified when the anchor is not within the window', async () => {
    const finding = makeFinding({ location: { file: 'auth.ts', line: 1 } });
    // anchor `getUser` is on line 1, but use a title with no code-like anchor
    const noAnchor = makeFinding({
      location: { file: 'auth.ts', line: 1 },
      title: 'Potential issue in this area',
      description: 'a b c d e f g',
    });
    const results = await verifyFindingsAgainstDisk([finding, noAnchor], { cwd: dir });
    // finding 1 has anchor `getUser` in title → verified; finding 2 has only
    // stopwords → unverified (no_anchor)
    expect(results[0]!.verification?.status).toBe('verified');
    expect(results[1]!.verification).toMatchObject({
      status: 'unverified',
      reason: 'no_anchor',
    });
  });

  it('handles a mix of verdicts in one pass and never throws', async () => {
    const findings = [
      makeFinding({ location: { file: 'auth.ts', line: 3 } }),
      makeFinding({ location: { file: 'ghost.ts', line: 1 } }),
      makeFinding({ location: { file: 'auth.ts', line: 999 } }),
      makeFinding(),
    ];
    const results = await verifyFindingsAgainstDisk(findings, { cwd: dir });
    expect(results).toHaveLength(4);
    expect(results[0]!.verification?.status).toBe('verified');
    expect(results[1]!.verification?.reason).toBe('file_missing');
    expect(results[2]!.verification?.reason).toBe('line_out_of_range');
    expect(results[3]!.verification).toBeUndefined();
  });

  it('uses a custom anchor window', async () => {
    // anchor on line 1, cited line 10 — outside default window(2), inside window(12)
    const finding = makeFinding({ location: { file: 'auth.ts', line: 10 } });
    const tight = (await verifyFindingsAgainstDisk([finding], { cwd: dir }))[0]!;
    expect(tight.verification?.status).toBe('unverified');
    const wide = (await verifyFindingsAgainstDisk([finding], { cwd: dir, anchorWindow: 12 }))[0]!;
    expect(wide.verification?.status).toBe('verified');
  });

  it('does not mutate the input findings', async () => {
    const finding = makeFinding({ location: { file: 'auth.ts', line: 3 } });
    await verifyFindingsAgainstDisk([finding], { cwd: dir });
    expect(finding.verification).toBeUndefined();
  });
});
