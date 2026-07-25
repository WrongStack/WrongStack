/**
 * Tests for MetricPlugin — deterministic verifier contract.
 *
 * Coverage targets:
 * - id and kind accessors
 * - canHandle('metric') returns true
 * - canHandle(other types) returns false
 * - verify returns a structured KanbanVerificationCheckResult
 */
import { describe, expect, it } from 'vitest';
import { MetricPlugin } from '../../../src/verification/plugins/metric.js';
import type { KanbanCheck } from '../../../src/types.js';
import type { VerificationContext } from '../../../src/verification/verification-context.js';

describe('MetricPlugin', () => {
  const plugin = new MetricPlugin();

  it('has the correct id', () => {
    expect(plugin.id).toBe('metric');
  });

  it('has kind "deterministic"', () => {
    expect(plugin.kind).toBe('deterministic');
  });

  describe('canHandle', () => {
    it('returns true for "metric" check type', () => {
      expect(plugin.canHandle('metric')).toBe(true);
    });

    it('returns false for other check types', () => {
      expect(plugin.canHandle('file_exists')).toBe(false);
      expect(plugin.canHandle('git_diff')).toBe(false);
      expect(plugin.canHandle('test')).toBe(false);
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
      id: 'metric-check-1',
      type: 'metric',
      description: 'Verify goal metrics met',
    } as unknown as KanbanCheck;

    const mockContext = {
      projectRoot: '/fake/project',
      board: {} as any,
      task: {} as any,
      requireBackingEvidence: false,
    } as VerificationContext;

    it('returns a structured result with checkId', async () => {
      const result = await plugin.verify(mockCheck, mockContext);
      expect(result).toHaveProperty('checkId', 'metric-check-1');
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
