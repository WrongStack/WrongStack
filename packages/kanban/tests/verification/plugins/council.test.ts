/**
 * Tests for CouncilVerifierPlugin — escalation verifier contract.
 *
 * Coverage targets:
 * - id and kind accessors
 * - canHandle('council') returns true
 * - canHandle(other types) returns false
 * - verify returns a structured KanbanVerificationCheckResult
 * - verify result includes status, evidence, description
 */
import { describe, expect, it } from 'vitest';
import { CouncilVerifierPlugin } from '../../../src/verification/plugins/council.js';
import type { KanbanCheck } from '../../../src/types.js';
import type { VerificationContext } from '../../../src/verification/verification-context.js';

describe('CouncilVerifierPlugin', () => {
  const plugin = new CouncilVerifierPlugin();

  it('has the correct id', () => {
    expect(plugin.id).toBe('council');
  });

  it('has kind "escalation"', () => {
    expect(plugin.kind).toBe('escalation');
  });

  describe('canHandle', () => {
    it('returns true for "council" check type', () => {
      expect(plugin.canHandle('council')).toBe(true);
    });

    it('returns false for other check types', () => {
      expect(plugin.canHandle('file_exists')).toBe(false);
      expect(plugin.canHandle('test')).toBe(false);
      expect(plugin.canHandle('agent')).toBe(false);
      expect(plugin.canHandle('')).toBe(false);
      expect(plugin.canHandle('command')).toBe(false);
    });
  });

  describe('verify', () => {
    const mockCheck: KanbanCheck = {
      id: 'council-check-1',
      type: 'council',
      description: 'Verify architectural consistency',
    } as unknown as KanbanCheck;

    const mockContext = {
      projectRoot: '/fake/project',
      board: {} as any,
      task: {} as any,
      requireBackingEvidence: true,
    } as VerificationContext;

    it('returns a structured result with checkId', async () => {
      const result = await plugin.verify(mockCheck, mockContext);
      expect(result).toHaveProperty('checkId', 'council-check-1');
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
