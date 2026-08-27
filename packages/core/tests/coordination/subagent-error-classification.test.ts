/**
 * D1 — SubagentError classifier coverage. Validates that the
 * coordinator's `classifySubagentError` lifts every distinct failure
 * mode out of the legacy "everything is `failed` with a string
 * message" bucket. These tests are deliberately wider than they are
 * deep — each kind gets a single happy-path assertion proving the
 * mapping; integration coverage lives in the runner / delegate
 * tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeAgentSubagentRunner } from '../../src/coordination/agent-subagent-runner.js';
import {
  classifySubagentError,
  DefaultMultiAgentCoordinator,
} from '../../src/coordination/multi-agent-coordinator.js';
import { BudgetExceededError } from '../../src/coordination/subagent-budget.js';
import type { Agent, RunResult } from '../../src/core/agent.js';
import { EventBus } from '../../src/kernel/events.js';
import type { TaskResult } from '../../src/types/multi-agent.js';
import { ProviderError } from '../../src/types/provider.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

// ──────────────────────────────────────────────────────────────────────
// Direct classifier unit tests — each kind gets one anchor case.
// ──────────────────────────────────────────────────────────────────────

describe('classifySubagentError — direct mapping', () => {
  it('429 → provider_rate_limit with backoff and retryable:true', () => {
    const err = new ProviderError('rate limited', 429, true, 'anthropic');
    const out = classifySubagentError(err);
    expect(out.kind).toBe('provider_rate_limit');
    expect(out.retryable).toBe(true);
    expect(out.backoffMs).toBeGreaterThan(0);
    expect(out.cause?.name).toBe('ProviderError');
  });

  it('503 → provider_5xx, retryable with backoff', () => {
    const err = new ProviderError('server overloaded', 503, true, 'openai');
    const out = classifySubagentError(err);
    expect(out.kind).toBe('provider_5xx');
    expect(out.retryable).toBe(true);
    expect(out.backoffMs).toBeGreaterThan(0);
  });

  it('401 → provider_auth, NOT retryable', () => {
    const err = new ProviderError('bad key', 401, false, 'groq');
    const out = classifySubagentError(err);
    expect(out.kind).toBe('provider_auth');
    expect(out.retryable).toBe(false);
    expect(out.backoffMs).toBeUndefined();
  });

  it('408 → provider_timeout, retryable', () => {
    const err = new ProviderError('request timeout', 408, true, 'anthropic');
    const out = classifySubagentError(err);
    expect(out.kind).toBe('provider_timeout');
    expect(out.retryable).toBe(true);
  });

  it('400 provider errors preserve invalid-request detail in the surfaced message', () => {
    const err = new ProviderError('anthropic HTTP 400', 400, false, 'anthropic', {
      body: {
        type: 'invalid_request_error',
        message: 'tools.3.input_schema.properties.foo.type is required',
        requestId: 'req_1234567890',
      },
    });
    const out = classifySubagentError(err);
    expect(out.kind).toBe('unknown');
    expect(out.retryable).toBe(false);
    expect(out.message).toContain('anthropic invalid request (400)');
    expect(out.message).toContain('tools.3.input_schema');
    expect(out.message).toContain('[req req_1234567890]');
  });

  it('429 with a Retry-After hint uses it as the backoff instead of the 5s default', () => {
    const err = new ProviderError('rate limited', 429, true, 'anthropic', {
      body: { retryAfterMs: 12_000 },
    });
    const out = classifySubagentError(err);
    expect(out.kind).toBe('provider_rate_limit');
    expect(out.backoffMs).toBe(12_000);
  });

  it('400 context-overflow ProviderError → context_overflow, NOT unknown', () => {
    const err = new ProviderError('anthropic HTTP 400', 400, false, 'anthropic', {
      body: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens' },
    });
    const out = classifySubagentError(err);
    expect(out.kind).toBe('context_overflow');
    expect(out.retryable).toBe(false);
  });

  it('network failure (status 0) → provider_timeout, retryable', () => {
    const err = new ProviderError('fetch failed', 0, true, 'openai');
    const out = classifySubagentError(err);
    expect(out.kind).toBe('provider_timeout');
    expect(out.retryable).toBe(true);
  });

  it('BudgetExceededError(iterations) → budget_iterations', () => {
    const err = new BudgetExceededError('iterations', 10, 11);
    const out = classifySubagentError(err);
    expect(out.kind).toBe('budget_iterations');
    expect(out.retryable).toBe(false);
  });

  it('BudgetExceededError(tool_calls) → budget_tool_calls', () => {
    const err = new BudgetExceededError('tool_calls', 5, 6);
    const out = classifySubagentError(err);
    expect(out.kind).toBe('budget_tool_calls');
  });

  it('BudgetExceededError(timeout) → budget_timeout', () => {
    const err = new BudgetExceededError('timeout', 1000, 1001);
    const out = classifySubagentError(err);
    expect(out.kind).toBe('budget_timeout');
  });

  it('BudgetExceededError(tokens) → budget_tokens', () => {
    const err = new BudgetExceededError('tokens', 1000, 1001);
    const out = classifySubagentError(err);
    expect(out.kind).toBe('budget_tokens');
  });

  it('"agent aborted" message → aborted_by_parent', () => {
    const err = new Error('agent aborted');
    const out = classifySubagentError(err);
    expect(out.kind).toBe('aborted_by_parent');
    expect(out.retryable).toBe(false);
  });

  it('hints.parentAborted=true → aborted_by_parent (even with a different message)', () => {
    const err = new Error('something went sideways');
    const out = classifySubagentError(err, { parentAborted: true });
    expect(out.kind).toBe('aborted_by_parent');
  });

  it('"agent exhausted iteration limit" → budget_iterations', () => {
    const err = new Error('agent exhausted iteration limit');
    const out = classifySubagentError(err);
    expect(out.kind).toBe('budget_iterations');
  });

  it('"empty response" → empty_response', () => {
    const err = new Error('empty response');
    const out = classifySubagentError(err);
    expect(out.kind).toBe('empty_response');
  });

  it('"context length exceeded" → context_overflow', () => {
    const err = new Error('Prompt is too long: max tokens exceeded');
    const out = classifySubagentError(err);
    expect(out.kind).toBe('context_overflow');
  });

  it('Bridge transport message → bridge_failed', () => {
    const err = new Error('Bridge transport closed unexpectedly');
    const out = classifySubagentError(err);
    expect(out.kind).toBe('bridge_failed');
  });

  it('unrecognised error → unknown with cause preserved', () => {
    const err = new Error('something totally novel');
    const out = classifySubagentError(err);
    expect(out.kind).toBe('unknown');
    expect(out.retryable).toBe(false);
    expect(out.cause?.message).toBe('something totally novel');
    expect(out.cause?.name).toBe('Error');
  });

  it('non-Error throw (string) → unknown without cause', () => {
    const out = classifySubagentError('plain string failure');
    expect(out.kind).toBe('unknown');
    expect(out.message).toBe('plain string failure');
    expect(out.cause).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Integration: end-to-end run that surfaces the classified error
// through TaskResult.error so consumers see structured envelopes.
// ──────────────────────────────────────────────────────────────────────

function makeStubAgent(behavior: () => Promise<RunResult>): { agent: Agent; events: EventBus } {
  const events = new EventBus();
  const agent = {
    async run(_input: unknown, _opts: { signal: AbortSignal }): Promise<RunResult> {
      return behavior();
    },
  } as Agent;
  return { agent, events };
}

function waitForCompletion(
  coord: DefaultMultiAgentCoordinator,
  timeoutMs = 2000,
): Promise<TaskResult> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`task did not complete within ${timeoutMs}ms`)),
      timeoutMs,
    );
    coord.once('task.completed', (e: { result: TaskResult }) => {
      clearTimeout(t);
      resolve(e.result);
    });
  });
}

describe('TaskResult.error envelope through the runner', () => {
  it('T2: empty LLM response surfaces as empty_response kind, not silent success', async () => {
    // Agent returns success with no text AND no tool calls — should
    // be classified as empty_response, NOT collapsed into a clean
    // success that hides the wasted iteration.
    const factory = vi.fn(async () =>
      makeStubAgent(async () => ({
        status: 'done',
        iterations: 1,
        finalText: '',
      })),
    );
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(
      {
        coordinatorId: 'c',
        doneCondition: { type: 'all_tasks_done' as const },
        maxConcurrent: 1,
      },
      { runner, sessionId: TEST_SESSION_ID },
    );
    await coord.spawn({ id: 'a', name: 'A' });
    const done = waitForCompletion(coord);
    await coord.assign({ id: 't', description: 'do nothing' });
    const r = await done;

    expect(r.status).toBe('failed');
    expect(r.error?.kind).toBe('empty_response');
    expect(r.error?.retryable).toBe(false);
  });

  it('T1: ProviderError(503) thrown inside agent surfaces as provider_5xx with backoff', async () => {
    const factory = vi.fn(async () =>
      makeStubAgent(async () => ({
        status: 'failed',
        error: new ProviderError('overloaded', 503, true, 'anthropic'),
        iterations: 0,
      })),
    );
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(
      {
        coordinatorId: 'c',
        doneCondition: { type: 'all_tasks_done' as const },
        maxConcurrent: 1,
      },
      { runner, sessionId: TEST_SESSION_ID },
    );
    await coord.spawn({ id: 'a', name: 'A' });
    const done = waitForCompletion(coord);
    await coord.assign({ id: 't', description: 'fetch the world' });
    const r = await done;

    expect(r.status).toBe('failed');
    expect(r.error?.kind).toBe('provider_5xx');
    expect(r.error?.retryable).toBe(true);
    expect(r.error?.backoffMs).toBeGreaterThan(0);
  });

  it('T2-b: ProviderError(429) → provider_rate_limit with backoff', async () => {
    const factory = vi.fn(async () =>
      makeStubAgent(async () => ({
        status: 'failed',
        error: new ProviderError('rate limited', 429, true, 'openai'),
        iterations: 0,
      })),
    );
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(
      {
        coordinatorId: 'c',
        doneCondition: { type: 'all_tasks_done' as const },
        maxConcurrent: 1,
      },
      { runner, sessionId: TEST_SESSION_ID },
    );
    await coord.spawn({ id: 'a', name: 'A' });
    const done = waitForCompletion(coord);
    await coord.assign({ id: 't', description: 'fetch' });
    const r = await done;

    expect(r.error?.kind).toBe('provider_rate_limit');
    expect(r.error?.backoffMs).toBeGreaterThan(0);
  });

  it('hint propagation: cause field carries original stack for diagnostics', async () => {
    const factory = vi.fn(async () =>
      makeStubAgent(async () => ({
        status: 'failed',
        error: new TypeError('cannot read property foo of undefined'),
        iterations: 0,
      })),
    );
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(
      {
        coordinatorId: 'c',
        doneCondition: { type: 'all_tasks_done' as const },
        maxConcurrent: 1,
      },
      { runner, sessionId: TEST_SESSION_ID },
    );
    await coord.spawn({ id: 'a', name: 'A' });
    const done = waitForCompletion(coord);
    await coord.assign({ id: 't', description: 'crash' });
    const r = await done;

    // No specific kind matches — falls into unknown, but cause is preserved.
    expect(r.error?.kind).toBe('unknown');
    expect(r.error?.cause?.name).toBe('TypeError');
    expect(r.error?.cause?.message).toContain('cannot read property');
  });
});
