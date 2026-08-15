import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fully inline stub — never spawns a real worker thread (chimera review:
// wrapping the real implementation made every probe pay a worker spin,
// which is slow and flaky on Windows eval workers). Tests override with
// mockImplementation for timeout paths; every path stays inline.
vi.mock('../src/runtime/redos-guard.js', () => ({
  withReDoSGuard: vi.fn(async (re: RegExp, input: string) => {
    re.lastIndex = 0;
    return { timedOut: false, match: re.exec(input) };
  }),
}));

const promptFirewallPlugin = (await import('../src/prompt-firewall')).default;
const { detectSecrets, readConfig, redactSecrets, KIND_ALIASES } = await import(
  '../src/prompt-firewall'
);
const { withReDoSGuard } = await import('../src/runtime/redos-guard.js');

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

  it('is listed before llm-cache in the official manifest (outer wrap, issue #362)', async () => {
    // ExtensionRegistry composes wrapProviderRunner first-registered =
    // outermost. The manifest order (and llm-cache's optionalDeps on this
    // plugin) must keep the firewall OUTSIDE the cache so a cache hit can
    // never short-circuit redaction.
    const { OFFICIAL_PLUGIN_MANIFEST } = await import('../src/manifest/index.js');
    const names = OFFICIAL_PLUGIN_MANIFEST.map((e: { name: string }) => e.name);
    expect(names.indexOf('prompt-firewall')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('llm-cache')).toBeGreaterThan(names.indexOf('prompt-firewall'));

    const { default: llmCachePlugin } = await import('../src/llm-cache/index.js');
    expect(llmCachePlugin.optionalDeps).toContain('prompt-firewall');
  });

  it('composed stack redacts before llm-cache keys and caches (issue #362 regression)', async () => {
    // Mirror the real composition: ExtensionRegistry with the firewall
    // extension registered BEFORE the llm-cache extension (registration
    // order guaranteed by the manifest + optionalDeps pin above).
    const { ExtensionRegistry } = await import('../../core/src/extension/registry.js');
    const llmCache = (await import('../src/llm-cache/index.js')).default;
    const firewallApi = setup({ enabled: true, mode: 'redact' });
    const cacheApi = (() => {
      const tools: Record<string, Tool> = {};
      const api: MockApi = {
        tools: { register: (t: Tool) => { tools[t.name] = t; } },
        config: { extensions: { 'llm-cache': { enabled: true } } },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
        extensions: {
          register: vi.fn((ext: { wrapProviderRunner?: WrapFn }) => {
            (api as { _wrap?: WrapFn })._wrap = ext.wrapProviderRunner;
            return vi.fn();
          }),
        },
        emitCustom: vi.fn(),
        _tools: tools,
      };
      llmCache.setup(api as never);
      return api;
    })();

    const registry = new ExtensionRegistry();
    for (const [name, api] of [
      ['prompt-firewall', firewallApi],
      ['llm-cache', cacheApi],
    ] as const) {
      registry.register({
        name,
        wrapProviderRunner: (api as { _wrap?: WrapFn })._wrap as never,
      } as never);
    }

    const provider = vi.fn().mockImplementation((_ctx: unknown, r: unknown) => {
      const text = JSON.stringify(r);
      if (text.includes(GH_TOKEN)) throw new Error('raw secret reached the provider');
      return Promise.resolve(resp('ok'));
    });
    const composed = registry.wrapProviderRunner(provider as never);

    // First call: firewall redacts, cache misses and stores the redacted copy.
    const withSecret = req(`use ${GH_TOKEN} now`);
    await composed({} as never, withSecret as never);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(provider.mock.calls[0]![1])).not.toContain(GH_TOKEN);

    // Second call — the attack: same raw secret, but now a cache HIT would
    // short-circuit `inner` entirely. The firewall must still see the raw
    // request first; the provider must never receive the secret.
    await composed({} as never, withSecret as never);
    expect(provider).toHaveBeenCalledTimes(1); // served from cache
    const secondStatus = await firewallApi._tools.prompt_firewall_status!.execute({});
    expect((secondStatus.counters as { invocations: number }).invocations).toBe(2);
    expect(
      (secondStatus.counters as { requestsWithSecrets: number }).requestsWithSecrets,
    ).toBeGreaterThanOrEqual(2);
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

const { detectSecretsGuarded } = await import('../src/prompt-firewall');

describe('issue #362 residuals: guarded scan + response budget', () => {
  const probe = vi.mocked(withReDoSGuard);
  const inlineProbe = (re: RegExp, input: string) => {
    re.lastIndex = 0;
    return Promise.resolve({ timedOut: false, match: re.exec(input) });
  };

  beforeEach(() => {
    probe.mockImplementation(inlineProbe);
  });

  it('a timed-out pattern is skipped, counted, and the request passes fail-open', async () => {
    // The github-token pattern blows its budget; everything else scans.
    probe.mockImplementation((re: RegExp, input: string) =>
      re.source.includes('ghp_')
        ? Promise.resolve({ timedOut: true, match: null })
        : inlineProbe(re, input),
    );
    const api = setup({ enabled: true, mode: 'redact' });
    const inner = vi.fn().mockResolvedValue(resp('ok'));
    await api._wrap!(null, req(`use ${GH_TOKEN} now`), inner);

    // Fail-open contract: the request still goes out with the token
    // (secret-scanner is the fail-closed gate; this surface trades
    // blocking for availability) — but the skip is loud, not silent.
    expect(JSON.stringify(inner.mock.calls[0]![1])).toContain(GH_TOKEN);
    expect(api.log.warn).toHaveBeenCalledWith(
      'prompt-firewall: ReDoS budget exceeded, patterns skipped',
      { skipped: ['github-token'] },
    );
    expect(api.metrics.counter).toHaveBeenCalledWith('redos_skips', 1);
    const status = await api._tools.prompt_firewall_status!.execute({});
    expect((status.counters as { timeoutCount: number }).timeoutCount).toBe(1);
    expect(status.skippedPatterns).toEqual(['github-token']);
    expect(status.responseTruncated).toBe(false);
  });

  it('the skip set is refreshed per request — no stale skips after a clean probe', async () => {
    let githubTimesOut = true;
    probe.mockImplementation((re: RegExp, input: string) =>
      re.source.includes('ghp_') && githubTimesOut
        ? Promise.resolve({ timedOut: true, match: null })
        : inlineProbe(re, input),
    );
    const api = setup({ enabled: true, mode: 'redact' });
    const inner = vi.fn().mockResolvedValue(resp('ok'));

    await api._wrap!(null, req(`use ${GH_TOKEN} now`), inner);
    let status = await api._tools.prompt_firewall_status!.execute({});
    expect(status.skippedPatterns).toEqual(['github-token']);

    githubTimesOut = false;
    await api._wrap!(null, req(`use ${GH_TOKEN} now`), inner);
    status = await api._tools.prompt_firewall_status!.execute({});
    expect(status.skippedPatterns).toEqual([]); // refreshed, not sticky
    expect((status.counters as { timeoutCount: number }).timeoutCount).toBe(1);
    expect((status.counters as { requestRedactions: number }).requestRedactions).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(inner.mock.calls[1]![1])).not.toContain(GH_TOKEN);
  });

  it('probes the ENTIRE input in bounded windows, not just a prefix', async () => {
    const long = `${'x'.repeat(249_900)} ${GH_TOKEN}`; // ~250 KB, secret at the end
    const { detections } = await detectSecretsGuarded(long, []);
    expect(detections.map((d) => d.kind)).toContain('github-token');
    // Overlapping windows of ≤ GUARD_PROBE_LENGTH covering the whole input.
    // Source of truth is the spy's own call log (chimera review: a
    // separately maintained array can go empty and pass vacuously).
    const inputs = probe.mock.calls.map((call) => String(call[1]));
    expect(inputs.length).toBeGreaterThan(1);
    for (const chunk of inputs) expect(chunk.length).toBeLessThanOrEqual(100_000);
    const covered = inputs.reduce((n, c) => n + c.length, 0);
    expect(covered).toBeGreaterThanOrEqual(long.length);
  });

  it('an oversized response leaf is skipped whole and the truncation is surfaced', async () => {
    const api = setup({ enabled: true, mode: 'redact' });
    const huge = 'x'.repeat(1_000_001) + GH_TOKEN; // leaf > RESPONSE_SCAN_BUDGET
    const inner = vi.fn().mockResolvedValue(resp(huge));
    const out = (await api._wrap!(null, req('clean'), inner)) as {
      content: Array<{ text: string }>;
    };
    // Bounded fail-open: the leaf is returned unscanned, but loudly.
    expect(out.content[0]!.text).toContain(GH_TOKEN);
    expect(api.metrics.counter).toHaveBeenCalledWith('response_scan_truncated', 1);
    expect(api.log.warn).toHaveBeenCalledWith(
      'prompt-firewall: response scan budget exhausted — part of the response was returned unredacted',
    );
    const status = await api._tools.prompt_firewall_status!.execute({});
    expect(status.responseTruncated).toBe(true);
  });

  it('an exactly-budget response is fully scanned and does NOT latch responseTruncated', async () => {
    const api = setup({ enabled: true, mode: 'redact' });
    // Single-leaf content of exactly RESPONSE_SCAN_BUDGET chars with a
    // secret at the end: the walk legitimately drives remaining to 0 —
    // that is not truncation. (The default resp() adds a `type: 'text'`
    // sibling leaf that would consume budget first, so build the content
    // directly.)
    const exact = `${'x'.repeat(1_000_000 - GH_TOKEN.length - 1)} ${GH_TOKEN}`;
    const inner = vi.fn().mockResolvedValue({ content: [{ text: exact }] });
    const out = (await api._wrap!(null, req('clean'), inner)) as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0]!.text).not.toContain(GH_TOKEN);
    expect(out.content[0]!.text).toContain('[REDACTED:github-token]');
    const status = await api._tools.prompt_firewall_status!.execute({});
    expect(status.responseTruncated).toBe(false);
    expect((status.counters as { responseRedactions: number }).responseRedactions).toBeGreaterThanOrEqual(1);
  });

  it('a pattern timed out on the request side is also skipped on response redaction', async () => {
    // Chimera review finding: redactResponse must receive the skip set —
    // otherwise a pattern that blew its budget on the request runs
    // unguarded over response text.
    probe.mockImplementation((re: RegExp, input: string) =>
      re.source.includes('ghp_')
        ? Promise.resolve({ timedOut: true, match: null })
        : inlineProbe(re, input),
    );
    const api = setup({ enabled: true, mode: 'redact' });
    const inner = vi.fn().mockResolvedValue(resp(`echo ${GH_TOKEN}`));
    const out = (await api._wrap!(null, req('clean'), inner)) as {
      content: Array<{ text: string }>;
    };
    // Fail-open contract on the response side too: skipped, not run.
    expect(out.content[0]!.text).toContain(GH_TOKEN);
    const status = await api._tools.prompt_firewall_status!.execute({});
    expect(status.skippedPatterns).toEqual(['github-token']);
  });
});
