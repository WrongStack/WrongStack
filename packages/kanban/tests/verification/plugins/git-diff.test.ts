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
    const mockCheck: KanbanCheck = {
      id: 'git-diff-check-1',
      type: 'git_diff',
      description: 'Verify the working tree diff',
    } as unknown as KanbanCheck;

    const mockContext = {
      projectRoot: '/fake/project',
      board: {} as any,
      task: {} as any,
      requireBackingEvidence: false,
      diffSince: async () => [],
      gitStatus: async () => ({ files: [], ahead: 0, behind: 0 }),
      readFile: async () => '',
    } as VerificationContext;

    it('returns a structured result with checkId', async () => {
      const result = await plugin.verify(mockCheck, mockContext);
      expect(result).toHaveProperty('checkId', 'git-diff-check-1');
    });

    it('returns a result with status and evidence fields', async () => {
      const result = await plugin.verify(mockCheck, mockContext);
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('evidence');
      expect(result).toHaveProperty('description');
    });

    it('returns a structured result (not thrown)', async () => {
      const result = await plugin.verify(mockCheck, mockContext);
      expect(result).toBeDefined();
    });
  });
});
