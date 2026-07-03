import { beforeEach, describe, expect, it, vi } from 'vitest';

const autoEscalatePlugin = (await import('../src/auto-escalate')).default;
const { errorText, isRetryable } = await import('../src/auto-escalate');

interface Tool {
  name: string;
  execute: (i: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
interface Ext {
  beforeRun?: () => void;
  onError?: (
    ctx: unknown,
    err: unknown,
    phase: unknown,
    i: number,
  ) => { action: string; model?: string } | void;
}

interface MockApi {
  tools: { register: (t: Tool) => void };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  extensions: { register: ReturnType<typeof vi.fn> };
  _tools: Record<string, Tool>;
  _ext?: Ext;
}

function setup(cfg: Record<string, unknown> = {}): MockApi {
  const tools: Record<string, Tool> = {};
  const api: MockApi = {
    tools: {
      register: (t: Tool) => {
        tools[t.name] = t;
      },
    },
    config: { extensions: { 'auto-escalate': cfg } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    extensions: {
      register: vi.fn((ext: Ext) => {
        api._ext = ext;
        return vi.fn();
      }),
    },
    _tools: tools,
  };
  autoEscalatePlugin.setup(api as never);
  api._tools = tools;
  return api;
}

beforeEach(() => vi.clearAllMocks());

describe('errorText / isRetryable', () => {
  it('stringifies errors', () => {
    expect(errorText(new Error('boom'))).toContain('boom');
    expect(errorText('plain')).toBe('plain');
  });
  it('matches retryable patterns case-insensitively', () => {
    const pats = [/overload/i, /\b429\b/i, /timeout/i];
    expect(isRetryable('Error: Overloaded (429)', pats)).toBe(true);
    expect(isRetryable('request timeout', pats)).toBe(true);
    expect(isRetryable('invalid api key', pats)).toBe(false);
  });
});

describe('auto-escalate plugin', () => {
  const ladder = ['m-mid', 'm-big'];

  it('is inert without enabled + a ladder', () => {
    expect(setup().extensions.register).not.toHaveBeenCalled();
    expect(setup({ enabled: true }).extensions.register).not.toHaveBeenCalled();
  });

  it('registers onError + beforeRun when enabled with a ladder', () => {
    const api = setup({ enabled: true, escalation: ladder });
    expect(api.extensions.register).toHaveBeenCalledTimes(1);
    expect(typeof api._ext?.onError).toBe('function');
    expect(typeof api._ext?.beforeRun).toBe('function');
  });

  it('escalates through the ladder on retryable errors, then defers', () => {
    const api = setup({ enabled: true, escalation: ladder });
    const err = new Error('Overloaded: 529');
    expect(api._ext!.onError!(null, err, 'provider', 0)).toEqual({
      action: 'retry',
      model: 'm-mid',
    });
    expect(api._ext!.onError!(null, err, 'provider', 1)).toEqual({
      action: 'retry',
      model: 'm-big',
    });
    // Ladder exhausted → returns nothing (defer to default handler).
    expect(api._ext!.onError!(null, err, 'provider', 2)).toBeUndefined();
  });

  it('ignores non-retryable errors', () => {
    const api = setup({ enabled: true, escalation: ladder });
    expect(
      api._ext!.onError!(null, new Error('invalid_request: bad schema'), 'provider', 0),
    ).toBeUndefined();
  });

  it('ignores non-provider phases', () => {
    const api = setup({ enabled: true, escalation: ladder });
    expect(api._ext!.onError!(null, new Error('timeout'), 'tool', 0)).toBeUndefined();
  });

  it('beforeRun resets the ladder position', () => {
    const api = setup({ enabled: true, escalation: ladder });
    api._ext!.onError!(null, new Error('overload'), 'provider', 0); // uses m-mid
    api._ext!.beforeRun!();
    // Fresh run starts at the first rung again.
    expect(api._ext!.onError!(null, new Error('overload'), 'provider', 0)).toEqual({
      action: 'retry',
      model: 'm-mid',
    });
  });

  it('status tool reports counters and last escalation', async () => {
    const api = setup({ enabled: true, escalation: ladder });
    api._ext!.onError!(null, new Error('rate limit hit'), 'provider', 0);
    const status = await api._tools.auto_escalate_status!.execute({});
    expect((status.counters as { escalationsRequested: number }).escalationsRequested).toBe(1);
    expect(status.lastEscalation).toMatchObject({ to: 'm-mid' });
  });

  it('teardown clears state and logs', async () => {
    const api = setup({ enabled: true, escalation: ladder });
    autoEscalatePlugin.teardown!(api as never);
    const health = (await autoEscalatePlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters.escalationsRequested).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'auto-escalate: teardown complete',
      expect.any(Object),
    );
  });
});
