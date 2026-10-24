import { Writable } from 'node:stream';
import { EventBus } from '@wrongstack/contracts/kernel';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { stripAnsi } from '@wrongstack/core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalRenderer } from '../src/renderer.js';
import { SessionStats } from '../src/session-stats.js';

class CapStream extends Writable {
  buf = '';
  override _write(c: Buffer | string, _e: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.buf += typeof c === 'string' ? c : c.toString('utf8');
    cb();
  }
}

function rig() {
  const out = new CapStream();
  const err = new CapStream();
  const renderer = new TerminalRenderer({
    out: out as never as NodeJS.WriteStream,
    err: err as never as NodeJS.WriteStream,
  });
  const events = new EventBus();
  const tc = new DefaultTokenCounter();
  const stats = new SessionStats(events, tc);
  return { renderer, out, events, tc, stats };
}

describe('SessionStats', () => {
  it('shows errors when error events fire', () => {
    const r = rig();
    r.events.emit('iteration.completed', {} as never); // trigger hasActivity
    r.events.emit('error', { msg: 'boom' } as never);
    r.stats.render(r.renderer);
    const text = stripAnsi(r.out.buf);
    expect(text).toContain('Errors:');
  });

  it('tracks fetch events', () => {
    const r = rig();
    r.events.emit('iteration.completed', {} as never); // trigger hasActivity
    r.events.emit('tool.executed', {
      id: 'call-fetch',
      name: 'fetch',
      durationMs: 20,
      ok: true,
      input: { url: 'https://example.com' },
    });
    r.stats.render(r.renderer);
    const text = stripAnsi(r.out.buf);
    expect(text).toContain('Web fetches:');
  });

  it('renders nothing when there is no activity', () => {
    const r = rig();
    r.stats.render(r.renderer);
    expect(r.out.buf).toBe('');
  });

  it('aggregates tool calls, files, and tokens', () => {
    const r = rig();
    r.tc.account({ input: 1200, output: 80 }, 'm');
    r.events.emit('iteration.completed', {} as never);
    r.events.emit('provider.response', {
      ctx: {} as never,
      usage: {} as never,
      model: 'test-model',
      stopReason: 'end_turn',
    });
    r.events.emit('tool.executed', {
      id: 'call-read-a1',
      name: 'read',
      durationMs: 5,
      ok: true,
      input: { path: 'src/a.ts' },
    });
    r.events.emit('tool.executed', {
      id: 'call-read-a2',
      name: 'read',
      durationMs: 3,
      ok: true,
      input: { path: 'src/a.ts' }, // duplicate path, should be deduped
    });
    r.events.emit('tool.executed', {
      id: 'call-read-b',
      name: 'read',
      durationMs: 7,
      ok: true,
      input: { path: 'src/b.ts' },
    });
    r.events.emit('tool.executed', {
      id: 'call-edit-a',
      name: 'edit',
      durationMs: 20,
      ok: true,
      input: { path: 'src/a.ts' },
    });
    r.events.emit('tool.executed', {
      id: 'call-write-c',
      name: 'write',
      durationMs: 12,
      ok: true,
      input: { path: 'src/c.ts', content: 'hello world' },
    });
    r.events.emit('tool.executed', {
      id: 'call-bash',
      name: 'bash',
      durationMs: 100,
      ok: false,
      input: { command: 'rm -rf' },
    });

    r.stats.render(r.renderer);
    const text = stripAnsi(r.out.buf);

    expect(text).toContain('Session report');
    expect(text).toContain('API requests:  1');
    expect(text).toContain('Iterations:    1');
    expect(text).toContain('in 1.2k');
    expect(text).toContain('out 80');
    expect(text).toContain('read           3×');
    expect(text).toContain('edit           1×');
    expect(text).toContain('write          1×');
    expect(text).toContain('bash           1×');
    expect(text).toContain('(1 failed)');
    expect(text).toContain('read:    2'); // src/a.ts + src/b.ts deduped
    expect(text).toContain('edited:  1');
    expect(text).toContain('written: 1');
    expect(text).toContain('11B'); // 'hello world' is 11 bytes
    expect(text).toContain('Shell commands:  1');
  });

  it('removes event listeners on destroy', () => {
    const r = rig();
    r.events.emit('iteration.completed', {} as never);
    r.events.emit('provider.response', {
      ctx: {} as never,
      usage: {} as never,
      model: 'test-model',
      stopReason: 'end_turn',
    } as never);
    expect(r.stats.hasActivity()).toBe(true);

    // Destroy removes all listeners — subsequent events should be ignored.
    r.stats.destroy(r.events);

    // After destroy, events no longer accumulate.
    r.events.emit('iteration.completed', {} as never);
    r.events.emit('provider.response', {
      ctx: {} as never,
      usage: {} as never,
      model: 'test-model',
      stopReason: 'end_turn',
    } as never);

    // render() should still work without throwing.
    const renderer = new TerminalRenderer({
      out: r.out as never as NodeJS.WriteStream,
      err: r.out as never as NodeJS.WriteStream,
    });
    expect(() => r.stats.render(renderer)).not.toThrow();
  });

  it('shows pricing when registry-priced model is used', () => {
    const r = rig();
    r.tc.accountWithModel({ input: 1_000_000, output: 1_000_000 }, {
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      capabilities: { tools: true, vision: false, reasoning: false, maxContext: 200_000 },
      cost: { input: 1, output: 5 },
    } as never);
    r.events.emit('provider.response', {
      ctx: {} as never,
      usage: {} as never,
      model: 'test-model',
      stopReason: 'end_turn',
    });
    r.stats.render(r.renderer);
    const text = stripAnsi(r.out.buf);
    expect(text).toContain('Cost:          $6.0000');
  });

  describe('first token after submit', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function turn(
      r: ReturnType<typeof rig>,
      ctx: object,
      waitMs: number,
      first: 'provider.text_delta' | 'provider.thinking_delta' | 'provider.tool_use_start',
    ): void {
      r.events.emit('agent.run.started', { ctx, model: 'm', at: '' } as never);
      vi.advanceTimersByTime(waitMs);
      r.events.emit(first, { ctx, text: 'x', id: 't', name: 'read' } as never);
      vi.advanceTimersByTime(500);
      // Later output of the same turn is not a first token.
      r.events.emit('provider.text_delta', { ctx, text: 'more' } as never);
      r.events.emit('agent.run.completed', { ctx } as never);
    }

    it('reports the one turn, or the median and range of several', () => {
      vi.useFakeTimers();
      const leader = {};
      const one = rig();
      turn(one, leader, 1_200, 'provider.text_delta');
      expect(stripAnsi(one.stats.format() ?? '')).toContain('First token:   1.2s\n');

      const many = rig();
      turn(many, leader, 900, 'provider.thinking_delta');
      turn(many, leader, 3_400, 'provider.tool_use_start');
      turn(many, leader, 1_500, 'provider.text_delta');
      expect(stripAnsi(many.stats.format() ?? '')).toContain(
        'First token:   1.5s median · 0.9s–3.4s over 3 turns',
      );
    });

    it('ignores subagent runs and turns that ended without output', () => {
      vi.useFakeTimers();
      const r = rig();
      const leader = {};
      const subagent = {};
      turn(r, leader, 800, 'provider.text_delta');
      turn(r, subagent, 9_000, 'provider.text_delta');
      r.events.emit('agent.run.started', { ctx: leader } as never);
      vi.advanceTimersByTime(5_000);
      r.events.emit('agent.run.error', { ctx: leader } as never);
      r.events.emit('provider.text_delta', { ctx: leader, text: 'late' } as never);
      expect(stripAnsi(r.stats.format() ?? '')).toContain('First token:   0.8s\n');
    });

    it('stays out of the report when no turn produced output', () => {
      const r = rig();
      r.events.emit('iteration.completed', {} as never);
      expect(stripAnsi(r.stats.format() ?? '')).not.toContain('First token');
    });
  });
});
