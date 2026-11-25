import { describe, expect, it } from 'vitest';
import { classifiedToolErrorResult } from '../src/execution/tool-error-taxonomy.js';

describe('classifiedToolErrorResult prototype category guard', () => {
  it('falls back to Error instead of leaking Object.prototype properties', () => {
    const res = classifiedToolErrorResult(
      { type: 'tool_use', id: 'u1', name: 'bash', input: {} },
      'toString' as never,
      'boom',
    );
    expect(res.content).toBe('Error: boom');
  });
});
