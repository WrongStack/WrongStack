/**
 * Host subagent event bridge — compact tool payloads at the fan-out boundary
 * so the leader EventBus never receives multi-MB write/edit bodies.
 */
import { describe, expect, it } from 'vitest';
import {
  compactBridgeToolInput,
  installSubagentEventBridge,
} from '../src/fleet/host-event-bridge.js';

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

  it('derives patch line deltas without retaining the patch body', () => {
    const compact = compactBridgeToolInput({
      file_path: 'src/x.ts',
      patch: '@@\n-old\n+new\n+more',
    }) as Record<string, unknown>;
    expect(compact['patch']).toBeUndefined();
    expect(compact['addedLines']).toBe(2);
    expect(compact['removedLines']).toBe(1);
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

    dispose();
    expect(listeners.size).toBe(0);
  });
});
