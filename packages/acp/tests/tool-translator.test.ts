import { describe, expect, it, vi } from 'vitest';
import type { ACPMessage, ACPToolCallResponse, ContentBlock } from '../src/types/acp-messages.js';
import {
  ToolTranslator,
  acpToolToSchema,
  buildTaskSpec,
  extractTextFromContent,
  parseToolResponse,
} from '../src/client/tool-translator.js';

describe('acpToolToSchema', () => {
  it('returns the definition inputSchema when present', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(acpToolToSchema({ name: 't', inputSchema: schema })).toBe(schema);
  });

  it('returns an empty object schema when inputSchema is absent', () => {
    expect(acpToolToSchema({ name: 't', inputSchema: undefined as never })).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('extractTextFromContent', () => {
  it('joins text, resource, image and progress blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'resource', resource: { type: 'file', uri: 'file:///a.txt' } },
      { type: 'image', data: 'AAAABBBBCCCCDDDDEEEEFFFF', mimeType: 'image/png' },
      { type: 'progress', id: 'p1', messages: ['step 1', 'step 2'] },
    ];
    expect(extractTextFromContent(blocks)).toBe(
      [
        'hello',
        '[resource: file:///a.txt]',
        '[image: AAAABBBBCCCCDDDDEEEE...]',
        'step 1\nstep 2',
      ].join('\n'),
    );
  });

  it('skips progress blocks with no messages', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'a' },
      { type: 'progress', id: 'p1' },
      { type: 'progress', id: 'p2', messages: [] },
    ];
    expect(extractTextFromContent(blocks)).toBe('a');
  });

  it('returns an empty string for no blocks', () => {
    expect(extractTextFromContent([])).toBe('');
  });

  it('ignores unrecognised block types', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'keep' },
      { type: 'mystery', foo: 1 } as never as ContentBlock,
    ];
    expect(extractTextFromContent(blocks)).toBe('keep');
  });
});

describe('buildTaskSpec', () => {
  it('maps the payload, preserving subagentId', () => {
    expect(buildTaskSpec({ taskId: 't1', task: 'do it', subagentId: 's1' })).toEqual({
      id: 't1',
      description: 'do it',
      subagentId: 's1',
    });
  });

  it('leaves subagentId undefined when omitted', () => {
    expect(buildTaskSpec({ taskId: 't2', task: 'x' })).toEqual({
      id: 't2',
      description: 'x',
      subagentId: undefined,
    });
  });
});

describe('parseToolResponse', () => {
  function resp(content: ContentBlock[], isError?: boolean): ACPToolCallResponse {
    return { method: 'tools/call', id: 1, result: { content, isError } };
  }

  it('marks a clean response as success', () => {
    const out = parseToolResponse('t1', 's1', resp([{ type: 'text', text: 'all good' }]));
    expect(out).toMatchObject({
      taskId: 't1',
      subagentId: 's1',
      status: 'success',
      result: 'all good',
      iterations: 1,
      toolCalls: 1,
    });
  });

  it('marks failed when the isError flag is set', () => {
    const out = parseToolResponse('t1', 's1', resp([{ type: 'text', text: 'nope' }], true));
    expect(out.status).toBe('failed');
  });

  it('marks failed when the text mentions "error"', () => {
    const out = parseToolResponse('t1', 's1', resp([{ type: 'text', text: 'Fatal ERROR here' }]));
    expect(out.status).toBe('failed');
  });

  it('marks failed when the text mentions "failed"', () => {
    const out = parseToolResponse('t1', 's1', resp([{ type: 'text', text: 'the job Failed' }]));
    expect(out.status).toBe('failed');
  });
});

/** Fake transport that captures the message handler and sent messages. */
function makeTransport() {
  let handler: ((msg: ACPMessage) => void) | undefined;
  const sent: ACPMessage[] = [];
  return {
    sent,
    onMessage: (h: (msg: ACPMessage) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    send: vi.fn(async (msg: ACPMessage) => {
      sent.push(msg);
    }),
    emit: (msg: ACPMessage) => handler?.(msg),
  };
}

// callTool awaits transport.send() before registering its pending entry, so a
// matching response/cancel must be emitted only after that microtask drains.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ToolTranslator', () => {
  it('resolves callTool when a matching tools/call response arrives', async () => {
    const t = new ToolTranslator({ totalTimeoutMs: 2000 });
    const transport = makeTransport();
    t.attachToTransport(transport);

    const promise = t.callTool(transport, 'echo', { msg: 'hi' }, 'call-1');
    expect(transport.sent[0]).toEqual({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 'call-1',
      params: { name: 'echo', arguments: { msg: 'hi' } },
    });

    await flush();
    transport.emit({
      method: 'tools/call',
      id: 'call-1',
      result: { content: [{ type: 'text', text: 'pong' }] },
    });
    const res = await promise;
    expect((res as ACPToolCallResponse).result.content[0]).toEqual({ type: 'text', text: 'pong' });
  });

  it('rejects callTool when a cancel for that id arrives', async () => {
    const t = new ToolTranslator({ totalTimeoutMs: 2000 });
    const transport = makeTransport();
    t.attachToTransport(transport);

    const promise = t.callTool(transport, 'slow', {}, 'call-2');
    await flush();
    transport.emit({ method: 'cancel', id: 'call-2' });
    await expect(promise).rejects.toThrow('Call cancelled by client');
  });

  it('ignores transport messages with no matching pending call', async () => {
    const t = new ToolTranslator({ totalTimeoutMs: 2000 });
    const transport = makeTransport();
    t.attachToTransport(transport);
    // No pending calls — these must not throw.
    expect(() => transport.emit({ method: 'tools/call', id: 'unknown' })).not.toThrow();
    expect(() => transport.emit({ method: 'cancel', id: 'unknown' })).not.toThrow();
    // Messages without an id are ignored entirely.
    expect(() => transport.emit({ method: 'tools/call' })).not.toThrow();
  });

  it('generates a default callId when none is given', async () => {
    const t = new ToolTranslator({ totalTimeoutMs: 2000 });
    const transport = makeTransport();
    t.attachToTransport(transport);
    // Swallow the eventual timeout rejection; cancelAll clears the timer so the
    // test leaves no pending timer behind.
    void t.callTool(transport, 'auto', {}).catch(() => {});
    const sent = transport.sent[0]!;
    expect(typeof sent.id).toBe('string');
    expect((sent.id as string).length).toBeGreaterThan(0);
    await flush(); // let the pending entry register before clearing it
    t.cancelAll();
  });

  it('rejects with a timeout error when no response arrives', async () => {
    vi.useFakeTimers();
    try {
      const t = new ToolTranslator({ totalTimeoutMs: 5000 });
      const transport = makeTransport();
      t.attachToTransport(transport);
      const promise = t.callTool(transport, 'lag', {}, 'call-3');
      promise.catch(() => {});
      const assertion = expect(promise).rejects.toThrow(/timed out after 5000ms/);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelAll clears pending timers without rejecting', async () => {
    vi.useFakeTimers();
    try {
      const t = new ToolTranslator({ totalTimeoutMs: 1000 });
      const transport = makeTransport();
      t.attachToTransport(transport);
      // Two outstanding calls; attach a catch so an unexpected rejection is observable.
      let rejected = false;
      void t.callTool(transport, 'a', {}, 'a').catch(() => {
        rejected = true;
      });
      void t.callTool(transport, 'b', {}, 'b').catch(() => {
        rejected = true;
      });
      // Drain the send() microtasks so both pending entries (and their timers)
      // are registered before cancelAll runs.
      await vi.advanceTimersByTimeAsync(0);
      t.cancelAll();
      // Advancing past the timeout must not fire — timers were cleared.
      await vi.advanceTimersByTimeAsync(2000);
      expect(rejected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the provided options (custom poll interval / async flag) without error', () => {
    const t = new ToolTranslator({ asyncTools: false, pollIntervalMs: 100, totalTimeoutMs: 200 });
    expect(t).toBeInstanceOf(ToolTranslator);
  });
});
