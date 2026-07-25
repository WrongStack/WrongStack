/**
 * Tests for AgentVerifierPlugin — escalation verifier contract.
 *
 * Coverage targets:
 * - id and kind accessors
 * - canHandle('agent') returns true
 * - canHandle(other types) returns false
 * - verify returns a properly structured KanbanVerificationCheckResult
 * - verify result includes status and evidence
 */
import { describe, expect, it } from 'vitest';
import { AgentVerifierPlugin } from '../../../src/verification/plugins/agent.js';
import type { KanbanCheck } from '../../../src/types.js';
import type { VerificationContext } from '../../../src/verification/verification-context.js';

describe('AgentVerifierPlugin', () => {
  const plugin = new AgentVerifierPlugin();

  it('has the correct id', () => {
    expect(plugin.id).toBe('agent');
  });

  it('has kind "escalation"', () => {
    expect(plugin.kind).toBe('escalation');
  });

  describe('canHandle', () => {
    it('returns true for "agent" check type', () => {
      expect(plugin.canHandle('agent')).toBe(true);
    });

    it('returns false for other check types', () => {
      expect(plugin.canHandle('file_exists')).toBe(false);
      expect(plugin.canHandle('test')).toBe(false);
      expect(plugin.canHandle('git_diff')).toBe(false);
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
      id: 'check-1',
      type: 'agent',
      description: 'Verify the implementation is correct',
    } as unknown as KanbanCheck;

    const mockContext = {
      projectRoot: '/fake/project',
      board: {} as any,
      task: {} as any,
      requireBackingEvidence: true,
    } as VerificationContext;

    it('returns a structured result with checkId', async () => {
      const result = await plugin.verify(mockCheck, mockContext);
      expect(result).toHaveProperty('checkId', 'check-1');
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
