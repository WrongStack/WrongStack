/**
 * Tests for GitDiffPlugin — deterministic verifier contract.
 *
 * Coverage targets:
 * - id and kind accessors
 * - canHandle('git_diff') returns true
 * - canHandle(other types) returns false
 * - verify returns a structured KanbanVerificationCheckResult
 * - verify result includes status, evidence, description
 */
import { describe, expect, it } from 'vitest';
import { GitDiffPlugin } from '../../../src/verification/plugins/git-diff.js';
import type { KanbanCheck } from '../../../src/types.js';
import type { VerificationContext } from '../../../src/verification/verification-context.js';

describe('GitDiffPlugin', () => {
  const plugin = new GitDiffPlugin();

  it('has the correct id', () => {
    expect(plugin.id).toBe('git_diff');
  });

  it('has kind "deterministic"', () => {
    expect(plugin.kind).toBe('deterministic');
  });

  describe('canHandle', () => {
    it('returns true for "git_diff" check type', () => {
      expect(plugin.canHandle('git_diff')).toBe(true);
    });

    it('returns false for other check types', () => {
      expect(plugin.canHandle('file_exists')).toBe(false);
      expect(plugin.canHandle('test')).toBe(false);
      expect(plugin.canHandle('agent')).toBe(false);
      expect(plugin.canHandle('')).toBe(false);
      expect(plugin.canHandle('council')).toBe(false);
    });

    it('returns false for undefined/null', () => {
      expect(plugin.canHandle(undefined as unknown as string)).toBe(false);
      expect(plugin.canHandle(null as unknown as string)).toBe(false);
    });
  });

  describe('verify', () => {
    function mockCheck(overrides?: Partial<KanbanCheck>): KanbanCheck {
      return {
        id: 'git-diff-check-1',
        type: 'git_diff',
        description: 'Verify the working tree diff',
        ...overrides,
      } as unknown as KanbanCheck;
    }

    function mockContext(overrides?: {
      diffSince?: () => Promise<any[]>;
      gitStatus?: () => Promise<any>;
    }): VerificationContext {
      return {
        projectRoot: '/fake/project',
        board: {} as any,
        task: {} as any,
        requireBackingEvidence: false,
        diffSince: overrides?.diffSince ?? (async () => []),
        gitStatus: overrides?.gitStatus ?? (async () => ({ files: [], ahead: 0, behind: 0 })),
        readFile: async () => '',
      } as unknown as VerificationContext;
    }

    it('returns a structured result with checkId', async () => {
      const result = await plugin.verify(mockCheck(), mockContext());
      expect(result).toHaveProperty('checkId', 'git-diff-check-1');
    });

    it('returns a result with status and evidence fields', async () => {
      const result = await plugin.verify(mockCheck(), mockContext());
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('evidence');
      expect(result).toHaveProperty('description');
    });

    it('returns a structured result (not thrown)', async () => {
      const result = await plugin.verify(mockCheck(), mockContext());
      expect(result).toBeDefined();
    });

    it('fails when git status has an error', async () => {
      const result = await plugin.verify(
        mockCheck(),
        mockContext({
          diffSince: async () => [
            { path: 'src/test.ts', operation: 'modify', linesAdded: 5, linesRemoved: 0 },
          ],
          gitStatus: async () => ({
            clean: false,
            untracked: 0,
            unstaged: 0,
            staged: 0,
            files: [],
            error: 'Not a git repository',
          }),
        }),
      );
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Not a git repository');
    });

    it('fails when no file changes are detected and working tree is clean', async () => {
      const result = await plugin.verify(
        mockCheck(),
        mockContext({
          diffSince: async () => [],
          gitStatus: async () => ({
            clean: true,
            untracked: 0,
            unstaged: 0,
            staged: 0,
            files: [],
            error: undefined,
          }),
        }),
      );
      expect(result.status).toBe('failed');
      expect(result.error).toContain('No file changes detected');
    });

    it('fails when expected files are missing from diff', async () => {
      const result = await plugin.verify(
        mockCheck({
          notes: JSON.stringify({ expectedFiles: ['src/missing.ts', 'src/also-missing.tsx'] }),
        }),
        mockContext({
          diffSince: async () => [
            { path: 'src/unrelated.ts', operation: 'modify', linesAdded: 1, linesRemoved: 0 },
          ],
          gitStatus: async () => ({
            clean: false,
            untracked: 0,
            unstaged: 1,
            staged: 0,
            files: ['src/unrelated.ts'],
          }),
        }),
      );
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Expected changes in files not found');
      expect(result.error).toContain('src/missing.ts');
      expect(result.error).toContain('src/also-missing.tsx');
    });

    it('passes when all expected files are in the diff', async () => {
      const result = await plugin.verify(
        mockCheck({ notes: JSON.stringify({ expectedFiles: ['src/expected.ts'] }) }),
        mockContext({
          diffSince: async () => [
            { path: 'src/expected.ts', operation: 'modify', linesAdded: 10, linesRemoved: 2 },
          ],
          gitStatus: async () => ({
            clean: false,
            untracked: 0,
            unstaged: 1,
            staged: 0,
            files: ['src/expected.ts'],
          }),
        }),
      );
      expect(result.status).toBe('passed');
    });

    it('fails when minChanges threshold is not met', async () => {
      const result = await plugin.verify(
        mockCheck({ notes: JSON.stringify({ minChanges: 10 }) }),
        mockContext({
          diffSince: async () => [
            { path: 'src/test.ts', operation: 'modify', linesAdded: 3, linesRemoved: 2 },
          ],
          gitStatus: async () => ({
            clean: false,
            untracked: 0,
            unstaged: 1,
            staged: 0,
            files: ['src/test.ts'],
          }),
        }),
      );
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Expected at least 10 lines changed');
    });

    it('fails when maxChanges threshold is exceeded', async () => {
      const result = await plugin.verify(
        mockCheck({ notes: JSON.stringify({ maxChanges: 5 }) }),
        mockContext({
          diffSince: async () => [
            { path: 'src/test.ts', operation: 'modify', linesAdded: 6, linesRemoved: 0 },
          ],
          gitStatus: async () => ({
            clean: false,
            untracked: 0,
            unstaged: 1,
            staged: 0,
            files: ['src/test.ts'],
          }),
        }),
      );
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Expected at most 5 lines changed');
    });

    it('passes when changes are within min/max thresholds', async () => {
      const result = await plugin.verify(
        mockCheck({ notes: JSON.stringify({ minChanges: 3, maxChanges: 20 }) }),
        mockContext({
          diffSince: async () => [
            { path: 'src/test.ts', operation: 'modify', linesAdded: 5, linesRemoved: 3 },
          ],
          gitStatus: async () => ({
            clean: false,
            untracked: 0,
            unstaged: 1,
            staged: 0,
            files: ['src/test.ts'],
          }),
        }),
      );
      expect(result.status).toBe('passed');
    });

    it('handles invalid JSON config gracefully', async () => {
      const result = await plugin.verify(
        mockCheck({ notes: 'not-json' }),
        mockContext({
          diffSince: async () => [
            { path: 'src/test.ts', operation: 'modify', linesAdded: 1, linesRemoved: 0 },
          ],
          gitStatus: async () => ({
            clean: false,
            untracked: 0,
            unstaged: 1,
            staged: 0,
            files: ['src/test.ts'],
          }),
        }),
      );
      // Should not crash, should pass since there are changes
      expect(result.status).toBe('passed');
    });

    it('handles empty notes gracefully', async () => {
      const result = await plugin.verify(
        mockCheck({ notes: '' }),
        mockContext({
          diffSince: async () => [
            { path: 'src/test.ts', operation: 'modify', linesAdded: 1, linesRemoved: 0 },
          ],
          gitStatus: async () => ({
            clean: false,
            untracked: 0,
            unstaged: 1,
            staged: 0,
            files: ['src/test.ts'],
          }),
        }),
      );
      expect(result.status).toBe('passed');
    });

    it('includes working tree status in evidence', async () => {
      const result = await plugin.verify(
        mockCheck(),
        mockContext({
          diffSince: async () => [
            { path: 'src/test.ts', operation: 'modify', linesAdded: 1, linesRemoved: 0 },
          ],
          gitStatus: async () => ({
            clean: false,
            untracked: 2,
            unstaged: 3,
            staged: 1,
            files: ['src/test.ts', 'other.ts'],
          }),
        }),
      );
      expect(result.evidence).toHaveProperty('workingTree');
      expect(result.evidence['workingTree']).toMatchObject({
        clean: false,
        untracked: 2,
        unstaged: 3,
        staged: 1,
      });
    });

    it('reports create/modify/delete counts', async () => {
      const result = await plugin.verify(
        mockCheck(),
        mockContext({
          diffSince: async () => [
            { path: 'src/new.ts', operation: 'create' as const, linesAdded: 10, linesRemoved: 0 },
            {
              path: 'src/changed.ts',
              operation: 'modify' as const,
              linesAdded: 5,
              linesRemoved: 3,
            },
            {
              path: 'src/removed.ts',
              operation: 'delete' as const,
              linesAdded: 0,
              linesRemoved: 8,
            },
          ],
          gitStatus: async () => ({
            clean: false,
            untracked: 0,
            unstaged: 3,
            staged: 0,
            files: [],
          }),
        }),
      );
      expect(result.evidence['filesChanged']).toBe(3);
      expect(result.evidence['added']).toBe(1);
      expect(result.evidence['modified']).toBe(1);
      expect(result.evidence['deleted']).toBe(1);
    });
  });
});
