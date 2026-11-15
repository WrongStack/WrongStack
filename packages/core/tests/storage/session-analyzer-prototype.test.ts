import { describe, expect, it } from 'vitest';
import { SessionAnalyzer } from '../../src/storage/session-analyzer.js';

describe('SessionAnalyzer prototype key safety (F374)', () => {
  it('counts tool names colliding with Object.prototype keys like "toString" numerically', () => {
    const analyzer = new SessionAnalyzer();
    const res = analyzer.analyze([
      { type: 'session_start', id: 's1', ts: new Date().toISOString() },
      { type: 'tool_use', name: 'toString', id: 't1', input: {}, ts: new Date().toISOString() },
    ] as never);
    expect(res.toolUsageCount['toString']).toBe(1);
  });
});
