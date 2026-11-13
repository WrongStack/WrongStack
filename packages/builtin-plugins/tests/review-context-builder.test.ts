import { execFileSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBoard } from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedChimeraConfig } from '../src/chimera-plugin.js';
import {
  annotateUnifiedDiffWithLineNumbers,
  buildReviewContext,
  computeHybridIncrementalDeltaDiff,
  extractSessionIntentSnippets,
  isIgnoredReviewNoisePath,
  parsePorcelainStatusZ,
  prioritizeReviewCandidates,
} from '../src/review-context-builder.js';
import { JsonlFindingStore } from '../src/review-finding-store.js';

const MOCK_CONFIG: ResolvedChimeraConfig = {
  enabled: true,
  provider: 'test-provider',
  model: 'test-model',
  maxFiles: 15,
  autoFix: 'off',
  cascadeOn: 'off',
  maxCascadeDepth: 0,
  fallbackModels: [],
  fallbackProfile: undefined,
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

let tmpDir: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });
}

async function writeAndCommit(filePath: string, content: string, cwd: string): Promise<void> {
  const abs = path.join(cwd, filePath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
  git(['add', filePath], cwd);
  git(['commit', '-m', `feat: add ${filePath}`], cwd);
}

describe('buildReviewContext', () => {
  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'review-ctx-test-'));
    // Initialize a git repo
    git(['init'], tmpDir);
    // Commit an initial file so HEAD exists
    await writeAndCommit('initial.txt', 'initial content\n', tmpDir);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns a bundle with config and cwd', async () => {
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [],
    });
    expect(result.config).toBe(MOCK_CONFIG);
    expect(result.cwd).toBe(tmpDir);
    expect(result.files).toEqual([]);
  });

  it('collects diff for modified files', async () => {
    // Modify the committed file
    await fsp.writeFile(path.join(tmpDir, 'initial.txt'), 'modified content\n');
    git(['add', 'initial.txt'], tmpDir);

    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [{ path: 'initial.txt', status: 'modified', content: 'modified content\n' }],
    });

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe('initial.txt');
    expect(file.status).toBe('modified');
    expect(file.content).toBe('modified content\n');
    expect(file.diff).toBeDefined();
    expect(file.diff).toContain('initial content');
    expect(file.diff).toContain('modified content');
  });

  it('never splits a surrogate pair when capping a large diff for the model', async () => {
    // The capped diff is embedded in the reviewer model's context (auto-review
    // and chimera). A raw slice at MAX_DIFF_BYTES emits a lone surrogate when
    // an astral character straddles the cut — ill-formed UTF-16 that
    // providers reject or mangle (the repo-wide surrogate-safe truncation
    // convention). Measure-and-shift: hunk headers keep a constant length
    // across attempts (only the index hashes change), so one shift lands the
    // emoji's HIGH surrogate exactly at the last kept unit.
    const runBigDiff = (): string =>
      execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'big.txt'], {
        cwd: tmpDir,
        encoding: 'utf8',
        windowsHide: true,
      });
    // Track a base version so the straddle write below is a tracked
    // modification (an untracked file produces no diff at all).
    await writeAndCommit('big.txt', `${'x'.repeat(99_000)}y\n`, tmpDir);
    let shift = 0;
    let line = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      line = `${'x'.repeat(99_000 + shift)}😀${'y'.repeat(20)}\n`;
      await fsp.writeFile(path.join(tmpDir, 'big.txt'), line);
      const highAt = runBigDiff().indexOf('\uD83D');
      if (highAt === 99_999) break;
      shift += 99_999 - highAt;
    }
    git(['add', 'big.txt'], tmpDir);
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [{ path: 'big.txt', status: 'modified', content: line }],
    });
    const file = result.files.find((candidate) => candidate.path === 'big.txt');
    expect(file?.diff).toBeDefined();
    expect(
      LONE_SURROGATE.test(file!.diff!),
      'capped diff carries an ill-formed lone surrogate into the model prompt',
    ).toBe(false);
  });

  it('does not set diff for added (untracked) files', async () => {
    // Create a new untracked file
    await fsp.writeFile(path.join(tmpDir, 'new-file.ts'), 'export const x = 1;\n');

    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [{ path: 'new-file.ts', status: 'added', content: 'export const x = 1;\n' }],
    });

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe('new-file.ts');
    expect(file.status).toBe('added');
    expect(file.diff).toBeUndefined();
  });

  it('collects all changed files (sibling awareness)', async () => {
    // Create multiple changes
    await fsp.writeFile(path.join(tmpDir, 'initial.txt'), 'modified\n');
    await fsp.writeFile(path.join(tmpDir, 'sibling1.ts'), 'a\n');
    await fsp.writeFile(path.join(tmpDir, 'sibling2.ts'), 'b\n');
    git(['add', '-A'], tmpDir);

    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [{ path: 'initial.txt', status: 'modified', content: 'modified\n' }],
    });

    expect(result.allChangedFiles).toBeDefined();
    expect(result.allChangedFiles!.length).toBeGreaterThanOrEqual(3);
    const paths = result.allChangedFiles!.map((f) => f.path);
    expect(paths).toContain('initial.txt');
    expect(paths).toContain('sibling1.ts');
    expect(paths).toContain('sibling2.ts');
  });

  it('preserves raw special-character paths and uses the destination of renames', async () => {
    const unicodePath = 'src/naïve file.ts';
    const oldPath = 'old name.ts';
    const renamedPath = 'renamed → file.ts';
    await fsp.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, unicodePath), 'export const unicode = true;\n');
    await writeAndCommit(oldPath, 'export const renamed = false;\n', tmpDir);
    await fsp.rename(path.join(tmpDir, oldPath), path.join(tmpDir, renamedPath));
    git(['add', '-A'], tmpDir);

    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [],
    });

    const paths = result.allChangedFiles?.map((file) => file.path);
    expect(paths).toContain(unicodePath);
    expect(paths).toContain(renamedPath);
    expect(paths).not.toContain(oldPath);
  });

  it('parses NUL-delimited paths without decoding quotes or backslashes', () => {
    const parsed = parsePorcelainStatusZ(
      '?? src/naïve "quote" \\ file.ts\0R  renamed → file.ts\0old name.ts\0',
    );

    expect(parsed).toEqual([
      { status: '??', path: 'src/naïve "quote" \\ file.ts' },
      { status: 'R', path: 'renamed → file.ts' },
    ]);
  });

  it('collects recent commits', async () => {
    // We already have one commit from beforeEach + one from writeAndCommit
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [],
    });

    expect(result.recentCommits).toBeDefined();
    expect(result.recentCommits!.length).toBeGreaterThanOrEqual(1);
    // The commit message from writeAndCommit
    expect(result.recentCommits!.some((c) => c.includes('initial.txt'))).toBe(true);
  });

  it('never throws on git failures — degrades gracefully', async () => {
    // Point to a non-git directory
    const nonGitDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'review-ctx-nogit-'));
    try {
      const result = await buildReviewContext({
        cwd: nonGitDir,
        config: MOCK_CONFIG,
        files: [{ path: 'foo.ts', status: 'added', content: 'x' }],
      });

      // Should not throw — all enrichment fields undefined
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.diff).toBeUndefined();
      expect(result.allChangedFiles).toEqual([]);
      expect(result.recentCommits).toBeUndefined();
    } finally {
      await fsp.rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it('truncates large diffs to prevent payload bloat', async () => {
    // Create a file with a very large change (>100KB)
    const largeContent = 'x'.repeat(200_000) + '\n';
    await fsp.writeFile(path.join(tmpDir, 'initial.txt'), largeContent);
    git(['add', 'initial.txt'], tmpDir);

    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [{ path: 'initial.txt', status: 'modified', content: largeContent }],
    });

    const diff = result.files[0]!.diff;
    expect(diff).toBeDefined();
    // Should be capped at ~100KB + truncation notice
    expect(diff!.length).toBeLessThan(102_000);
    expect(diff!).toContain('truncated');
  });

  // ── P1 enrichment tests ──────────────────────────────────────────

  it('passes activeTodos through to the bundle', async () => {
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [],
      activeTodos: [
        { id: '1', content: 'Fix the bug', status: 'in_progress' },
        { id: '2', content: 'Add tests', status: 'pending' },
      ],
    });

    expect(result.activeTodos).toBeDefined();
    expect(result.activeTodos).toHaveLength(2);
    expect(result.activeTodos![0]!.content).toBe('Fix the bug');
    expect(result.activeTodos![1]!.status).toBe('pending');
  });

  it('normalizes empty activeTodos to undefined', async () => {
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [],
      activeTodos: [],
    });

    expect(result.activeTodos).toBeUndefined();
  });

  it('leaves activeTodos undefined when not provided', async () => {
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [],
    });

    expect(result.activeTodos).toBeUndefined();
  });

  it('returns undefined kanbanCard when no kanban boards exist', async () => {
    // tmpDir has no .wrongstack/kanbans/ — kanban lookup should gracefully fail
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [],
    });

    expect(result.kanbanCard).toBeUndefined();
  });

  it('enriches a unique active kanban card', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Review work',
      tasks: [
        {
          title: 'Fix parser',
          description: 'Handle raw Git paths',
          status: 'in_progress',
          successCriteria: [
            {
              id: 'criterion-1',
              description: 'Unicode paths are preserved',
              type: 'manual',
              status: 'pending',
            },
          ],
        },
      ],
    });

    const result = await buildReviewContext({ cwd: tmpDir, config: MOCK_CONFIG, files: [] });

    expect(result.kanbanCard).toEqual({
      id: board.tasks[0]?.id,
      title: 'Fix parser',
      description: 'Handle raw Git paths',
      successCriteria: ['Unicode paths are preserved'],
    });
  });

  it('omits kanban enrichment when multiple active cards are ambiguous', async () => {
    await createBoard(tmpDir, {
      title: 'Concurrent work',
      tasks: [
        { title: 'First task', status: 'in_progress' },
        { title: 'Second task', status: 'review' },
      ],
    });

    const result = await buildReviewContext({ cwd: tmpDir, config: MOCK_CONFIG, files: [] });

    expect(result.kanbanCard).toBeUndefined();
  });

  it('returns undefined fileProvenance when no chronicle journal exists', async () => {
    // tmpDir has no .wrongstack/chronicle/ — provenance should gracefully fail
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [{ path: 'initial.txt', status: 'modified', content: 'test' }],
    });

    expect(result.fileProvenance).toBeUndefined();
  });

  it('builds fileProvenance from the host-bound lineage reader', async () => {
    // Chronicle lives above the review plugins; the composition root injects
    // the lineage lookup. Path matching ignores case and separator style.
    const asked: Array<readonly string[]> = [];
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [
        { path: 'src\\Initial.txt', status: 'modified', content: 'test' },
        { path: 'untracked.txt', status: 'added', content: 'x' },
      ],
      fileLineage: async (projectRoot, paths) => {
        expect(projectRoot).toBe(tmpDir);
        asked.push(paths);
        return [
          {
            path: 'src/initial.txt',
            operation: 'modified',
            occurredAt: '2026-10-24T00:00:00.000Z',
            sessionId: 's1',
            agentId: 'worker-1',
            taskId: 'task-7',
            boardId: '',
            runId: '',
            toolName: 'edit',
            providerId: '',
            modelId: '',
            logicalRequestId: '',
            promptManifestId: '',
            provenanceConfidence: 'explicit',
            source: 'external',
          },
        ];
      },
    });

    expect(asked).toEqual([['src\\Initial.txt', 'untracked.txt']]);
    expect(result.fileProvenance).toEqual([
      {
        path: 'src\\Initial.txt',
        agentId: 'worker-1',
        taskId: 'task-7',
        eventType: 'file.external.modified',
        observedAt: '2026-10-24T00:00:00.000Z',
      },
    ]);
  });

  it('leaves fileProvenance undefined when the lineage reader fails', async () => {
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [{ path: 'initial.txt', status: 'modified', content: 'test' }],
      fileLineage: async () => {
        throw new Error('chronicle unavailable');
      },
    });

    expect(result.fileProvenance).toBeUndefined();
  });

  it('includes all P1 fields in the returned bundle shape', async () => {
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [],
      activeTodos: [{ id: 't1', content: 'test task', status: 'in_progress' }],
    });

    // Verify the bundle has all P1 fields (even if some are undefined)
    expect(result).toHaveProperty('activeTodos');
    expect(result).toHaveProperty('kanbanCard');
    expect(result).toHaveProperty('fileProvenance');
    // P0 fields still present
    expect(result).toHaveProperty('files');
    expect(result).toHaveProperty('allChangedFiles');
    expect(result).toHaveProperty('recentCommits');
  });

  // ── cascadeOn threading tests ──

  it('threads cascadeOn into the returned bundle when provided', async () => {
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [],
      cascadeOn: 'high',
    });

    expect(result.cascadeOn).toBe('high');
  });

  it('leaves cascadeOn undefined when not provided', async () => {
    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [],
    });

    expect(result.cascadeOn).toBeUndefined();
  });

  it('threads all cascadeOn enum values correctly', async () => {
    for (const val of ['off', 'critical', 'high'] as const) {
      const result = await buildReviewContext({
        cwd: tmpDir,
        config: MOCK_CONFIG,
        files: [],
        cascadeOn: val,
      });
      expect(result.cascadeOn).toBe(val);
    }
  });

  it('annotates unified diffs with exact 1-based post-image line numbers, symbols, headSha, deletedFiles, and pairedTest status', async () => {
    await writeAndCommit(
      'src/service.ts',
      [
        'export function computeTotal(items: number[]): number {',
        '  return items.length;',
        '}',
        '',
      ].join('\n'),
      tmpDir,
    );
    await writeAndCommit('tests/service.test.ts', 'export const placeholderTest = true;\n', tmpDir);
    await writeAndCommit('obsolete.ts', 'export const old = 1;\n', tmpDir);

    // Modify src/service.ts without touching tests/service.test.ts, and delete obsolete.ts
    const updatedContent = [
      'export function computeTotal(items: number[]): number {',
      '  let sum = 0;',
      '  for (const n of items) sum += n;',
      '  return sum;',
      '}',
      '',
    ].join('\n');
    await fsp.writeFile(path.join(tmpDir, 'src/service.ts'), updatedContent);
    await fsp.rm(path.join(tmpDir, 'obsolete.ts'));

    const bundle = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [{ path: 'src/service.ts', status: 'modified', content: updatedContent }],
    });

    expect(bundle.headSha).toMatch(/^[0-9a-f]{7,12}$/);
    expect(bundle.deletedFiles).toContain('obsolete.ts');

    const entry = bundle.files[0]!;
    expect(entry.hunkCount).toBe(1);
    expect(entry.addedLines).toBe(3);
    expect(entry.removedLines).toBe(1);
    expect(entry.changedSymbols).toContain('computeTotal');
    expect(entry.pairedTestPath).toBe('tests/service.test.ts');
    expect(entry.pairedTestUpdated).toBe(false);
    expect(entry.diff).toContain('   2 | +  let sum = 0;');
    expect(entry.diff).toContain('   4 | +  return sum;');
  });

  it('computes a compact hybrid incremental delta diff when previousSnapshots has an earlier reviewed version', async () => {
    const v0 =
      Array.from({ length: 20 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') +
      '\n';
    await writeAndCommit('src/mod.ts', v0, tmpDir);

    // Mid-session edit v1 changed line 2
    const v1 = v0.replace('export const line2 = 2;', 'export const line2 = 200;');
    const v1Sha = (await import('node:crypto')).createHash('sha256').update(v1).digest('hex');

    // Later edit v2 changed line 18 while keeping line 2 at 200
    const v2 = v1.replace('export const line18 = 18;', 'export const line18 = 1800;');
    await fsp.writeFile(path.join(tmpDir, 'src/mod.ts'), v2);

    const prevMap = new Map([['src/mod.ts', { sha256: v1Sha, content: v1 }]]);
    const bundle = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [{ path: 'src/mod.ts', status: 'modified', content: v2 }],
      previousSnapshots: prevMap,
    });

    const entry = bundle.files[0]!;
    expect(entry.isIncrementalDelta).toBe(true);
    expect(entry.addedLines).toBe(1);
    expect(entry.removedLines).toBe(1);
    expect(entry.diff).toContain('  18 | +export const line18 = 1800;');
    expect(entry.diff).not.toContain('+export const line2 = 200;');
    expect(entry.unchangedHunkSummary).toContain('earlier session hunk(s) against HEAD');
  });

  it('loads active and operator-suppressed prior findings on touched files from projectDir', async () => {
    const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'review-ctx-proj-'));
    try {
      const store = new JsonlFindingStore(projectDir);
      await store.upsert(
        [
          {
            id: 'f-ignore',
            fingerprint: 'fp-ignore',
            severity: 'medium',
            source: 'chimera',
            location: { file: 'initial.txt', line: 1 },
            title: 'Intentional design pattern',
            description: 'Desc',
            createdAt: new Date().toISOString(),
            status: 'active',
            originReport: {
              reportId: 'r-0',
              sessionId: 's-0',
              agentId: 'chimera-review',
              reviewerModel: 'm',
            },
          },
        ],
        { sessionId: 's-0', reportId: 'r-0', agentId: 'chimera-review', model: 'm' },
      );
      await store.transition(
        'f-ignore',
        'ignored',
        { id: 'op', kind: 'operator' },
        { reason: 'ok' },
      );

      const bundle = await buildReviewContext({
        cwd: tmpDir,
        projectDir,
        config: MOCK_CONFIG,
        files: [{ path: 'initial.txt', status: 'modified', content: 'next\n' }],
      });

      expect(bundle.priorFindings).toHaveLength(1);
      expect(bundle.priorFindings![0]).toMatchObject({
        id: 'f-ignore',
        status: 'ignored',
        file: 'initial.txt',
        title: 'Intentional design pattern',
      });
    } finally {
      await fsp.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('pre-scans dangling references to deleted worktree files and propagates sessionIntent', async () => {
    await writeAndCommit('src/obsoleteHelper.ts', 'export const legacyFlag = true;\n', tmpDir);
    const callerContent =
      'import { legacyFlag } from "./obsoleteHelper.js";\nconsole.log(legacyFlag);\n';
    await writeAndCommit('src/caller.ts', callerContent, tmpDir);
    await fsp.rm(path.join(tmpDir, 'src/obsoleteHelper.ts'));

    const bundle = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [{ path: 'src/caller.ts', status: 'modified', content: callerContent }],
      sessionIntent: ['Remove legacy flag module intentionally, keep public API'],
    });

    expect(bundle.deletedFiles).toContain('src/obsoleteHelper.ts');
    expect(bundle.deletedFileReferences).toEqual([
      {
        deletedPath: 'src/obsoleteHelper.ts',
        referencedBy: ['src/caller.ts'],
      },
    ]);
    expect(bundle.sessionIntent).toEqual([
      'Remove legacy flag module intentionally, keep public API',
    ]);
  });
});

describe('noise filtering, source priority, and pure diff helpers', () => {
  it('classifies lockfiles, sourcemaps, snapshots, minified bundles, and binaries as noise', () => {
    expect(isIgnoredReviewNoisePath('bun.lock')).toBe('lockfile');
    expect(isIgnoredReviewNoisePath('packages/app/pnpm-lock.yaml')).toBe('lockfile');
    expect(isIgnoredReviewNoisePath('tests/__snapshots__/view.test.tsx.snap')).toBe('snapshot');
    expect(isIgnoredReviewNoisePath('dist/index.js')).toBe('build_artifact');
    expect(isIgnoredReviewNoisePath('public/vendor.min.js')).toBe('minified');
    expect(isIgnoredReviewNoisePath('assets/logo.png')).toBe('binary_asset');
    expect(isIgnoredReviewNoisePath('.wrongstack/review-claims.jsonl')).toBe('internal_state');
    expect(isIgnoredReviewNoisePath('packages/core/src/index.ts')).toBeNull();
  });

  it('prioritizes production source files ahead of tests, styles, configs, and docs', () => {
    const candidates = [
      { path: 'README.md', status: 'modified' as const },
      { path: 'package.json', status: 'modified' as const },
      { path: 'packages/core/tests/foo.test.ts', status: 'modified' as const },
      { path: 'packages/core/src/foo.ts', status: 'modified' as const },
      { path: 'packages/core/src/bar.ts', status: 'added' as const },
    ];
    const { selected, capped } = prioritizeReviewCandidates(candidates, 3);
    expect(selected.map((f) => f.path)).toEqual([
      'packages/core/src/foo.ts',
      'packages/core/src/bar.ts',
      'packages/core/tests/foo.test.ts',
    ]);
    expect(capped.map((f) => f.path)).toEqual(['package.json', 'README.md']);
  });

  it('annotateUnifiedDiffWithLineNumbers preserves removed lines unnumbered and numbers post-image lines', () => {
    const raw = [
      '@@ -10,3 +10,4 @@ export function greet(name: string) {',
      '   const trimmed = name.trim();',
      '-  return trimmed;',
      '+  if (!trimmed) return "anon";',
      '+  return `hi ${trimmed}`;',
      ' }',
    ].join('\n');
    const res = annotateUnifiedDiffWithLineNumbers(raw);
    expect(res.hunkCount).toBe(1);
    expect(res.addedLines).toBe(2);
    expect(res.removedLines).toBe(1);
    expect(res.changedSymbols).toContain('greet');
    expect(res.annotatedDiff).toContain('     | -  return trimmed;');
    expect(res.annotatedDiff).toContain('  11 | +  if (!trimmed) return "anon";');
    expect(res.annotatedDiff).toContain('  12 | +  return `hi ${trimmed}`;');
  });

  it('computeHybridIncrementalDeltaDiff returns null when contents match', () => {
    expect(computeHybridIncrementalDeltaDiff('same\n', 'same\n')).toBeNull();
  });

  it('extractSessionIntentSnippets strips system reminders, ignores slash commands, deduplicates, and caps to 3 recent prompts', () => {
    const snippets = extractSessionIntentSnippets({
      messages: [
        { role: 'user', content: 'First prompt that should fall off when > 3' },
        {
          role: 'user',
          content:
            '<system-reminder>internal hook</system-reminder> Refactor auth token refresh to skip guest sessions',
        },
        { role: 'assistant', content: 'Working on it' },
        { role: 'user', content: '/review status' },
        {
          role: 'user',
          content: [{ type: 'text', text: '[System: notice]\nKeep legacy v1 endpoint read-only' }],
        },
      ],
      extraInputs: ['Add unit tests for guest session bypass'],
    });

    expect(snippets).toEqual([
      'Refactor auth token refresh to skip guest sessions',
      'Keep legacy v1 endpoint read-only',
      'Add unit tests for guest session bypass',
    ]);
  });

  it('pre-computes external signatureCallers when an exported function signature is modified', async () => {
    const repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'review-sig-callers-'));
    try {
      git(['init'], repoDir);
      await writeAndCommit(
        'src/tokenValidator.ts',
        'export function validateSessionToken(token: string): boolean {\n  return token.length > 0;\n}\n',
        repoDir,
      );
      await writeAndCommit(
        'src/httpMiddleware.ts',
        'import { validateSessionToken } from "./tokenValidator.js";\nexport function guard(req: string) {\n  return validateSessionToken(req);\n}\n',
        repoDir,
      );

      const updatedContent =
        'export function validateSessionToken(token: string, strict: boolean): boolean {\n  return strict ? token.length > 10 : token.length > 0;\n}\n';
      await fsp.writeFile(path.join(repoDir, 'src/tokenValidator.ts'), updatedContent, 'utf8');

      const bundle = await buildReviewContext({
        cwd: repoDir,
        config: MOCK_CONFIG,
        files: [{ path: 'src/tokenValidator.ts', status: 'modified', content: updatedContent }],
      });

      expect(bundle.signatureCallers).toEqual([
        {
          symbol: 'validateSessionToken',
          file: 'src/tokenValidator.ts',
          callers: ['src/httpMiddleware.ts:1', 'src/httpMiddleware.ts:3'],
        },
      ]);
    } finally {
      await fsp.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('filters operator-suppressed findings (ignored/wontfix/false_positive) while keeping fixed regressions', async () => {
    const { filterOperatorSuppressedFindings } = await import(
      '../src/review-finding-integration.js'
    );
    const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chimera-suppressed-'));
    try {
      const findingStore = new JsonlFindingStore(projectDir);
      const baseOrigin = {
        reportId: 'r-prev',
        sessionId: 's-1',
        agentId: 'chimera-review',
        reviewerModel: 'test-model',
      };
      await findingStore.upsert(
        [
          {
            id: 'f-ignored',
            fingerprint: 'fp-ignored',
            severity: 'medium',
            source: 'chimera',
            location: { file: 'src/auth.ts', line: 10 },
            title: 'Guest fallback allowed',
            description: 'Guest fallback is intentional',
            createdAt: new Date().toISOString(),
            status: 'active',
            originReport: baseOrigin,
          },
          {
            id: 'f-wontfix',
            fingerprint: 'fp-wontfix',
            severity: 'high',
            source: 'chimera',
            location: { file: 'src/auth.ts', line: 22 },
            title: 'Legacy sha1 compatibility',
            description: 'Required for v1 clients',
            createdAt: new Date().toISOString(),
            status: 'active',
            originReport: baseOrigin,
          },
          {
            id: 'f-fixed',
            fingerprint: 'fp-fixed',
            severity: 'high',
            source: 'chimera',
            location: { file: 'src/auth.ts', line: 40 },
            title: 'Missing null guard',
            description: 'Throws TypeError on null user',
            createdAt: new Date().toISOString(),
            status: 'active',
            originReport: baseOrigin,
          },
        ],
        { sessionId: 's-1', reportId: 'r-prev', agentId: 'chimera-review', model: 'test-model' },
      );

      await findingStore.transition(
        'f-ignored',
        'ignored',
        { id: 'op', kind: 'operator' },
        { reason: 'intentional' },
      );
      await findingStore.transition(
        'f-wontfix',
        'resolved',
        { id: 'op', kind: 'operator' },
        { outcome: 'wontfix', reason: 'legacy contract' },
      );
      await findingStore.transition(
        'f-fixed',
        'resolved',
        { id: 'op', kind: 'operator' },
        { outcome: 'fixed', reason: 'patched' },
      );

      const candidateFindings = [
        {
          id: 'new-1',
          fingerprint: 'different-fp-line-shifted',
          severity: 'medium' as const,
          source: 'chimera' as const,
          location: { file: './src/auth.ts', line: 14 },
          title: 'Guest fallback allowed',
          description: 'Re-emitted despite DO NOT RE-REPORT',
          createdAt: new Date().toISOString(),
          status: 'active' as const,
          originReport: baseOrigin,
        },
        {
          id: 'new-2',
          fingerprint: 'fp-wontfix',
          severity: 'high' as const,
          source: 'chimera' as const,
          location: { file: 'src/auth.ts', line: 22 },
          title: 'Legacy sha1 compatibility',
          description: 'Re-emitted wontfix',
          createdAt: new Date().toISOString(),
          status: 'active' as const,
          originReport: baseOrigin,
        },
        {
          id: 'new-3',
          fingerprint: 'fp-fixed',
          severity: 'high' as const,
          source: 'chimera' as const,
          location: { file: 'src/auth.ts', line: 40 },
          title: 'Missing null guard',
          description: 'Regression reintroduced',
          createdAt: new Date().toISOString(),
          status: 'active' as const,
          originReport: baseOrigin,
        },
      ];

      const filtered = await filterOperatorSuppressedFindings(candidateFindings, projectDir);
      expect(filtered.suppressedCount).toBe(2);
      expect(filtered.findings.map((f) => f.id)).toEqual(['new-3']);
    } finally {
      await fsp.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('hydrates completed SHA-256 snapshots across restarts and computes live scopeDrift', async () => {
    const { createHash } = await import('node:crypto');
    const {
      getCompletedReviewSnapshots,
      hydrateCompletedSnapshotsFromReportStore,
      isFileContentAlreadyReviewed,
    } = await import('../src/review-claim-registry.js');
    const { computeReportScopeDrift } = await import('../src/review-report-integration.js');
    const { JsonlReportStore } = await import('../src/review-report-store.js');

    const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chimera-hydrate-'));
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chimera-workdir-'));
    try {
      const content = 'export const ANSWER = 42;\n';
      const sha256 = createHash('sha256').update(content).digest('hex');
      await fsp.mkdir(path.join(workDir, 'src'), { recursive: true });
      await fsp.writeFile(path.join(workDir, 'src/answer.ts'), content, 'utf8');

      const reportStore = new JsonlReportStore(projectDir);
      await reportStore.persist({
        id: 'rep-hydrated-1',
        sessionId: 'prev-session',
        agentId: 'chimera-review',
        reviewerModel: 'test-model',
        source: 'chimera',
        reviewStatus: 'success',
        files: [{ path: 'src/answer.ts', status: 'modified' }],
        counts: { critical: 0, high: 0, medium: 0, low: 0 },
        totalFindings: 0,
        unparseableCount: 0,
        rawText: '## 🦂 Chimera Review — all clear ✅',
        scopeManifest: {
          files: [{ path: 'src/answer.ts', status: 'modified', sha256 }],
        },
      });

      const fakeBus = {} as import('@wrongstack/contracts/kernel/events').EventBus;
      expect(isFileContentAlreadyReviewed(fakeBus, workDir, 'src/answer.ts', content)).toBe(false);

      await hydrateCompletedSnapshotsFromReportStore(fakeBus, workDir, projectDir);
      expect(isFileContentAlreadyReviewed(fakeBus, workDir, 'src/answer.ts', content)).toBe(true);
      expect(
        isFileContentAlreadyReviewed(
          fakeBus,
          workDir,
          'src/answer.ts',
          'export const ANSWER = 43;\n',
        ),
      ).toBe(false);
      // SHA-only hydrated snapshots have no content, so delta-diff base stays empty
      expect(getCompletedReviewSnapshots(fakeBus, workDir).size).toBe(0);

      const persisted = await reportStore.get('rep-hydrated-1');
      const driftCurrent = await computeReportScopeDrift(persisted!, workDir);
      expect(driftCurrent).toEqual({
        stale: false,
        checkedCount: 1,
        modifiedPaths: [],
        missingPaths: [],
      });

      await fsp.writeFile(
        path.join(workDir, 'src/answer.ts'),
        'export const ANSWER = 99;\n',
        'utf8',
      );
      const driftStale = await computeReportScopeDrift(persisted!, workDir);
      expect(driftStale).toEqual({
        stale: true,
        checkedCount: 1,
        modifiedPaths: ['src/answer.ts'],
        missingPaths: [],
      });
    } finally {
      await fsp.rm(projectDir, { recursive: true, force: true });
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  });

  it('classifies docs-only and comment/whitespace-only bundles for the 0-token fast path while rejecting suppressions, SKILL.md, and manual triggers', async () => {
    const { classifyZeroTokenReviewFastPath } = await import('../src/review-context-builder.js');

    expect(
      classifyZeroTokenReviewFastPath({
        files: [
          { path: 'README.md', status: 'modified', content: '# Updated docs\n' },
          { path: 'docs/guide.mdx', status: 'added', content: 'Guide text\n' },
        ],
      }),
    ).toEqual({ eligible: true, reason: 'docs_only' });

    expect(
      classifyZeroTokenReviewFastPath({
        files: [
          {
            path: 'packages/core/skills/chimera/SKILL.md',
            status: 'modified',
            content: '# Skill contract\n',
          },
        ],
      }),
    ).toEqual({ eligible: false });

    expect(
      classifyZeroTokenReviewFastPath({
        files: [
          {
            path: 'src/service.ts',
            status: 'modified',
            content: 'export function run() {\n  // clarified invariant\n  return 1;\n}\n',
            diff: [
              '@@ -1,3 +1,4 @@',
              '    1 |  export function run() {',
              '    2 | +  // clarified invariant',
              '    3 | +',
              '    4 |    return 1;',
            ].join('\n'),
          },
        ],
      }),
    ).toEqual({ eligible: true, reason: 'comments_or_whitespace_only' });

    // Suppression comments MUST NOT bypass the LLM reviewer
    expect(
      classifyZeroTokenReviewFastPath({
        files: [
          {
            path: 'src/service.ts',
            status: 'modified',
            content: '// @ts-ignore\nexport const x: number = "bad";\n',
            diff: [
              '@@ -1,1 +1,2 @@',
              '    1 | +// @ts-ignore',
              '    2 |  export const x = 1;',
            ].join('\n'),
          },
        ],
      }),
    ).toEqual({ eligible: false });

    // Manual `/review` MUST NOT bypass the LLM reviewer
    expect(
      classifyZeroTokenReviewFastPath({
        manualTrigger: true,
        files: [{ path: 'README.md', status: 'modified', content: '# Manual check\n' }],
      }),
    ).toEqual({ eligible: false });

    // Annotated code deletions MUST NOT pass the 0-token prescreen when paired with comments,
    // and CRLF diffs must normalize `\r` before hunk annotation.
    const { annotateUnifiedDiffWithLineNumbers } = await import('../src/review-context-builder.js');
    const annotatedDeletion = annotateUnifiedDiffWithLineNumbers(
      [
        'diff --git a/src/service.ts b/src/service.ts',
        '--- a/src/service.ts',
        '+++ b/src/service.ts',
        '@@ -1,4 +1,4 @@',
        ' export function run(authed: boolean) {',
        '-  if (!authed) throw new Error("unauthorized");',
        '+  // removed guard',
        '   return 1;',
        ' }',
      ].join('\r\n'),
    );
    expect(annotatedDeletion.hunkCount).toBe(1);
    expect(annotatedDeletion.removedLines).toBe(1);
    expect(annotatedDeletion.annotatedDiff).not.toContain('\r');
    expect(
      classifyZeroTokenReviewFastPath({
        files: [
          {
            path: 'src/service.ts',
            status: 'modified',
            content: 'export function run(authed: boolean) {\n  // removed guard\n  return 1;\n}\n',
            diff: annotatedDeletion.annotatedDiff,
          },
        ],
      }),
    ).toEqual({ eligible: false });
  });
});
