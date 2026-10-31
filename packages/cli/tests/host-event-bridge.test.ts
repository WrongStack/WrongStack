/**
 * Host subagent event bridge — compact tool payloads at the fan-out boundary
 * so the leader EventBus never receives multi-MB write/edit bodies.
 */

import { compactBridgeToolInput, installSubagentEventBridge } from '@wrongstack/fleet';
import { describe, expect, it } from 'vitest';

describe('compactBridgeToolInput', () => {
  it('keeps path metadata and drops body fields with size signals', () => {
    const content = 'line1\nline2\nline3';
    const compact = compactBridgeToolInput({
      file_path: 'src/app.ts',
      content,
      offset: 1,
    }) as Record<string, unknown>;
    expect(compact['file_path']).toBe('src/app.ts');
    expect(compact['offset']).toBe(1);
    expect(compact['content']).toBeUndefined();
    expect(compact['_bodyBytes']).toBe(Buffer.byteLength(content, 'utf8'));
    expect(compact['inputLines']).toBe(3);
  });

  it('preserves the patch body and strip so per-file deltas survive the hop', () => {
    // The body is the ONLY per-file evidence a patch carries: one call can
    // address several files and the totals below cannot be split back apart.
    const patch = '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new';
    const compact = compactBridgeToolInput({ patch, strip: 1 }) as Record<string, unknown>;
    expect(compact['patch']).toBe(patch);
    expect(compact['strip']).toBe(1);
    expect(compact['addedLines']).toBe(1);
    expect(compact['removedLines']).toBe(1);
  });

  it('bounds a huge patch body instead of dropping it', () => {
    const added = Array.from({ length: 50_000 }, (_, i) => `+line ${i}`);
    const patch = `--- a/src/x.ts\n+++ b/src/x.ts\n@@ -0,0 +1,50000 @@\n${added.join('\n')}`;
    const compact = compactBridgeToolInput({ patch }) as Record<string, unknown>;
    const kept = compact['patch'] as string;
    expect(kept.length).toBeLessThan(patch.length);
    expect(kept.length).toBeLessThanOrEqual(64 * 1024);
    // Truncating the body must not corrupt the totals derived from the full one.
    expect(compact['addedLines']).toBe(50_000);
  });

  it('omits strip when the tool supplied no numeric one', () => {
    const compact = compactBridgeToolInput({ patch: '@@\n-a\n+b' }) as Record<string, unknown>;
    expect(compact['strip']).toBeUndefined();
    expect(compact['patch']).toBe('@@\n-a\n+b');
  });

  it('caps long path-like strings', () => {
    const longPath = 'p'.repeat(1_000);
    const compact = compactBridgeToolInput({ path: longPath }) as Record<string, unknown>;
    expect(String(compact['path']).length).toBeLessThanOrEqual(360);
  });
});

describe('installSubagentEventBridge', () => {
  it('forwards compact inputs on tool.started / tool.executed', () => {
    const offs: Array<() => void> = [];
    const hostEmits: Array<{ event: string; payload: unknown }> = [];
    const listeners = new Map<string, (e: unknown) => void>();

    const events = {
      on: (event: string, fn: (e: unknown) => void) => {
        listeners.set(event, fn);
        const off = () => listeners.delete(event);
        offs.push(off);
        return off;
      },
    };
    const hostEvents = {
      emit: (event: string, payload: unknown) => {
        hostEmits.push({ event, payload });
      },
    };

    const dispose = installSubagentEventBridge({
      events: events as never,
      hostEvents: hostEvents as never,
      hostSessionId: 'host-sess',
      projectRoot: '/proj',
      effectiveCfg: { id: 'sa-1', name: 'worker' } as never,
      subCfg: { name: 'worker' } as never,
    });

    const huge = 'x'.repeat(50_000);
    listeners.get('tool.started')?.({
      sessionId: 'sub-sess',
      agentName: 'worker',
      traceId: 't1',
      id: 'tu-1',
      name: 'write_file',
      input: { file_path: 'big.ts', content: huge },
    });
    listeners.get('tool.executed')?.({
      sessionId: 'sub-sess',
      agentName: 'worker',
      traceId: 't1',
      id: 'tu-1',
      name: 'write_file',
      durationMs: 10,
      ok: true,
      input: { file_path: 'big.ts', content: huge },
      output: huge,
      outputBytes: huge.length,
    });

    const started = hostEmits.find((e) => e.event === 'subagent.tool_started');
    const executed = hostEmits.find((e) => e.event === 'subagent.tool_executed');
    expect(started).toBeDefined();
    expect(executed).toBeDefined();

    const startedInput = (started!.payload as { input: Record<string, unknown> }).input;
    expect(startedInput['file_path']).toBe('big.ts');
    expect(startedInput['content']).toBeUndefined();
    expect(JSON.stringify(startedInput)).not.toContain(huge);

    const executedPayload = executed?.payload as {
      input: Record<string, unknown>;
      output: string;
    };
    expect(executedPayload.input['content']).toBeUndefined();
    expect(executedPayload.output.length).toBeLessThan(huge.length);
    expect(executedPayload.output).not.toBe(huge);

    listeners.get('token.accounted')?.({
      usage: { input: 500, output: 100 },
      deltaUsage: { input: 10, output: 5 },
      cost: { total: 1, input: 0.5, output: 0.5 },
      deltaCost: { total: 0.01, input: 0.005, output: 0.005 },
      model: 'm',
      provider: 'p',
    });
    expect(
      hostEmits.find((event) => event.event === 'subagent.token_accounted')?.payload,
    ).toMatchObject({ sessionId: 'host-sess', model: 'm', deltaCost: { total: 0.01 } });
    listeners.get('provider.attempt.failed')?.({
      attemptId: 'attempt',
      logicalRequestId: 'request',
      attempt: 1,
      model: 'm',
      providerId: 'p',
      retryScheduled: true,
      retryDelayMs: 50,
    });
    expect(
      hostEmits.find((event) => event.event === 'subagent.provider_attempt')?.payload,
    ).toMatchObject({
      sessionId: 'host-sess',
      outcome: 'failed',
      attemptId: 'attempt',
      retryScheduled: true,
      retryDelayMs: 50,
    });

    listeners.get('tool.loop_detected')?.({
      ctx: { provider: { id: 'p' }, model: 'm' },
      tools: 'read',
      repeatCount: 4,
      iteration: 10,
      action: 'steer',
    });
    expect(
      hostEmits.find((event) => event.event === 'subagent.loop_detected')?.payload,
    ).toMatchObject({ sessionId: 'host-sess', subagentId: 'sa-1', model: 'm', repeatCount: 4 });
    dispose();
    expect(listeners.size).toBe(0);
  });
});
