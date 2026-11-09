import { beforeEach, describe, expect, it, vi } from 'vitest';

type Values = Record<string, string>;
interface Option {
  id: string;
  category?: string;
  currentValue: string;
  options: { value: string }[];
}

const inspectAcpRuntime = vi.fn(
  async (_config: unknown, _root: string, _agent: string, _values: Values) => ({
    options: [] as Option[],
  }),
);
const setSessionAcpRuntime = vi.fn(async (_ctx: unknown, _settings: unknown) => {});
const setSessionSubagentModelPlan = vi.fn(async (_ctx: unknown, _plan: unknown) => {});
let sessionSettings: Record<string, Values> = {};

vi.mock('@wrongstack/fleet', () => ({
  inspectAcpRuntime: (...args: Parameters<typeof inspectAcpRuntime>) => inspectAcpRuntime(...args),
}));
vi.mock('@wrongstack/coordination', () => ({
  normalizeSubagentModelPlan: (plan: unknown) => plan ?? { slots: [] },
  sessionAcpRuntime: () => sessionSettings,
  setSessionAcpRuntime: (...args: Parameters<typeof setSessionAcpRuntime>) =>
    setSessionAcpRuntime(...args),
  setSessionSubagentModelPlan: (...args: Parameters<typeof setSessionSubagentModelPlan>) =>
    setSessionSubagentModelPlan(...args),
}));

const { configureAcpRuntime } = await import('../src/portable-commands/acp-runtime-config.js');

const opts = { configStore: { get: () => ({}) }, projectRoot: '/p' } as never;
const ctxWith = (plan?: unknown) =>
  ({ session: { id: 's1' }, meta: { subagentModelPlan: plan } }) as never;
const model: Option = {
  id: 'model',
  category: 'model',
  currentValue: 'sonnet',
  options: [{ value: 'sonnet' }, { value: 'opus' }],
};
const effort: Option = {
  id: 'effort',
  category: 'thought_level',
  currentValue: 'high',
  options: [{ value: 'low' }, { value: 'high' }],
};

describe('/acp config', () => {
  beforeEach(() => {
    inspectAcpRuntime.mockReset();
    inspectAcpRuntime.mockResolvedValue({ options: [model, effort] });
    setSessionAcpRuntime.mockClear();
    setSessionSubagentModelPlan.mockClear();
    sessionSettings = {};
  });

  it('refuses without a live session, an agent, or a well-formed target', async () => {
    const refusals = await Promise.all([
      configureAcpRuntime('claude-code', opts, undefined as never),
      configureAcpRuntime('', opts, ctxWith()),
      configureAcpRuntime('claude-code --lane=1 --role=review', opts, ctxWith()),
      configureAcpRuntime('claude-code --lane=3', opts, ctxWith({ slots: [{}] })),
      configureAcpRuntime('claude-code --role=__proto__', opts, ctxWith()),
      configureAcpRuntime('claude-code model', opts, ctxWith()),
    ]);
    expect(refusals.map((r) => r.message)).toEqual([
      'ACP settings failed: A live session is required.',
      'ACP settings failed: Usage: /acp config <agent> [--lane=N|--role=name] [option value|reset]',
      'ACP settings failed: Choose a lane or role, not both.',
      'ACP settings failed: Choose an existing lane number.',
      'ACP settings failed: A valid role name is required.',
      'ACP settings failed: Provide both option id and value.',
    ]);
    expect(setSessionAcpRuntime).not.toHaveBeenCalled();
  });

  it('shows the agent’s settings without saving when no option is given', async () => {
    sessionSettings = { 'claude-code': { effort: 'high' } };
    const { message } = await configureAcpRuntime('claude-code', opts, ctxWith());
    expect(inspectAcpRuntime).toHaveBeenCalledWith({}, '/p', 'claude-code', { effort: 'high' });
    expect(message).toBe(
      'ACP claude-code\nmodel: sonnet\n  sonnet | opus\neffort: high\n  low | high',
    );
    expect(setSessionAcpRuntime).not.toHaveBeenCalled();
  });

  it('saves a session value, and a model change drops the non-model choices', async () => {
    sessionSettings = { 'claude-code': { model: 'sonnet', effort: 'high' }, other: { x: 'y' } };
    const { message } = await configureAcpRuntime('claude-code model "opus"', opts, ctxWith());
    expect(setSessionAcpRuntime).toHaveBeenCalledWith(expect.anything(), {
      other: { x: 'y' },
      'claude-code': { model: 'opus' },
    });
    expect(message).toMatch(/^ACP claude-code — saved for next turn\/spawn/);

    await configureAcpRuntime('claude-code effort low', opts, ctxWith());
    expect(setSessionAcpRuntime).toHaveBeenLastCalledWith(expect.anything(), {
      other: { x: 'y' },
      'claude-code': { model: 'sonnet', effort: 'low' },
    });
  });

  it('pins a lane to the agent with its values, and reset clears them', async () => {
    const plan = { slots: [{ provider: 'openai', model: 'gpt' }, {}] };
    await configureAcpRuntime('claude-code --lane=1 effort low', opts, ctxWith(plan));
    expect(setSessionSubagentModelPlan).toHaveBeenCalledWith(expect.anything(), {
      slots: [
        {
          provider: 'acp',
          model: 'claude-code',
          modelRuntime: { acp: { 'claude-code': { effort: 'low' } } },
        },
        {},
      ],
    });

    await configureAcpRuntime('claude-code --lane=2 reset', opts, ctxWith(plan));
    expect(setSessionSubagentModelPlan).toHaveBeenLastCalledWith(expect.anything(), {
      slots: [plan.slots[0], { modelRuntime: { acp: { 'claude-code': {} } } }],
    });
    expect(setSessionAcpRuntime).not.toHaveBeenCalled();
  });

  it('sets a role route, and reports an agent without settings', async () => {
    inspectAcpRuntime.mockResolvedValue({ options: [] });
    const plan = { slots: [], roles: { review: { provider: 'openai', model: 'gpt' } } };
    const { message } = await configureAcpRuntime(
      'claude-code --role=review mode plan',
      opts,
      ctxWith(plan),
    );
    expect(setSessionSubagentModelPlan).toHaveBeenCalledWith(expect.anything(), {
      slots: [],
      roles: {
        review: {
          provider: 'acp',
          model: 'claude-code',
          modelRuntime: { acp: { 'claude-code': { mode: 'plan' } } },
        },
      },
    });
    expect(message).toContain('No model or effort settings advertised.');
  });
});
