import { describe, expect, it } from 'vitest';
import { aggregateCell } from '../src/aggregate.js';
import type { ModelCell, TaskResult } from '../src/types.js';

const cell: ModelCell = { label: 'opus', provider: 'anthropic', model: 'claude-opus-4-8' };

function result(over: Partial<TaskResult> & { passed: boolean }): TaskResult {
  return {
    taskId: over.taskId ?? 't',
    cell,
    run: {
      status: 'completed',
      finalText: null,
      iterations: 1,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      elapsedMs: 100,
      exitCode: 0,
      ...over.run,
    },
    grade: { passed: over.passed },
    tools: { totalCalls: 1, editCalls: 0, editErrors: 0, rateLimitRetries: 0, ...over.tools },
    traceEval: over.traceEval,
  };
}

describe('aggregateCell — trace-eval edge cases', () => {
  it('produces undefined recallGivenRetrieval when no trace passed retrieval', () => {
    // All traces have retrievalPassed: false → recallEligible is empty
    // → recallGivenRetrieval.rate is undefined → editApplicationGivenRecall.rate is undefined
    const agg = aggregateCell(cell, [
      result({
        taskId: 'a',
        passed: false,
        traceEval: {
          sourceSessionId: 's1',
          retrievalPassed: false,
          recallPassed: false,
          editApplicationPassed: false,
        },
      }),
      result({
        taskId: 'b',
        passed: false,
        traceEval: {
          sourceSessionId: 's2',
          retrievalPassed: false,
          recallPassed: true, // Recall passed but retrieval didn't — should not matter for funnel
          editApplicationPassed: true,
        },
      }),
    ]);

    expect(agg.traceEval).toBeDefined();
    expect(agg.traceEval!.retrieval).toEqual({ eligible: 2, passed: 0, rate: 0 });
    // recallEligible is empty → eligible=0 → rate=undefined
    expect(agg.traceEval!.recallGivenRetrieval).toEqual({
      eligible: 0,
      passed: 0,
      rate: undefined,
    });
    // applicationEligible is empty → eligible=0 → rate=undefined
    expect(agg.traceEval!.editApplicationGivenRecall).toEqual({
      eligible: 0,
      passed: 0,
      rate: undefined,
    });
  });

  it('produces undefined editApplicationGivenRecall when no trace passed recall', () => {
    // All traces pass retrieval but fail recall → applicationEligible is empty
    const agg = aggregateCell(cell, [
      result({
        taskId: 'a',
        passed: false,
        traceEval: {
          sourceSessionId: 's1',
          retrievalPassed: true,
          recallPassed: false,
          editApplicationPassed: false,
        },
      }),
    ]);

    expect(agg.traceEval).toBeDefined();
    expect(agg.traceEval!.retrieval).toEqual({ eligible: 1, passed: 1, rate: 1 });
    expect(agg.traceEval!.recallGivenRetrieval).toEqual({ eligible: 1, passed: 0, rate: 0 });
    // applicationEligible is empty → eligible=0 → rate=undefined
    expect(agg.traceEval!.editApplicationGivenRecall).toEqual({
      eligible: 0,
      passed: 0,
      rate: undefined,
    });
  });

  it('omits traceEval from the result when no trace data is present', () => {
    const agg = aggregateCell(cell, [result({ taskId: 'a', passed: true })]);
    expect(agg.traceEval).toBeUndefined();
  });
});
