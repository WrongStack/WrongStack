/**
 * The tools an ACP leader runs itself reach the host as tool cards. No
 * tool_result is ever appended for them, so the finished card says so and
 * carries the result text: the TUI used to wait for that tool_result and
 * never rendered the card.
 */
import { EventBus } from '@wrongstack/contracts/kernel';
import { describe, expect, it } from 'vitest';
import { ToolCardRelay } from '../src/acp-leader/acp-leader-stream.js';

describe('ToolCardRelay', () => {
  it('marks a settled card as outside the conversation, with the result text', () => {
    const events = new EventBus();
    const done: Array<Record<string, unknown>> = [];
    events.on('tool.executed', (e) => done.push(e as never));
    const relay = new ToolCardRelay(events, { sessionId: 's1', model: 'claude-code' });

    relay.update({ toolCallId: 't1', title: 'Read a.ts', status: 'in_progress' });
    relay.update({
      toolCallId: 't1',
      title: 'Read a.ts',
      status: 'completed',
      output: 'line 1\nline 2',
    });
    relay.update({ toolCallId: 't1', title: 'Read a.ts', status: 'completed' });

    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      id: 't1',
      name: 'Read a.ts',
      ok: true,
      outsideConversation: true,
      output: 'line 1\nline 2',
    });
  });

  it('caps a long result and falls back to an object rawOutput', () => {
    const events = new EventBus();
    const outputs: Array<string | undefined> = [];
    events.on('tool.executed', (e) => outputs.push(e.output));
    const relay = new ToolCardRelay(events, { model: 'claude-code' });

    relay.update({ toolCallId: 'a', title: 'big', status: 'completed', output: 'x'.repeat(5_000) });
    relay.update({
      toolCallId: 'b',
      title: 'obj',
      status: 'failed',
      rawOutput: { output: 'boom' },
    });

    expect(outputs[0]).toHaveLength(4_001);
    expect(outputs[0]?.endsWith('…')).toBe(true);
    expect(outputs[1]).toBe('boom');
  });

  it('carries the whole result beside a capped preview, sized by the result', () => {
    const events = new EventBus();
    const done: Array<Record<string, unknown>> = [];
    events.on('tool.executed', (e) => done.push(e as never));
    const relay = new ToolCardRelay(events, { model: 'claude-code' });
    const result = `${'a'.repeat(4_500)}TAIL`;

    relay.update({ toolCallId: 'r', title: 'Read big.ts', status: 'completed', output: result });
    relay.update({ toolCallId: 's', title: 'Read small.ts', status: 'completed', output: 'ok' });

    // The inspect view used to show only the 4k preview: the tail never arrived.
    expect(done[0]?.fullOutput).toBe(result);
    expect(done[0]?.outputBytes).toBe(result.length);
    expect(done[0]?.output).toHaveLength(4_001);
    // A result the preview holds whole carries no second copy.
    expect(done[1]).not.toHaveProperty('fullOutput');
    expect(done[1]?.outputBytes).toBe(2);
  });

  it('bounds the whole result too', () => {
    const events = new EventBus();
    let full: string | undefined;
    let bytes: number | undefined;
    events.on('tool.executed', (e) => {
      full = e.fullOutput;
      bytes = e.outputBytes;
    });
    const relay = new ToolCardRelay(events, { model: 'claude-code' });

    relay.update({
      toolCallId: 'h',
      title: 'huge',
      status: 'completed',
      output: 'z'.repeat(300 * 1024),
    });

    expect(full).toHaveLength(256 * 1024 + 1);
    expect(full?.endsWith('…')).toBe(true);
    expect(bytes).toBe(300 * 1024);
  });
});
