import { describe, expect, it, vi } from 'vitest';
import costTrackerPlugin from '../src/cost-tracker';

interface Tool {
  name: string;
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function setup(): { tools: Record<string, Tool>; fire: (p: unknown) => void } {
  const tools: Record<string, Tool> = {};
  let responseHandler: ((p: unknown) => void) | undefined;
  const api = {
    tools: {
      register: (t: Tool) => {
        tools[t.name] = t;
      },
    },
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    onEvent: (name: string, fn: (p: unknown) => void) => {
      if (name === 'provider.response') responseHandler = fn;
    },
  };
  costTrackerPlugin.setup(api as never);
  return { tools, fire: (p) => responseHandler?.(p) };
}

describe('cost_export with recorded requests', () => {
  it('emits CSV rows without the model column when includeModel=false', async () => {
    const { tools, fire } = setup();
    fire({ usage: { input: 100, output: 50 }, ctx: { model: 'claude-opus-4-8' } });
    fire({ usage: { input: 10, output: 5 }, ctx: { model: 'claude-haiku-4-5' } });

    const res = await tools.cost_export!.execute({ format: 'csv', includeModel: false });
    const lines = (res.data as string).split('\n');
    expect(lines[0]).toBe('timestamp,prompt_tokens,completion_tokens,total_tokens,cost_usd');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).not.toContain('claude-opus'); // model column omitted
    expect((res.summary as { totalRequests: number }).totalRequests).toBe(2);
  });

  it('emits CSV rows with the model column by default', async () => {
    const { tools, fire } = setup();
    fire({ usage: { input: 100, output: 50 }, ctx: { model: 'claude-opus-4-8' } });
    const res = await tools.cost_export!.execute({ format: 'csv' });
    expect(res.data as string).toContain('claude-opus-4-8');
  });

  it('strips the model field from JSON requests when includeModel=false', async () => {
    const { tools, fire } = setup();
    fire({ usage: { input: 100, output: 50 }, ctx: { model: 'claude-opus-4-8' } });

    const res = await tools.cost_export!.execute({ format: 'json', includeModel: false });
    const requests = (res.data as { requests: Array<Record<string, unknown>> }).requests;
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('model');
    expect(requests[0]).toHaveProperty('promptTokens', 100);
  });

  it('keeps full request records (with model) in JSON by default', async () => {
    const { tools, fire } = setup();
    fire({ usage: { input: 100, output: 50 }, ctx: { model: 'claude-opus-4-8' } });
    const res = await tools.cost_export!.execute({ format: 'json' });
    const requests = (res.data as { requests: Array<Record<string, unknown>> }).requests;
    expect(requests[0]).toHaveProperty('model', 'claude-opus-4-8');
  });

  it('records usage with a missing model/usage gracefully', async () => {
    const { tools, fire } = setup();
    fire({ usage: {}, ctx: {} }); // no input/output, no model → defaults
    const res = await tools.cost_summary!.execute({});
    expect((res.usage as { totalRequests: number }).totalRequests).toBe(1);
    expect((res.usage as { totalTokens: number }).totalTokens).toBe(0);
  });
});
