/**
 * `tool_script`: a JavaScript program composing tool calls, run in QuickJS
 * with no access to anything but the agent's tool gate.
 */
import type { NestedToolCaller, NestedToolCallResult, Tool } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { toolScriptTool } from '../src/tool-script.js';
import { toolFlowMetrics } from '../src/toolflow-presentation.js';

type Call = Parameters<NestedToolCaller>[0];

function harness(answer: (call: Call) => Promise<NestedToolCallResult>) {
  const calls: Call[] = [];
  const ctx = {
    tools: [{ name: 'read' }, { name: 'grep' }, { name: 'codebase-search' }] as Tool[],
    catalogTools: undefined as Tool[] | undefined,
    meta: {} as Record<string, unknown>,
    nestedToolCall: (async (call) => {
      calls.push(call);
      return answer(call);
    }) as NestedToolCaller,
  };
  const run = (script: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) =>
    toolScriptTool.execute({ script, ...extra } as never, ctx as never, {
      signal: signal ?? new AbortController().signal,
      toolUseId: 'call_1',
    });
  return { run, calls, ctx };
}

const echo = async (call: Call) => ({
  content: `${call.name}:${JSON.stringify(call.input)}`,
  isError: false,
});

describe('tool_script', () => {
  it('returns structured values only through the explicit data helper and keeps text calls compatible', async () => {
    const h = harness(async () => ({
      content: 'formatted preview',
      isError: false,
      data: { files: ['a.ts'], truncated: false },
    }));
    h.ctx.catalogTools = [
      { ...h.ctx.tools[0]!, name: 'data', outputSchema: { type: 'object' } } as Tool,
    ];
    const output = await h.run(`
      if (!tools.describe('data').outputSchema) throw new Error('missing schema');
      const data = await tools.data('data', {});
      const text = await tools.call('data', {});
      return { first: data.files[0], text };
    `);
    expect(output).toContain('"first": "a.ts"');
    expect(output).toContain('"text": "formatted preview"');
    expect(h.calls[0]?.resultFormat).toBe('data');
    expect(h.calls[1]?.resultFormat).toBeUndefined();
  });

  it('transfers scalar null without confusing it with missing structured data', async () => {
    const h = harness(async () => ({ content: 'null', isError: false, data: null }));
    expect(await h.run('return (await tools.data("read", {})) === null;')).toContain('true');
    const legacy = harness(echo);
    await expect(legacy.run('return await tools.data("read", {});')).rejects.toThrow(
      'did not supply structured output',
    );
  });
  it('discovers deferred schemas inside the VM and calls them through the gate', async () => {
    const h = harness(echo);
    h.ctx.catalogTools = [
      ...h.ctx.tools,
      {
        name: 'mcp-report',
        description: 'Read a report',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        usageHint: 'Supply the report ID.',
        permission: 'confirm',
        mutating: false,
        async execute() {
          return '';
        },
      } as Tool,
    ];
    const out = await h.run(`
      const name = tools.names().find(n => n === 'mcp-report');
      const schema = tools.describe(name);
      if (schema.inputSchema.required[0] !== 'id' || schema.permission !== 'confirm') throw new Error('wrong schema');
      if (schema.usageHint !== 'Supply the report ID.') throw new Error('missing guidance');
      return await tools.call(name, { id: 'r1' });
    `);
    expect(out).toContain('mcp-report:{"id":"r1"}');
    expect(h.calls).toEqual([
      { name: 'mcp-report', input: { id: 'r1' }, parentToolUseId: 'call_1', index: 1 },
    ]);
  });

  it('keeps discovery helpers usable when catalog names collide', async () => {
    const h = harness(echo);
    h.ctx.catalogTools = [
      ...h.ctx.tools,
      ...['call', 'names', 'describe'].map((name) => ({ name }) as Tool),
      toolScriptTool,
    ];
    const out = await h.run(`
      if (tools.names().includes('tool_script')) throw new Error('recursive tool exposed');
      return await Promise.all(['call', 'names', 'describe'].map(n => tools.call(tools.describe(n).name, {})));
    `);
    expect(h.calls.map((c) => c.name)).toEqual(['call', 'names', 'describe']);
    expect(out).toContain('describe:{}');
    await expect(h.run(`return tools.describe('disabled');`)).rejects.toThrow(
      'No enabled tool named "disabled"',
    );
    expect(h.calls).toHaveLength(3);
  });

  it('reduces 50 large fixture results to one small answer', async () => {
    let rawBytes = 0;
    const h = harness(async (call) => {
      const content = JSON.stringify({
        id: (call.input as { id: number }).id,
        detail: 'RAW_DETAIL_'.repeat(1000),
      });
      rawBytes += Buffer.byteLength(content);
      return { content, isError: false };
    });
    const out = await h.run(`
      let count = 0;
      let sum = 0;
      for (let start = 0; start < 50; start += 5) {
        const results = await Promise.all(Array.from({ length: 5 }, (_, i) => tools.read({ id: start + i })));
        for (const text of results) { count++; sum += JSON.parse(text).id; }
      }
      return { count, sum };
    `);
    expect(h.calls).toHaveLength(50);
    expect(out).toContain('"count": 50');
    expect(out).toContain('"sum": 1225');
    expect(out).not.toContain('RAW_DETAIL');
    expect(rawBytes).toBeGreaterThan(500_000);
    expect(Buffer.byteLength(out)).toBeLessThan(150);
    expect(toolFlowMetrics(out)?.toolResultBytes).toBe(rawBytes);
    expect(toolFlowMetrics(out)?.calls).toBe(50);
  });

  it('measures UTF-8 returned text including console output without counting the metrics suffix', async () => {
    const h = harness(async () => ({ content: 'ş🙂', isError: false }));
    const output = await h.run('await tools.read({}); console.log("ö🙂"); return "ğ🙂";');
    expect(toolFlowMetrics(output)?.toolResultBytes).toBe(Buffer.byteLength('ş🙂'));
    expect(toolFlowMetrics(output)?.returnedBytes).toBe(
      Buffer.byteLength(output.slice(0, output.lastIndexOf('\n\nToolFlow bytes:'))),
    );
  });

  it('composes tool calls and returns only the final value', async () => {
    const h = harness(echo);
    const out = await h.run(`
      const a = await tools.read({ path: 'a.ts' });
      const b = await tools.call('codebase-search', { query: 'x' });
      return { a, b };
    `);
    expect(out).toContain('"a": "read:{\\"path\\":\\"a.ts\\"}"');
    expect(out).toContain('"b": "codebase-search:{\\"query\\":\\"x\\"}"');
    expect(out).toContain('(2 tool calls: read, codebase-search)');
    // Numbered under the script's own call, for the session record.
    expect(h.calls.map((c) => [c.parentToolUseId, c.index])).toEqual([
      ['call_1', 1],
      ['call_1', 2],
    ]);
  });

  it('runs calls side by side with Promise.all', async () => {
    let inFlight = 0;
    let peak = 0;
    const h = harness(async (call) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
      return echo(call);
    });
    const out = await h.run(
      `return (await Promise.all(['a','b','c'].map((p) => tools.read({ path: p })))).length;`,
    );
    expect(out.startsWith('3')).toBe(true);
    expect(peak).toBe(3);
  });

  it('turns a failed call into an exception the script can catch', async () => {
    const h = harness(async () => ({ content: 'no such file', isError: true }));
    const out = await h.run(
      `try { await tools.read({ path: 'x' }); } catch (e) { return 'caught: ' + e.message; }`,
    );
    expect(out).toContain('caught: no such file');
    expect(out).toContain('(1 tool call: read (1 failed))');
    expect(toolFlowMetrics(out)?.failedCalls).toBe(1);
  });

  it('reports an uncaught error with the calls that already ran', async () => {
    const h = harness(echo);
    await expect(h.run(`await tools.grep({ q: 'x' }); throw new Error('boom');`)).rejects.toThrow(
      'The script failed: Error: boom (1 tool call: grep)',
    );
    await expect(h.run('return (;')).rejects.toThrow('SyntaxError');
  });

  it('has no filesystem, network, process or module access', async () => {
    const h = harness(echo);
    const out = await h.run(
      'return [typeof require, typeof process, typeof fetch, typeof std, typeof os, typeof XMLHttpRequest].join(",");',
    );
    expect(out.split('\n')[0]).toBe('undefined,undefined,undefined,undefined,undefined,undefined');
    await expect(h.run(`await import('fs');`)).rejects.toThrow(/script failed/);
    expect(h.calls).toEqual([]);
  });

  it('stops a script that runs past its time limit or loops forever', async () => {
    const h = harness(echo);
    await expect(h.run('while (true) {}', { timeout_ms: 300 })).rejects.toThrow(
      'ran past its 300 ms limit',
    );
    await expect(h.run(`await new Promise(() => {});`, { timeout_ms: 200 })).rejects.toThrow(
      'ran past its 200 ms limit',
    );
  });

  it('stops a script that computes without pausing, even with no time limit', async () => {
    const h = harness(echo);
    // An endless loop never yields to the event loop, so nothing else could stop it.
    await expect(h.run('while (true) {}', { timeout_ms: 0 })).rejects.toThrow(
      'computed for 5000 ms without pausing at an await',
    );
  }, 20_000);

  it('lets computation that pauses at awaits add up past the unpaused limit', async () => {
    const h = harness(echo);
    const out = await h.run(
      `for (let i = 0; i < 3; i++) {
         const end = Date.now() + 2000;
         while (Date.now() < end) {}
         await tools.read({ i });
       }
       return 'computed about 6s';`,
      { timeout_ms: 0 },
    );
    expect(out.startsWith('computed about 6s')).toBe(true);
  }, 30_000);

  it('has no call limit or output cut of its own', async () => {
    const h = harness(echo);
    const out = await h.run(
      `for (let i = 0; i < 80; i++) await tools.read({ i });
       console.log('y'.repeat(20000));
       return 'x'.repeat(150000);`,
    );
    expect(h.calls).toHaveLength(80);
    expect(out).toContain('x'.repeat(150000));
    expect(out).toContain(`console:\n${'y'.repeat(20000)}`);
    expect(out).toContain('(80 tool calls: read ×80)');
    // Its own timer governs `timeout_ms`, so the executor's generic ceiling does not apply.
    expect(toolScriptTool.managesOwnTimeout).toBe(true);
  });

  it('holds a script to its memory limit', async () => {
    const h = harness(echo);
    await expect(h.run(`const a = []; while (true) a.push('x'.repeat(1 << 20));`)).rejects.toThrow(
      /out of memory/,
    );
  });

  it('refuses calls past max_calls and a script inside a script', async () => {
    const h = harness(echo);
    const out = await h.run(
      `const r = [];
       for (let i = 0; i < 3; i++) { try { r.push(await tools.read({ i })); } catch (e) { r.push(e.message); } }
       try { await tools.call('tool_script', { script: 'return 1' }); } catch (e) { r.push(e.message); }
       return r;`,
      { max_calls: 2 },
    );
    expect(out).toContain('The script reached its limit of 2 tool calls.');
    expect(out).toContain('A tool script cannot run another tool script.');
    expect(h.calls).toHaveLength(2);

    // Reached through `tool_use`, the inner script finds the outer one running.
    h.ctx.meta.toolScriptRunning = true;
    await expect(h.run('return 1')).rejects.toThrow('cannot run inside another tool script');
  });

  it('stops when the run is aborted', async () => {
    let complete: ((value: { content: string; isError: boolean }) => void) | undefined;
    const h = harness(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = h.run(`await tools.read({ path: 'slow' });`, {}, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow('the run was stopped');
    // Keep the context locked until already-started effects settle.
    expect(h.ctx.meta.toolScriptRunning).toBe(true);
    await expect(h.run('return 1')).rejects.toThrow('inside another tool script');
    complete?.({ content: 'done', isError: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.ctx.meta.toolScriptRunning).toBeUndefined();
  });

  it('reports a cut-short call still in flight as running, not failed', async () => {
    // A write still running must not read as failed: the model would repeat it.
    const h = harness((call) =>
      (call.input as { n: number }).n === 1
        ? Promise.resolve({ content: 'no such file', isError: true })
        : new Promise(() => {}),
    );
    const message = await h
      .run(
        `try { await tools.read({ n: 1 }); } catch {} tools.read({ n: 2 }); await new Promise(() => {});`,
        { timeout_ms: 200 },
      )
      .catch((err: Error) => err.message);
    expect(message).toContain(
      '2 tool calls: read ×2 (1 failed); calls already started keep running',
    );

    const settled = harness(async () => ({ content: 'no such file', isError: true }));
    const onlyFailed = await settled
      .run(`try { await tools.read({ n: 1 }); } catch {} await new Promise(() => {});`, {
        timeout_ms: 200,
      })
      .catch((err: Error) => err.message);
    expect(onlyFailed).toContain('1 tool call: read (1 failed).');
    expect(onlyFailed).not.toContain('keep running');
  });

  it('starts no calls for an already-aborted run', async () => {
    const h = harness(echo);
    const controller = new AbortController();
    controller.abort();
    await expect(h.run('await tools.read({});', {}, controller.signal)).rejects.toThrow(
      'the run was stopped',
    );
    expect(h.calls).toHaveLength(0);
    expect(h.ctx.meta.toolScriptRunning).toBeUndefined();
  });

  it('rejects unawaited effects and releases the lock only after they settle', async () => {
    let complete: ((value: { content: string; isError: boolean }) => void) | undefined;
    const h = harness(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await expect(h.run('tools.read({}); return "done";')).rejects.toThrow('unfinished tool calls');
    expect(h.ctx.meta.toolScriptRunning).toBe(true);
    complete?.({ content: 'done', isError: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.ctx.meta.toolScriptRunning).toBeUndefined();
    expect(await h.run('return "recovered";')).toContain('recovered');
  });

  it('does not run two scripts concurrently on the same context', async () => {
    const h = harness(async (call) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return echo(call);
    });
    const results = await Promise.allSettled([
      h.run('return await tools.read({});'),
      h.run('return await tools.read({});'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(h.ctx.meta.toolScriptRunning).toBeUndefined();
  });

  it('returns console output with the result', async () => {
    const h = harness(echo);
    const out = await h.run(`console.log('step', 1, { ok: true }); return 'done';`);
    expect(out).toContain('done');
    expect(out).toContain('console:\nstep 1 {\n  "ok": true\n}');
  });

  it('refuses to run without the agent tool gate', async () => {
    await expect(
      toolScriptTool.execute({ script: 'return 1' }, { tools: [], meta: {} } as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('no tool gate');
  });
});
