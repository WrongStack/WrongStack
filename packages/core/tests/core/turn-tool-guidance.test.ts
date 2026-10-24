import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it, vi } from 'vitest';
import { createTurnToolGuidance } from '../../src/core/turn-tool-guidance.js';

function harness() {
  const afterTools = vi.fn(() => 'follow-up');
  const create = vi.fn(async () => ({ initialNote: 'candidate', afterTools }));
  const tool: Tool = {
    name: 'catalog',
    description: 'catalog',
    inputSchema: {},
    permission: 'auto',
    mutating: false,
    execute: vi.fn(),
    turnGuidance: { permissionInput: { action: 'list' }, requiredTools: ['runner'], create },
  };
  const runner: Tool = {
    ...tool,
    name: 'runner',
    permission: 'confirm',
    mutating: true,
    turnGuidance: undefined,
  };
  const tools = new Map([
    [tool.name, tool],
    [runner.name, runner],
  ]);
  const controller = new AbortController();
  const autoAllowed = vi.fn(async () => true);
  const options = {
    task: 'Check settings',
    projectRoot: '/project',
    signal: controller.signal,
    tools: [tool, runner],
    getTool: (name: string) => tools.get(name),
    autoAllowed,
    deadlineMs: 25,
  };
  return { tool, runner, tools, controller, autoAllowed, options, create, afterTools };
}

describe('turn tool guidance host boundary', () => {
  it('loads advice through automatic read policy without executing the tool', async () => {
    const h = harness();
    const advice = await createTurnToolGuidance(h.options);
    expect(advice.initialNote).toBe('candidate');
    expect(h.autoAllowed).toHaveBeenCalledWith(h.tool, { action: 'list' });
    expect(h.tool.execute).not.toHaveBeenCalled();
    expect(await advice.afterTools([], [])).toBe('follow-up');
  });
  it.each(['mutating', 'confirm', 'deny', 'hidden', 'missing-runner', 'denied-runner', 'policy'])(
    'does not load metadata when blocked by %s',
    async (kind) => {
      const h = harness();
      if (kind === 'mutating') h.tool.mutating = true;
      if (kind === 'confirm' || kind === 'deny') h.tool.permission = kind;
      if (kind === 'hidden') h.tools.delete('catalog');
      if (kind === 'missing-runner') h.tools.delete('runner');
      if (kind === 'denied-runner') h.runner.permission = 'deny';
      if (kind === 'policy') h.autoAllowed.mockResolvedValue(false);
      expect((await createTurnToolGuidance(h.options)).initialNote).toBeNull();
      expect(h.create).not.toHaveBeenCalled();
    },
  );
  it('rechecks disabling and policy changes before follow-up advice', async () => {
    const h = harness();
    const advice = await createTurnToolGuidance(h.options);
    h.autoAllowed.mockResolvedValue(false);
    expect(await advice.afterTools([], [])).toBeNull();
    h.autoAllowed.mockResolvedValue(true);
    h.tools.delete('runner');
    expect(await advice.afterTools([], [])).toBeNull();
    expect(h.afterTools).not.toHaveBeenCalled();
  });
  it('bounds slow factories and ignores late results', async () => {
    const h = harness();
    let finish!: (value: { initialNote: string; afterTools: typeof h.afterTools }) => void;
    h.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const advice = await createTurnToolGuidance(h.options);
    expect(advice.initialNote).toBeNull();
    finish({ initialNote: 'too late', afterTools: h.afterTools });
    await Promise.resolve();
    expect(await advice.afterTools([], [])).toBeNull();
  });
  it('bounds a stalled follow-up policy lookup', async () => {
    const h = harness();
    const advice = await createTurnToolGuidance(h.options);
    h.autoAllowed.mockImplementation(() => new Promise(() => {}));
    expect(await advice.afterTools([], [])).toBeNull();
    expect(h.afterTools).not.toHaveBeenCalled();
  });
  it('omits failed advice and respects cancellation', async () => {
    const h = harness();
    h.create.mockRejectedValue(new Error('broken metadata'));
    expect((await createTurnToolGuidance(h.options)).initialNote).toBeNull();
    h.create.mockClear();
    h.controller.abort();
    expect((await createTurnToolGuidance(h.options)).initialNote).toBeNull();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('caps prompt growth', async () => {
    const h = harness();
    h.create.mockResolvedValue({ initialNote: 'x'.repeat(5000), afterTools: h.afterTools });
    expect((await createTurnToolGuidance(h.options)).initialNote).toHaveLength(2400);
  });
});
