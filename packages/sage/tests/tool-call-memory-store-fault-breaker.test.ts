import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSageToolCallMiddleware } from '../src/middleware/tool-call-memory.js';
import { isStoreFault, StoreFaultBreaker } from '../src/middleware/tool-call-memory-breaker.js';
import type { SageRetrieverLike } from '../src/middleware/tool-call-memory-types.js';

const IO_ERROR = new Error('disk I/O error');

describe('isStoreFault', () => {
  it.each([
    'disk I/O error',
    'SQLITE_IOERR_SHMOPEN',
    'database disk image is malformed',
    'unable to open database file',
    'attempt to write a readonly database',
  ])('treats %j as a storage fault', (message) => {
    expect(isStoreFault(new Error(message))).toBe(true);
  });

  it('does not treat a timeout or an arbitrary failure as a storage fault', () => {
    expect(isStoreFault(new Error('SAGE retrieval exceeded its 5000ms budget'))).toBe(false);
    expect(isStoreFault(new Error('connection closed'))).toBe(false);
    expect(isStoreFault('boom')).toBe(false);
  });
});

describe('StoreFaultBreaker', () => {
  it('opens only after the threshold of consecutive storage faults', () => {
    const breaker = new StoreFaultBreaker({ threshold: 3, cooldownMs: 1_000 });
    expect(breaker.recordFailure(IO_ERROR, 0).tripped).toBe(false);
    expect(breaker.recordFailure(IO_ERROR, 1).tripped).toBe(false);
    expect(breaker.isOpen(2)).toBe(false);
    const third = breaker.recordFailure(IO_ERROR, 2);
    expect(third.tripped).toBe(true);
    expect(third.message).toContain('disk I/O error');
    expect(third.message).toContain('paused for 1s');
    expect(breaker.isOpen(3)).toBe(true);
  });

  it('a success or an unrelated failure resets the streak', () => {
    const breaker = new StoreFaultBreaker({ threshold: 2, cooldownMs: 1_000 });
    breaker.recordFailure(IO_ERROR, 0);
    breaker.recordSuccess();
    expect(breaker.recordFailure(IO_ERROR, 1).tripped).toBe(false);
    breaker.recordFailure(new Error('timeout'), 2);
    expect(breaker.recordFailure(IO_ERROR, 3).tripped).toBe(false);
    expect(breaker.isOpen(4)).toBe(false);
  });

  it('closes after the cooldown and re-opens on the first failed probe', () => {
    const breaker = new StoreFaultBreaker({ threshold: 2, cooldownMs: 1_000 });
    breaker.recordFailure(IO_ERROR, 0);
    expect(breaker.recordFailure(IO_ERROR, 1).tripped).toBe(true);
    expect(breaker.isOpen(500)).toBe(true);
    expect(breaker.isOpen(1_001)).toBe(false);
    // One failed probe is enough; the threshold is not re-counted.
    expect(breaker.recordFailure(IO_ERROR, 1_002).tripped).toBe(true);
    expect(breaker.isOpen(1_003)).toBe(true);
  });

  it('a successful probe keeps the breaker closed', () => {
    const breaker = new StoreFaultBreaker({ threshold: 1, cooldownMs: 1_000 });
    breaker.recordFailure(IO_ERROR, 0);
    expect(breaker.isOpen(1_001)).toBe(false);
    breaker.recordSuccess();
    expect(breaker.isOpen(1_002)).toBe(false);
    expect(breaker.recordFailure(IO_ERROR, 1_003).tripped).toBe(true);
  });
});

function makePayload(): ToolCallPipelinePayload {
  return {
    toolUse: { type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'src/file.ts' } },
    result: { type: 'tool_result', tool_use_id: 'tu1', name: 'read', content: 'file content' },
    ctx: {
      projectRoot: '/proj',
      cwd: '/proj',
      session: { id: 'sess1' },
      signal: new AbortController().signal,
    },
  } as unknown as ToolCallPipelinePayload;
}

describe('SageToolCallMiddleware — unreadable store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(fail: { value: boolean }) {
    const calls = { retrieve: 0 };
    const memory = {
      retrieveForPath: async () => {
        calls.retrieve++;
        if (fail.value) throw IO_ERROR;
        return [];
      },
      searchSage: async () => {
        if (fail.value) throw IO_ERROR;
        return [];
      },
    } as unknown as SageRetrieverLike;
    const events = new EventBus();
    const traces: Array<Record<string, unknown>> = [];
    events.onPattern('memory.injector_run', (_event, payload) => {
      traces.push(payload as Record<string, unknown>);
    });
    const mw = createSageToolCallMiddleware({ memory, events, retrievalTimeoutMs: 0 });
    const run = async () => {
      const payload = makePayload();
      await mw.handler(payload as never, async (p) => p);
      return payload;
    };
    return { run, calls, traces };
  }

  it('stops querying the store after repeated I/O errors, with one explicit trace', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fail = { value: true };
    const { run, calls, traces } = setup(fail);

    for (let i = 0; i < 3; i++) await run();
    expect(calls.retrieve).toBe(3);
    expect(traces).toHaveLength(3);
    expect(String(traces[0]?.['error'])).toBe('disk I/O error');
    expect(String(traces[2]?.['error'])).toContain('memory injection paused');

    // Open: no further queries and no further error rows; the tool result is untouched.
    const payload = await run();
    await run();
    expect(payload.result.content).toBe('file content');
    expect(calls.retrieve).toBe(3);
    expect(traces).toHaveLength(3);
  });

  it('probes once after the cooldown and resumes when the store is readable again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fail = { value: true };
    const { run, calls, traces } = setup(fail);
    for (let i = 0; i < 3; i++) await run();

    fail.value = false;
    vi.setSystemTime(Date.now() + 61_000);
    await run();
    expect(calls.retrieve).toBe(4);
    expect(traces.at(-1)?.['outcome']).toBe('empty');

    await run();
    expect(calls.retrieve).toBe(5);
  });
});
