/**
 * Tests for FileMatchesPlugin — deterministic verifier contract.
 *
 * Coverage targets:
 * - id and kind accessors
 * - canHandle('file_matches') returns true
 * - canHandle(other types) returns false
 * - verify returns a structured KanbanVerificationCheckResult
 */
import { describe, expect, it } from 'vitest';
import { FileMatchesPlugin } from '../../../src/verification/plugins/file-matches.js';
import type { KanbanCheck } from '../../../src/types.js';
import type { VerificationContext } from '../../../src/verification/verification-context.js';

describe('FileMatchesPlugin', () => {
  const plugin = new FileMatchesPlugin();

  it('has the correct id', () => {
    expect(plugin.id).toBe('file_matches');
  });

  it('has kind "deterministic"', () => {
    expect(plugin.kind).toBe('deterministic');
  });

  describe('canHandle', () => {
    it('returns true for "file_matches" check type', () => {
      expect(plugin.canHandle('file_matches')).toBe(true);
    });

    it('returns false for other check types', () => {
      expect(plugin.canHandle('file_exists')).toBe(false);
      expect(plugin.canHandle('test')).toBe(false);
      expect(plugin.canHandle('git_diff')).toBe(false);
      expect(plugin.canHandle('')).toBe(false);
      expect(plugin.canHandle('metric')).toBe(false);
    });

    it('returns false for undefined/null', () => {
      expect(plugin.canHandle(undefined as unknown as string)).toBe(false);
      expect(plugin.canHandle(null as unknown as string)).toBe(false);
    });
  });

  describe('verify', () => {
    const mockCheck: KanbanCheck = {
      id: 'fm-check-1',
      type: 'file_matches',
      description: 'Verify file content matches pattern',
    } as unknown as KanbanCheck;

    const mockContext = {
      projectRoot: '/fake/project',
      board: {} as any,
      task: {} as any,
      requireBackingEvidence: false,
    } as VerificationContext;

    it('returns a structured result with checkId', async () => {
      const result = await plugin.verify(mockCheck, mockContext);
      expect(result).toHaveProperty('checkId', 'fm-check-1');
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
