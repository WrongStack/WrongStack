import { describe, expect, it } from 'vitest';
import type { ToolUseBlock } from '../../src/types/blocks.js';
import { ToolErrorCategory } from '../../src/types/tool.js';
import {
  classifiedToolErrorResult,
  getToolErrorInfo,
  toolErrorResult,
} from '../../src/execution/tool-error-taxonomy.js';

const mockUse: ToolUseBlock = {
  type: 'tool_use',
  id: 'test-1',
  name: 'read',
  input: { path: 'test.ts' },
};

describe('toolErrorResult', () => {
  it('classifies a network error as transient + retryable', () => {
    const err = new Error('ETIMEDOUT');
    (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';

    const block = toolErrorResult(mockUse, err);

    expect(block.is_error).toBe(true);
    expect(block.content).toContain('Transient error');
    expect(block.content).toContain('retryable');
    expect(block.content).toContain('ETIMEDOUT');

    const info = getToolErrorInfo(block);
    expect(info?.category).toBe(ToolErrorCategory.TRANSIENT);
    expect(info?.retryable).toBe(true);
    expect(info?.detail).toBe('ETIMEDOUT');
  });

  it('classifies ENOENT as not_found + not retryable', () => {
    const err = new Error('ENOENT');
    (err as NodeJS.ErrnoException).code = 'ENOENT';

    const block = toolErrorResult(mockUse, err);

    expect(block.content).toContain('Not found');
    expect(block.content).not.toContain('retryable');

    const info = getToolErrorInfo(block);
    expect(info?.category).toBe(ToolErrorCategory.NOT_FOUND);
    expect(info?.retryable).toBe(false);
  });

  it('classifies EACCES as permission + not retryable', () => {
    const err = new Error('EACCES');
    (err as NodeJS.ErrnoException).code = 'EACCES';

    const block = toolErrorResult(mockUse, err);

    const info = getToolErrorInfo(block);
    expect(info?.category).toBe(ToolErrorCategory.PERMISSION);
  });

  it('classifies AbortError as fatal + not retryable', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';

    const block = toolErrorResult(mockUse, err);

    const info = getToolErrorInfo(block);
    expect(info?.category).toBe(ToolErrorCategory.FATAL);
    expect(info?.retryable).toBe(false);
    expect(info?.detail).toBe('aborted');
  });

  it('applies scrubber to user message', () => {
    const err = new Error('secret-key-123 in output');
    const block = toolErrorResult(mockUse, err, {
      scrubber: (s) => s.replace(/secret-key-\d+/g, '[REDACTED]'),
    });

    expect(block.content).toContain('[REDACTED]');
    // The content prefix + scrubbed message should not contain the secret
    const contentWithoutDetail = block.content.split(' [')[0];
    expect(contentWithoutDetail).not.toContain('secret-key-123');
  });

  it('handles string errors', () => {
    const block = toolErrorResult(mockUse, 'something went wrong');

    expect(block.is_error).toBe(true);
    expect(block.content).toContain('something went wrong');
  });

  it('handles unknown error types', () => {
    const block = toolErrorResult(mockUse, { random: 'object' });

    expect(block.is_error).toBe(true);
    const info = getToolErrorInfo(block);
    expect(info?.category).toBe(ToolErrorCategory.FATAL);
  });
});

describe('classifiedToolErrorResult', () => {
  it('creates a permission-denied result', () => {
    const block = classifiedToolErrorResult(
      mockUse,
      ToolErrorCategory.PERMISSION,
      'blocked by policy',
    );

    expect(block.content).toContain('Permission denied');
    expect(block.content).toContain('blocked by policy');

    const info = getToolErrorInfo(block);
    expect(info?.category).toBe(ToolErrorCategory.PERMISSION);
    expect(info?.retryable).toBe(false);
  });

  it('creates a validation error result with detail', () => {
    const block = classifiedToolErrorResult(
      mockUse,
      ToolErrorCategory.VALIDATION,
      'missing required field',
      {
        detail: 'path is required',
      },
    );

    expect(block.content).toContain('Validation error');
    expect(block.content).toContain('[path is required]');

    const info = getToolErrorInfo(block);
    expect(info?.category).toBe(ToolErrorCategory.VALIDATION);
    expect(info?.detail).toBe('path is required');
  });

  it('infers retryable for transient', () => {
    const block = classifiedToolErrorResult(
      mockUse,
      ToolErrorCategory.TRANSIENT,
      'network timeout',
    );

    const info = getToolErrorInfo(block);
    expect(info?.retryable).toBe(true);
  });
});

describe('getToolErrorInfo', () => {
  it('returns undefined for non-error blocks', () => {
    const block = { type: 'tool_result' as const, tool_use_id: 'x', content: 'ok' };
    expect(getToolErrorInfo(block)).toBeUndefined();
  });

  it('returns undefined for error blocks without the extension', () => {
    const block = {
      type: 'tool_result' as const,
      tool_use_id: 'x',
      content: 'failed',
      is_error: true,
    };
    expect(getToolErrorInfo(block)).toBeUndefined();
  });
});
