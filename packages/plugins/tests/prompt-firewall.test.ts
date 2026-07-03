import { beforeEach, describe, expect, it, vi } from 'vitest';

const promptFirewallPlugin = (await import('../src/prompt-firewall')).default;
const { detectSecrets, redactSecrets } = await import('../src/prompt-firewall');

interface Tool {
  name: string;
  execute: (i: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
type WrapFn = (
  ctx: unknown,
  req: unknown,
  inner: (c: unknown, r: unknown) => Promise<unknown>,
) => Promise<unknown>;

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
  emitCustom: ReturnType<typeof vi.fn>;
  _tools: Record<string, Tool>;
  _wrap?: WrapFn;
}

function setup(cfg: Record<string, unknown> = {}): MockApi {
  const tools: Record<string, Tool> = {};
  const api: MockApi = {
    tools: {
      register: (t: Tool) => {
        tools[t.name] = t;
      },
    },
    config: { extensions: { 'prompt-firewall': cfg } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    extensions: {
      register: vi.fn((ext: { wrapProviderRunner?: WrapFn }) => {
        api._wrap = ext.wrapProviderRunner;
        return vi.fn();
      }),
    },
    emitCustom: vi.fn(),
    _tools: tools,
  };
  promptFirewallPlugin.setup(api as never);
  api._tools = tools;
  return api;
}

const GH_TOKEN = 'ghp_' + 'A'.repeat(38);
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

const req = (text: string) => ({
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
});

const resp = (text: string) => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { input: 1, output: 1 },
  model: 'm',
});

beforeEach(() => vi.clearAllMocks());

describe('detectSecrets / redactSecrets', () => {
  it('detects common credential shapes', () => {
    const kinds = detectSecrets(`token=${GH_TOKEN} and key ${AWS_KEY}`, []).map((d) => d.kind);
    expect(kinds).toContain('github-token');
    expect(kinds).toContain('aws-access-key');
  });

  it('ignores ordinary prose', () => {
    expect(detectSecrets('the quick brown fox jumps over the lazy dog', [])).toHaveLength(0);
  });

  it('redacts matches with a kind tag', () => {
    const { text, redactions } = redactSecrets(`x ${GH_TOKEN} y`, []);
    expect(text).toContain('[REDACTED:github-token]');
    expect(text).not.toContain(GH_TOKEN);
    expect(redactions).toBeGreaterThanOrEqual(1);
  });

  it('respects allow patterns', () => {
    const allow = [new RegExp(GH_TOKEN)];
    expect(detectSecrets(`token=${GH_TOKEN}`, allow)).toHaveLength(0);
  });
});

describe('prompt-firewall plugin', () => {
  it('is inert when disabled', () => {
    expect(setup().extensions.register).not.toHaveBeenCalled();
  });

  it('warn mode detects but passes the request through unchanged', async () => {
    const api = setup({ enabled: true, mode: 'warn' });
    const inner = vi.fn().mockResolvedValue(resp('ok'));
    await api._wrap!(null, req(`here is ${GH_TOKEN}`), inner);
    // Request forwarded unchanged (same object).
    expect((inner.mock.calls[0]![1] as { messages: unknown }).messages).toEqual(
      req(`here is ${GH_TOKEN}`).messages,
    );
    expect(api.log.warn).toHaveBeenCalled();
    expect(api.emitCustom).toHaveBeenCalledWith(
      'prompt-firewall:leak',
      expect.objectContaining({ where: 'request' }),
    );
    const status = await api._tools.prompt_firewall_status!.execute({});
    expect((status.counters as { requestsWithSecrets: number }).requestsWithSecrets).toBe(1);
  });

  it('block mode throws before the request is sent', async () => {
    const api = setup({ enabled: true, mode: 'block' });
    const inner = vi.fn().mockResolvedValue(resp('ok'));
    await expect(api._wrap!(null, req(`secret ${AWS_KEY}`), inner)).rejects.toThrow(
      /prompt-firewall blocked/,
    );
    expect(inner).not.toHaveBeenCalled();
    const status = await api._tools.prompt_firewall_status!.execute({});
    expect((status.counters as { blocked: number }).blocked).toBe(1);
  });

  it('redact mode strips secrets from the outgoing request', async () => {
    const api = setup({ enabled: true, mode: 'redact' });
    const inner = vi.fn().mockResolvedValue(resp('clean'));
    await api._wrap!(null, req(`use ${GH_TOKEN} now`), inner);
    const sent = JSON.stringify(inner.mock.calls[0]![1]);
    expect(sent).not.toContain(GH_TOKEN);
    expect(sent).toContain('[REDACTED:github-token]');
    const status = await api._tools.prompt_firewall_status!.execute({});
    expect(
      (status.counters as { requestRedactions: number }).requestRedactions,
    ).toBeGreaterThanOrEqual(1);
  });

  it('redact mode also redacts secrets echoed back in the response', async () => {
    const api = setup({ enabled: true, mode: 'redact', scanResponse: true });
    const inner = vi.fn().mockResolvedValue(resp(`the key is ${AWS_KEY}`));
    const out = (await api._wrap!(null, req('nothing here'), inner)) as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0]!.text).toContain('[REDACTED:aws-access-key]');
    expect(JSON.stringify(out)).not.toContain(AWS_KEY);
  });

  it('does not redact the response when scanResponse is false', async () => {
    const api = setup({ enabled: true, mode: 'redact', scanResponse: false });
    const inner = vi.fn().mockResolvedValue(resp(`key ${AWS_KEY}`));
    const out = (await api._wrap!(null, req('clean'), inner)) as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0]!.text).toContain(AWS_KEY);
  });

  it('clean requests pass straight through with no detections', async () => {
    const api = setup({ enabled: true, mode: 'redact' });
    const inner = vi.fn().mockResolvedValue(resp('all good'));
    await api._wrap!(null, req('just a normal question'), inner);
    const status = await api._tools.prompt_firewall_status!.execute({});
    expect((status.counters as { requestsWithSecrets: number }).requestsWithSecrets).toBe(0);
  });

  it('teardown clears state and logs', async () => {
    const api = setup({ enabled: true, mode: 'warn' });
    promptFirewallPlugin.teardown!(api as never);
    const health = (await promptFirewallPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters.requestsWithSecrets).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'prompt-firewall: teardown complete',
      expect.any(Object),
    );
  });
});
