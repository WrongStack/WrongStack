import { EventBus } from '@wrongstack/contracts/kernel';
import { describe, expect, it } from 'vitest';
import { parseOutputFormat, startStreamJson, streamJsonInit } from '../src/boot/stream-json.js';

const lines = (out: string[]) => out.map((line) => JSON.parse(line) as Record<string, unknown>);

describe('parseOutputFormat', () => {
  it('accepts the three formats and nothing else', () => {
    expect(parseOutputFormat(undefined)).toBeUndefined();
    expect(parseOutputFormat('stream-json')).toBe('stream-json');
    expect(() => parseOutputFormat('yaml')).toThrow(/text, json or stream-json/);
    expect(() => parseOutputFormat(true)).toThrow(/got nothing/);
  });
});

describe('startStreamJson', () => {
  it('writes one JSON line per leader response and tool result', () => {
    const events = new EventBus();
    const out: string[] = [];
    const stop = startStreamJson({
      events,
      write: (line) => out.push(line),
      includePartialMessages: false,
    });
    events.emit('provider.text_delta', { ctx: { agentId: 'leader' } as never, text: 'hi' });
    events.emit('provider.response', {
      ctx: { agentId: 'leader' } as never,
      model: 'm',
      content: [
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
      ],
      usage: { input: 3, output: 2 },
      stopReason: 'tool_use',
    });
    events.emit('tool.executed', { id: 't1', name: 'read', ok: true, durationMs: 4, output: 'x' });
    stop();
    events.emit('tool.executed', { id: 't2', name: 'read', ok: true, durationMs: 1 });

    expect(out.every((line) => line.endsWith('\n') && !line.slice(0, -1).includes('\n'))).toBe(
      true,
    );
    expect(lines(out)).toEqual([
      {
        type: 'assistant',
        model: 'm',
        content: [
          { type: 'text', text: 'Reading it.' },
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
        ],
        stopReason: 'tool_use',
        usage: { input: 3, output: 2 },
      },
      {
        type: 'tool_result',
        id: 't1',
        name: 'read',
        ok: true,
        durationMs: 4,
        output: 'x',
        outputBytes: null,
      },
    ]);
  });

  it('streams text deltas only when asked, and never a subagent’s activity', () => {
    const events = new EventBus();
    const out: string[] = [];
    startStreamJson({ events, write: (line) => out.push(line), includePartialMessages: true });
    events.emit('provider.text_delta', { ctx: { agentId: 'leader' } as never, text: 'a' });
    events.emit('provider.text_delta', { ctx: { agentId: 'worker@1' } as never, text: 'b' });
    events.emit('tool.executed', {
      id: 'call-bash',
      agentId: 'worker@1',
      name: 'bash',
      ok: true,
      durationMs: 1,
    });
    expect(lines(out)).toEqual([{ type: 'text_delta', text: 'a' }]);
  });
});

describe('streamJsonInit', () => {
  it('is a single typed line', () => {
    const line = streamJsonInit({
      sessionId: 's',
      provider: 'p',
      model: 'm',
      cwd: '/w',
      tools: ['read'],
    });
    expect(JSON.parse(line)).toEqual({
      type: 'init',
      sessionId: 's',
      provider: 'p',
      model: 'm',
      cwd: '/w',
      tools: ['read'],
    });
  });
});
