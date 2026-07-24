import { describe, expect, it, vi } from 'vitest';
import type { TranscriptEvalSpec } from '../src/types.js';

const readSessionLogEvents = vi.hoisted(() => vi.fn());

vi.mock('../src/session-metrics.js', () => ({ readSessionLogEvents }));

import { evaluateTraceEval } from '../src/trace-eval.js';

describe('trace eval non-JSON runtime values', () => {
  it('falls back to String when a tool result cannot be JSON serialized', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    readSessionLogEvents.mockResolvedValue([
      { type: 'tool_use', id: 'read-1', name: 'read', input: {} },
      { type: 'tool_result', id: 'read-1', content: circular },
    ]);
    const spec: TranscriptEvalSpec = {
      source: {
        sessionId: 'source',
        transcriptPath: 'source.jsonl',
        sha256: 'a'.repeat(64),
        eventStart: 0,
        eventEnd: 1,
      },
      retrieval: [{ toolNames: ['read'], contains: '[object Object]' }],
      recall: { inputContains: ['never'] },
    };

    const result = await evaluateTraceEval({
      homeDir: '/home',
      workdir: '/work',
      spec,
    });

    expect(result.retrievalPassed).toBe(true);
  });
});
