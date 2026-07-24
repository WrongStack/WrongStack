import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildReviewContext,
  parsePorcelainStatusZ,
} from '../../src/plugins/review-context-builder.js';
import type { ResolvedChimeraConfig } from '../../src/plugins/chimera-plugin.js';
import { createBoard } from '@wrongstack/kanban';

const MOCK_CONFIG: ResolvedChimeraConfig = {
  enabled: true,
  provider: 'test-provider',
  model: 'test-model',
  maxFiles: 15,
  autoFix: 'off',
};

let tmpDir: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' },
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
    // Create a file with a very large change
    const largeContent = 'x'.repeat(100_000) + '\n';
    await fsp.writeFile(path.join(tmpDir, 'initial.txt'), largeContent);
    git(['add', 'initial.txt'], tmpDir);

    const result = await buildReviewContext({
      cwd: tmpDir,
      config: MOCK_CONFIG,
      files: [{ path: 'initial.txt', status: 'modified', content: largeContent }],
    });

    const diff = result.files[0]!.diff;
    expect(diff).toBeDefined();
    // Should be capped at ~50KB + truncation notice
    expect(diff!.length).toBeLessThan(52_000);
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
            { id: 'criterion-1', description: 'Unicode paths are preserved', type: 'manual', status: 'pending' },
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
});
