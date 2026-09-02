import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { EventBus } from '../../src/kernel/events.js';
import type { ToolUseBlock } from '../../src/types/blocks.js';
import type { PermissionDecision } from '../../src/types/permission.js';
import type { Tool, ToolProgressEvent, ToolStreamEvent } from '../../src/types/tool.js';

function makeCtx(): Context {
  const session = { id: 'test-session', append: vi.fn(), close: vi.fn() };
  return {
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    provider: {} as never,
    session: session as never,
    signal: new AbortController().signal,
    tokenCounter: { account: vi.fn() } as never,
    cwd: '/test',
    projectRoot: '/test',
    model: 'test-model',
    tools: [],
    meta: {},
    registerAbortHook: vi.fn().mockReturnValue(() => {}),
    drainAbortHooks: vi.fn(),
  } as never as Context;
}

function makeUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: `id_${name}`, name, input };
}

function autoPermit(): PermissionDecision {
  return { permission: 'auto', source: 'default' };
}

function makeExecutor(tools: Tool[], events?: EventBus) {
  const registry = {
    get: (name: string) => tools.find((t) => t.name === name),
    list: () => tools,
  };
  return new ToolExecutor(registry, {
    permissionPolicy: { evaluate: vi.fn().mockResolvedValue(autoPermit()) } as never,
    secretScrubber: { scrub: (s: string) => s } as never,
    perIterationOutputCapBytes: 50_000,
    events,
  } as never);
}

describe('Tool lifecycle — executeStream', () => {
  it('emits tool.progress events for each yielded progress event', async () => {
    const events = new EventBus();
    const progressLog: ToolProgressEvent[] = [];
    events.on('tool.progress', (e) => progressLog.push(e.event));

    const streamingTool: Tool = {
      name: 'stream-tool',
      description: 'streams partial output',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: vi.fn().mockResolvedValue('unused'),
      async *executeStream(): AsyncGenerator<ToolStreamEvent<string>> {
        yield { type: 'log', text: 'starting' };
        yield { type: 'partial_output', text: 'chunk 1' };
        yield { type: 'partial_output', text: 'chunk 2' };
        yield { type: 'metric', data: { processed: 42 } };
        yield { type: 'final', output: 'done' };
      },
    };

    const executor = makeExecutor([streamingTool], events);
    const result = await executor.executeBatch([makeUse('stream-tool')], makeCtx(), 'sequential');

    expect(progressLog).toHaveLength(4);
    expect(progressLog[0]).toEqual({ type: 'log', text: 'starting' });
    expect(progressLog[1]).toEqual({ type: 'partial_output', text: 'chunk 1' });
    expect(progressLog[2]).toEqual({ type: 'partial_output', text: 'chunk 2' });
    expect(progressLog[3]).toEqual({ type: 'metric', data: { processed: 42 } });

    // Final output is the serialized result
    const output = result.outputs[0]!.result;
    expect((output as { content: string }).content).toContain('done');
  });

  it('coalesces rapid partial_output bursts into few tool.progress emits', async () => {
    const events = new EventBus();
    const partials: string[] = [];
    events.on('tool.progress', (e) => {
      if (e.event.type === 'partial_output' && e.event.text) partials.push(e.event.text);
    });

    // 200 chunks yielded back-to-back (same tick) — a chatty child process.
    // Pre-coalescing this produced 200 events; a real `pnpm test` produced
    // 73k+ events / 300 MB through the bus and OOM'd the host.
    const chunks = Array.from({ length: 200 }, (_, i) => `chunk-${i};`);
    const chattyTool: Tool = {
      name: 'chatty',
      description: 'floods partial output',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: vi.fn(),
      async *executeStream(): AsyncGenerator<ToolStreamEvent<string>> {
        for (const c of chunks) yield { type: 'partial_output', text: c };
        yield { type: 'final', output: 'done' };
      },
    };

    const executor = makeExecutor([chattyTool], events);
    await executor.executeBatch([makeUse('chatty')], makeCtx(), 'sequential');

    // First chunk emits immediately; the burst coalesces; the remainder is
    // flushed once at stream end. Allow slack for a slow CI tick crossing
    // the emit interval, but it must be far below one-event-per-chunk.
    expect(partials.length).toBeLessThanOrEqual(10);
    // No text lost (total volume here is below the tail cap).
    expect(partials.join('')).toBe(chunks.join(''));
  });

  it('does not coalesce live-preview partial_output events', async () => {
    const events = new EventBus();
    const partials: string[] = [];
    events.on('tool.progress', (e) => {
      if (e.event.type === 'partial_output' && e.event.text) partials.push(e.event.text);
    });

    const previewTool: Tool = {
      name: 'preview-write',
      description: 'streams live preview lines',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: true,
      execute: vi.fn(),
      async *executeStream(): AsyncGenerator<ToolStreamEvent<string>> {
        yield { type: 'partial_output', text: 'one\n', data: { livePreview: true } };
        yield { type: 'partial_output', text: 'two\n', data: { livePreview: true } };
        yield { type: 'partial_output', text: 'three\n', data: { livePreview: true } };
        yield { type: 'final', output: 'done' };
      },
    };

    const executor = makeExecutor([previewTool], events);
    await executor.executeBatch([makeUse('preview-write')], makeCtx(), 'sequential');

    expect(partials).toEqual(['one\n', 'two\n', 'three\n']);
  });

  it('progress event carries the tool name and call id', async () => {
    const events = new EventBus();
    let captured: { name: string; id: string } | null = null;
    events.on('tool.progress', (e) => {
      captured ??= { name: e.name, id: e.id };
    });

    const tool: Tool = {
      name: 'identified',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: vi.fn(),
      async *executeStream(): AsyncGenerator<ToolStreamEvent> {
        yield { type: 'log', text: 'hi' };
        yield { type: 'final', output: null };
      },
    };

    const executor = makeExecutor([tool], events);
    await executor.executeBatch([makeUse('identified')], makeCtx(), 'sequential');

    expect(captured).toEqual({ name: 'identified', id: 'id_identified' });
  });

  it('falls back to execute() when executeStream is undefined', async () => {
    const exec = vi.fn().mockResolvedValue({ value: 'classic' });
    const events = new EventBus();
    const progress: unknown[] = [];
    events.on('tool.progress', (e) => progress.push(e));

    const tool: Tool = {
      name: 'classic',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: exec,
    };

    const executor = makeExecutor([tool], events);
    await executor.executeBatch([makeUse('classic')], makeCtx(), 'sequential');

    expect(exec).toHaveBeenCalledOnce();
    expect(progress).toEqual([]);
  });

  it('emits tool.completed with metadata-only success metrics', async () => {
    const events = new EventBus();
    const completed: unknown[] = [];
    events.on('tool.completed', (e) => completed.push(e));

    const tool: Tool = {
      name: 'classic',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: vi.fn().mockResolvedValue('secret output'),
    };
    const ctx = makeCtx();
    ctx.traceId = 'trace-abc';

    const executor = makeExecutor([tool], events);
    await executor.executeBatch(
      [makeUse('classic', { command: 'secret input' })],
      ctx,
      'sequential',
    );

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      name: 'classic',
      id: 'id_classic',
      sessionId: 'test-session',
      traceId: 'trace-abc',
      agentId: '<unknown>',
      durationMs: expect.any(Number),
      outputChars: expect.any(Number),
    });
    expect(JSON.stringify(completed[0])).not.toContain('secret input');
    expect(JSON.stringify(completed[0])).not.toContain('secret output');
  });

  it('emits tool.failed with classification metadata', async () => {
    const events = new EventBus();
    const failed: unknown[] = [];
    events.on('tool.failed', (e) => failed.push(e));

    const tool: Tool = {
      name: 'classic',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    };

    const executor = makeExecutor([tool], events);
    await executor.executeBatch(
      [makeUse('classic', { command: 'secret input' })],
      makeCtx(),
      'sequential',
    );

    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      name: 'classic',
      id: 'id_classic',
      sessionId: 'test-session',
      agentId: '<unknown>',
      durationMs: expect.any(Number),
      category: expect.any(String),
      retryable: expect.any(Boolean),
    });
    expect(JSON.stringify(failed[0])).not.toContain('secret input');
  });

  it('throws when executeStream completes without final event', async () => {
    const tool: Tool = {
      name: 'incomplete',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: vi.fn(),
      async *executeStream(): AsyncGenerator<ToolStreamEvent> {
        yield { type: 'log', text: 'mid-flight' };
        // No final event!
      },
    };

    const executor = makeExecutor([tool]);
    const result = await executor.executeBatch([makeUse('incomplete')], makeCtx(), 'sequential');
    expect((result.outputs[0]!.result as { is_error: boolean }).is_error).toBe(true);
    expect((result.outputs[0]!.result as { content: string }).content).toMatch(/without a 'final'/);
  });

  it('calls cleanup when the tool is aborted', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const tool: Tool = {
      name: 'abortable',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: async (_input, _ctx, opts) => {
        await new Promise<void>((_, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        return null;
      },
      cleanup,
    };

    const ctrl = new AbortController();
    const ctx = makeCtx();
    (ctx as { signal: AbortSignal }).signal = ctrl.signal;

    const executor = makeExecutor([tool]);
    const runPromise = executor.executeBatch([makeUse('abortable')], ctx, 'sequential');
    setTimeout(() => ctrl.abort(), 20);
    const result = await runPromise;

    expect(cleanup).toHaveBeenCalledOnce();
    expect((result.outputs[0]!.result as { is_error: boolean }).is_error).toBe(true);
  });

  it('cleanup errors are swallowed and do not mask the underlying failure', async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error('cleanup blew up'));
    const tool: Tool = {
      name: 'flaky-cleanup',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: async (_input, _ctx, opts) => {
        await new Promise<void>((_, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('original error')));
        });
        return null;
      },
      cleanup,
    };

    const ctrl = new AbortController();
    const ctx = makeCtx();
    (ctx as { signal: AbortSignal }).signal = ctrl.signal;

    const executor = makeExecutor([tool]);
    const runPromise = executor.executeBatch([makeUse('flaky-cleanup')], ctx, 'sequential');
    setTimeout(() => ctrl.abort(), 20);
    const result = await runPromise;

    expect(cleanup).toHaveBeenCalledOnce();
    expect((result.outputs[0]!.result as { content: string }).content).toMatch(/original error/);
  });

  it('does not call cleanup on successful completion', async () => {
    const cleanup = vi.fn();
    const tool: Tool = {
      name: 'happy-path',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: vi.fn().mockResolvedValue('ok'),
      cleanup,
    };

    const executor = makeExecutor([tool]);
    await executor.executeBatch([makeUse('happy-path')], makeCtx(), 'sequential');
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('streaming tool receives the abort signal', async () => {
    const events = new EventBus();
    const ctrl = new AbortController();
    const ctx = makeCtx();
    (ctx as { signal: AbortSignal }).signal = ctrl.signal;

    let observedAbort = false;
    const tool: Tool = {
      name: 'long-stream',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: vi.fn(),
      async *executeStream(_input, _ctx, opts): AsyncGenerator<ToolStreamEvent> {
        for (let i = 0; i < 100; i++) {
          if (opts.signal.aborted) {
            observedAbort = true;
            throw new Error('aborted');
          }
          yield { type: 'log', text: `step ${i}` };
          await new Promise((r) => setTimeout(r, 10));
        }
        yield { type: 'final', output: null };
      },
    };

    const executor = makeExecutor([tool], events);
    const runPromise = executor.executeBatch([makeUse('long-stream')], ctx, 'sequential');
    setTimeout(() => ctrl.abort(), 30);
    await runPromise;

    // The executor's abort race unblocks executeBatch the moment the signal
    // fires — the generator observes the abort on its own next tick, so poll
    // instead of asserting synchronously after the (now-early) return.
    await expect.poll(() => observedAbort).toBe(true);
  });

  it('estimatedDurationMs field is part of the Tool type and preserved on the object', () => {
    const tool: Tool = {
      name: 'timed',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      execute: vi.fn(),
      estimatedDurationMs: 5_000,
    };
    expect(tool.estimatedDurationMs).toBe(5_000);
  });
});
