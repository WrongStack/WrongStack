import { beforeEach, describe, expect, it, vi } from 'vitest';

const promptFirewallPlugin = (await import('../src/prompt-firewall')).default;
const { detectSecrets, readConfig, redactSecrets, KIND_ALIASES } = await import(
  '../src/prompt-firewall'
);

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
    const original = req(`use ${GH_TOKEN} now`);
    await api._wrap!(null, original, inner);
    const sent = JSON.stringify(inner.mock.calls[0]![1]);
    expect(sent).not.toContain(GH_TOKEN);
    expect(sent).toContain('[REDACTED:github-token]');
    expect(JSON.stringify(original)).toContain(GH_TOKEN);
    const status = await api._tools.prompt_firewall_status!.execute({});
    expect(
      (status.counters as { requestRedactions: number }).requestRedactions,
    ).toBeGreaterThanOrEqual(1);
  });

  it('redact mode clones AKIA keys and leaves the original request untouched', async () => {
    const api = setup({ enabled: true, mode: 'redact' });
    const inner = vi.fn().mockResolvedValue(resp('ok'));
    const original = req(`key ${AWS_KEY}`);
    await api._wrap!(null, original, inner);
    const sent = inner.mock.calls[0]![1] as typeof original;
    expect(JSON.stringify(sent)).toContain('[REDACTED:aws-access-key]');
    expect(JSON.stringify(original)).toContain(AWS_KEY);
    expect(sent).not.toBe(original);
  });

  it('lets PEM certificate and base64 padding fixtures through unchanged', async () => {
    const pem =
      '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHHHexample\n-----END CERTIFICATE-----';
    const b64 = 'SGVsbG8gV29ybGQhISE=';
    const api = setup({ enabled: true, mode: 'redact' });
    const inner = vi.fn().mockResolvedValue(resp('ok'));
    const original = req(`cert=${pem}\npadding=${b64}`);
    await api._wrap!(null, original, inner);
    expect(inner).toHaveBeenCalled();
    const sent = JSON.stringify(inner.mock.calls[0]![1]);
    expect(sent).toContain('BEGIN CERTIFICATE');
    expect(sent).toContain(b64);
  });

  it('pins KIND_ALIASES legacy spellings (issue #362)', () => {
    expect(KIND_ALIASES.aws_access_key).toBe('aws-access-key');
    expect(KIND_ALIASES.private_key).toBe('private-key-block');
    expect(KIND_ALIASES.github_pat).toBe('github-token');
    expect(KIND_ALIASES.openai_key).toBe('openai-key');
  });

  it('loads after llm-cache in the official export order (outer wrap)', async () => {
    const generated = await import('../src/generated-plugin-exports.js');
    const keys = Object.keys(generated);
    expect(keys.indexOf('llmCachePlugin')).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf('promptFirewallPlugin')).toBeGreaterThan(keys.indexOf('llmCachePlugin'));
  });

  it('setup twice unregisters the first wrap (H1 reload)', () => {
    const unregister = vi.fn();
    const tools: Record<string, Tool> = {};
    const api: MockApi = {
      tools: { register: (t: Tool) => { tools[t.name] = t; } },
      config: { extensions: { 'prompt-firewall': { enabled: true } } },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
      extensions: { register: vi.fn(() => unregister) },
      emitCustom: vi.fn(),
      _tools: tools,
    };
    promptFirewallPlugin.setup(api as never);
    promptFirewallPlugin.setup(api as never);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  const postgresQueryPassword =
    ['postgresql', '://', 'db', '/app?', 'user=alice&', 'password=', 'query-secret'].join('');
  const encodedPostgresQueryPassword =
    ['postgresql', '://', 'db', '/app?', 'user=alice&', 'pass%77ord=', 'query-secret'].join('');

  it.each([
    ['literal', postgresQueryPassword],
    ['percent-encoded', encodedPostgresQueryPassword],
  ] as const)('block mode rejects a PostgreSQL URI with a %s password query parameter', async (_label, uri) => {
    const api = setup({ enabled: true, mode: 'block' });
    const inner = vi.fn().mockResolvedValue(resp('clean'));
    await expect(api._wrap!(null, req(uri), inner)).rejects.toThrow(/postgres_uri/);
    expect(inner).not.toHaveBeenCalled();
  });

  it.each([
    ['literal', postgresQueryPassword],
    ['percent-encoded', encodedPostgresQueryPassword],
  ] as const)('redact mode strips a PostgreSQL URI with a %s password query parameter', async (_label, uri) => {
    const api = setup({ enabled: true, mode: 'redact' });
    const inner = vi.fn().mockResolvedValue(resp('clean'));
    await api._wrap!(null, req(uri), inner);
    const sent = JSON.stringify(inner.mock.calls[0]![1]);
    expect(sent).not.toContain('query-secret');
    expect(sent).toContain('[REDACTED:postgres_uri]');
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

describe('readConfig mode resolution', () => {
  it('defaults to redact when mode is absent (the locking assertion the user asked for)', () => {
    expect(readConfig({ enabled: true }).mode).toBe('redact');
  });

  it('honours explicit warn, block, and redact modes', () => {
    expect(readConfig({ enabled: true, mode: 'warn' }).mode).toBe('warn');
    expect(readConfig({ enabled: true, mode: 'block' }).mode).toBe('block');
    expect(readConfig({ enabled: true, mode: 'redact' }).mode).toBe('redact');
  });

  it('falls back to redact for unknown mode values (fail-closed)', () => {
    expect(readConfig({ enabled: true, mode: 'wran' }).mode).toBe('redact');
  });

  it('falls back to redact for non-object / null / undefined config (base defaults)', () => {
    expect(readConfig(undefined).mode).toBe('redact');
    expect(readConfig(null).mode).toBe('redact');
    expect(readConfig('garbage').mode).toBe('redact');
  });
});

describe('default mode end-to-end', () => {
  it('redacts secrets on the wire when enabled without an explicit mode', async () => {
    const api = setup({ enabled: true });
    const inner = vi.fn().mockResolvedValue(resp('ok'));
    await api._wrap!(null, req(`use ${GH_TOKEN} now`), inner);
    const sent = JSON.stringify(inner.mock.calls[0]![1]);
    expect(sent).not.toContain(GH_TOKEN);
    expect(sent).toContain('[REDACTED:github-token]');
  });
});
