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

const promptFirewallPlugin = (await import('../src/prompt-firewall/index.js')).default;
const { detectSecrets, readConfig, redactSecrets, KIND_ALIASES } = await import(
  '../src/prompt-firewall/index.js'
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
        if (ext.wrapProviderRunner) api._wrap = ext.wrapProviderRunner;
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
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHHHexample\n-----END CERTIFICATE-----';
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
        tools: {
          register: (t: Tool) => {
            tools[t.name] = t;
          },
        },
        config: { extensions: { 'llm-cache': { enabled: true } } },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
        extensions: {
          register: vi.fn((ext: { wrapProviderRunner?: WrapFn }) => {
            if (ext.wrapProviderRunner) (api as { _wrap?: WrapFn })._wrap = ext.wrapProviderRunner;
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
      tools: {
        register: (t: Tool) => {
          tools[t.name] = t;
        },
      },
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

  const postgresQueryPassword = [
    'postgresql',
    '://',
    'db',
    '/app?',
    'user=alice&',
    'password=',
    'query-secret',
  ].join('');
  const encodedPostgresQueryPassword = [
    'postgresql',
    '://',
    'db',
    '/app?',
    'user=alice&',
    'pass%77ord=',
    'query-secret',
  ].join('');

  it.each([
    ['literal', postgresQueryPassword],
    ['percent-encoded', encodedPostgresQueryPassword],
  ] as const)(
    'block mode rejects a PostgreSQL URI with a %s password query parameter',
    async (_label, uri) => {
      const api = setup({ enabled: true, mode: 'block' });
      const inner = vi.fn().mockResolvedValue(resp('clean'));
      await expect(api._wrap!(null, req(uri), inner)).rejects.toThrow(/postgres_uri/);
      expect(inner).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['literal', postgresQueryPassword],
    ['percent-encoded', encodedPostgresQueryPassword],
  ] as const)(
    'redact mode strips a PostgreSQL URI with a %s password query parameter',
    async (_label, uri) => {
      const api = setup({ enabled: true, mode: 'redact' });
      const inner = vi.fn().mockResolvedValue(resp('clean'));
      await api._wrap!(null, req(uri), inner);
      const sent = JSON.stringify(inner.mock.calls[0]![1]);
      expect(sent).not.toContain('query-secret');
      expect(sent).toContain('[REDACTED:postgres_uri]');
    },
  );

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
    const health = (await promptFirewallPlugin.health!()) as unknown as {
      counters: Record<string, number>;
    };
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

const { detectSecretsGuarded } = await import('../src/prompt-firewall/index.js');

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
    expect(
      (status.counters as { requestRedactions: number }).requestRedactions,
    ).toBeGreaterThanOrEqual(1);
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
    expect(
      (status.counters as { responseRedactions: number }).responseRedactions,
    ).toBeGreaterThanOrEqual(1);
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

  it('teardown resets the #362 residual state (chimera finding 4)', async () => {
    probe.mockImplementation((re: RegExp, input: string) =>
      re.source.includes('ghp_')
        ? Promise.resolve({ timedOut: true, match: null })
        : inlineProbe(re, input),
    );
    const api = setup({ enabled: true, mode: 'redact' });
    const inner = vi.fn().mockResolvedValue(resp('ok'));
    await api._wrap!(null, req(`use ${GH_TOKEN} now`), inner);
    let status = await api._tools.prompt_firewall_status!.execute({});
    expect((status.counters as { timeoutCount: number }).timeoutCount).toBe(1);
    expect(status.skippedPatterns).toEqual(['github-token']);

    promptFirewallPlugin.teardown!(api as never);
    // The `final` snapshot must include timeoutCount so the reload log
    // doesn't silently drop the residual counters.
    expect(api.log.info).toHaveBeenCalledWith(
      'prompt-firewall: teardown complete',
      expect.objectContaining({
        final: expect.objectContaining({ timeoutCount: 1 }),
      }),
    );

    // A fresh setup after teardown starts from zeroed residual state —
    // module-scope state must not leak across reloads.
    const api2 = setup({ enabled: true, mode: 'redact' });
    status = await api2._tools.prompt_firewall_status!.execute({});
    expect((status.counters as { timeoutCount: number }).timeoutCount).toBe(0);
    expect(status.skippedPatterns).toEqual([]);
    expect(status.responseTruncated).toBe(false);
  });

  it('stops probing windows once every pattern is already skipped (chimera finding 3)', async () => {
    // Every probe times out, so after the first window the skip set is
    // complete and remaining windows must not be probed at all.
    probe.mockImplementation(() => Promise.resolve({ timedOut: true, match: null }));
    const api = setup({ enabled: true, mode: 'redact' });
    const status = await api._tools.prompt_firewall_status!.execute({});
    // Several patterns share a kind via KIND_ALIASES — the per-kind skip
    // set saturates at the DISTINCT kind count, which is what the probe's
    // early-exit must compare against.
    const distinctKinds = new Set(status.patterns as string[]).size;

    const long = 'x'.repeat(250_000); // spans 3+ windows
    await detectSecretsGuarded(long, []);
    // Exactly one combined probe + one probe per distinct kind in that
    // single window — no further window probes after the skip set is
    // complete.
    expect(probe.mock.calls.length).toBe(1 + distinctKinds);
  });

  // ---- issue #370: cumulative scan-pass budget ----
  // The probe licenses ONE exec per (pattern, window); these pin that the
  // count/replace loops themselves are bounded by a per-pass deadline.

  it('scan-pass budget: a kind crossing the deadline mid-pass is skipped and surfaced (fail-open)', async () => {
    // Deterministic trip via a MONOTONIC fake clock: every call advances
    // 1 s, so any deadline (created +250 ms ahead) is crossed by the very
    // next check. (A constant-offset clock freezes the deadline 250 ms
    // ahead forever and never trips — the trip must come from the scan
    // loop itself, which is exactly #370's gap: the probe only licenses
    // one exec.)
    const perf = await import('node:perf_hooks');
    let t = 0;
    const spy = vi.spyOn(perf.performance, 'now').mockImplementation(() => (t += 1000));
    try {
      const api = setup({ enabled: true, mode: 'redact' });
      const inner = vi.fn().mockResolvedValue(resp('ok'));
      await api._wrap!(null, req(`use ${GH_TOKEN} now`), inner);

      // Fail-open (same contract as a probe timeout): the request passes
      // with the token — but the mid-pass skip is loud, not silent.
      expect(JSON.stringify(inner.mock.calls[0]![1])).toContain(GH_TOKEN);
      expect(api.log.warn).toHaveBeenCalledWith(
        'prompt-firewall: ReDoS budget exceeded, patterns skipped',
        expect.objectContaining({ skipped: expect.arrayContaining(['github-token']) }),
      );
      expect(api.metrics.counter).toHaveBeenCalledWith('redos_skips', 1);
      const status = await api._tools.prompt_firewall_status!.execute({});
      const distinctKinds = new Set(status.patterns as string[]).size;
      expect((status.counters as { timeoutCount: number }).timeoutCount).toBe(1);
      // Every distinct kind tripped (constant-exhausted clock).
      expect(new Set(status.skippedPatterns as string[]).size).toBe(distinctKinds);
    } finally {
      spy.mockRestore();
    }
  });

  it('scan-pass budget: response-walk trip surfaces via the #370 mid-pass warning', async () => {
    // Clean clock through detect + request redaction; the provider call
    // flips the clock past the budget, so the RESPONSE walk trips and
    // surfaceScanTrips fires with its own warn message.
    const perf = await import('node:perf_hooks');
    const realNow = perf.performance.now.bind(perf.performance);
    let exhaust = false;
    let t = 0;
    const spy = vi.spyOn(perf.performance, 'now').mockImplementation(() => {
      // Real clock while exhaust is off (detect + request redaction stay
      // fast and untripped); once the provider flips it, the clock turns
      // monotonic so the response walk's own deadline is crossed.
      if (!exhaust) return realNow();
      t += 1000;
      return t;
    });
    try {
      const api = setup({ enabled: true, mode: 'redact' });
      const inner = vi.fn(async () => {
        exhaust = true; // trip the clock before the response walk
        return resp(`echo ${GH_TOKEN}`);
      });
      const out = (await api._wrap!(null, req('clean'), inner)) as {
        content: Array<{ text: string }>;
      };
      // Fail-open: response text unredacted, trip surfaced loudly.
      expect(out.content[0]!.text).toContain(GH_TOKEN);
      expect(api.log.warn).toHaveBeenCalledWith(
        'prompt-firewall: scan-pass budget exceeded — patterns skipped mid-pass (issue #370)',
        expect.objectContaining({ skipped: expect.arrayContaining(['github-token']) }),
      );
      const status = await api._tools.prompt_firewall_status!.execute({});
      expect((status.counters as { timeoutCount: number }).timeoutCount).toBe(1);
      expect(status.skippedPatterns).toEqual(expect.arrayContaining(['github-token']));
    } finally {
      spy.mockRestore();
    }
  });

  it('scan-pass budget: unexpired deadline leaves redaction byte-identical; expired trips fail-open', async () => {
    const { redactSecrets } = await import('../src/prompt-firewall/index.js');
    const text = `token ${GH_TOKEN} and ${GH_TOKEN} again`;
    type Deadline = NonNullable<Parameters<typeof redactSecrets>[2]>;
    const fresh: Deadline = { deadline: Number.POSITIVE_INFINITY, tripped: new Set<string>() };
    const expired: Deadline = { deadline: -1, tripped: new Set<string>() };

    // Budget is a safety rail, not a semantics change: with time remaining,
    // the exec-loop rewrite must match the unbudgeted output exactly.
    const unbudgeted = redactSecrets(text, []);
    const budgeted = redactSecrets(text, [], fresh);
    expect(budgeted).toEqual(unbudgeted);
    expect(budgeted.text).not.toContain(GH_TOKEN);
    expect(budgeted.redactions).toBe(2);

    // Expired deadline: every pattern is skipped up front, text unchanged,
    // and the kind is recorded as tripped (fail-open, surfaced by caller).
    const tripped = redactSecrets(text, [], expired);
    expect(tripped.text).toBe(text);
    expect(tripped.redactions).toBe(0);
    expect(expired.tripped.has('github-token')).toBe(true);
    // No-match kinds are recorded too: they never enter the match loop, so
    // only the pre-exec gate can mark them (chimera finding — the text has
    // no AWS key, yet the kind must still be tripped with zero work done).
    expect(expired.tripped.has('aws-access-key')).toBe(true);
    expect(expired.tripped.size).toBeGreaterThan(1);
  });
});

describe('issue #371: windowed pattern scanning', () => {
  // Probe helpers live in the #362 describe; redefine locally (same inline
  // stub shape) — withReDoSGuard is module-imported above.
  const probe = vi.mocked(withReDoSGuard);
  const inlineProbe = (re: RegExp, input: string) => {
    re.lastIndex = 0;
    return Promise.resolve({ timedOut: false, match: re.exec(input) });
  };
  const STRIDE = 100_000 - 4_096; // accept-region stride (probe geometry)
  const markers = (s: string) => (s.match(/\[REDACTED:[a-z0-9-]+\]/g) ?? []).length;
  // Built at runtime like GH_TOKEN above so no credential-shaped literal
  // appears in this file's source (the scheme and userinfo are split so
  // even tool-output scrubbers have nothing contiguous to rewrite).
  const mongoUri = ['mongodb', '://u:', 'p'.repeat(8), '@h.example.net/db'].join('');

  /** Build filler text with parts spliced at absolute offsets. */
  const build = (parts: Array<{ at: number; s: string }>, total: number): string => {
    let text = '';
    for (const p of parts.toSorted((a, b) => a.at - b.at)) {
      text += 'x'.repeat(Math.max(0, p.at - text.length)) + p.s;
    }
    return text.length < total ? text + 'x'.repeat(total - text.length) : text;
  };

  it('a credential straddling the accept-region seam is found exactly once per instance', async () => {
    probe.mockImplementation(inlineProbe);
    // Token A (with a separator so the boundary lookbehind accepts it)
    // starts 3 chars before the seam and ENDS past it — window 0 accepts
    // it, window 1's overlapping slice must not re-count it. Token B sits
    // fully inside window 1's region — window 0's slice contains it but
    // must not accept it.
    const text = build(
      [
        { at: STRIDE - 4, s: ` ${GH_TOKEN}` },
        { at: STRIDE + 16, s: ` ${GH_TOKEN}` },
      ],
      300_000,
    );
    const { detections } = await detectSecretsGuarded(text, []);
    expect(detections).toEqual([{ kind: 'github-token', count: 2 }]); // not 3, not 1

    const out = redactSecrets(text, []);
    expect(markers(out.text)).toBe(2);
    expect(out.redactions).toBe(2);
    expect(out.text).not.toContain(GH_TOKEN);
  });

  it('a multi-part credential (mongodb URI) straddling the seam is still redacted', async () => {
    probe.mockImplementation(inlineProbe);
    // mongodb URIs need user:pass@host — a multi-part shape that cannot
    // complete unless the whole URI is inside one window. Straddling the
    // accept seam, containment (64 KB tail) must keep it whole.
    const text = build([{ at: STRIDE - 20, s: mongoUri }], 300_000);
    const { detections } = await detectSecretsGuarded(text, []);
    expect(detections.length).toBe(1);
    expect(detections[0]!.count).toBe(1);

    const out = redactSecrets(text, []);
    expect(out.redactions).toBe(1);
    expect(out.text).not.toContain('p'.repeat(8));
  });

  it('lookbehinds see TRUE context at the seam, not a synthetic string start', async () => {
    probe.mockImplementation(inlineProbe);
    // 'x' immediately before a token at the exact seam start: the boundary
    // lookbehind (?<![A-Za-z0-9]) must REJECT it. A window sliced exactly
    // at its accept boundary would see string-start and wrongly match.
    const rejected = build([{ at: STRIDE - 1, s: `x${GH_TOKEN}` }], 300_000);
    const { detections } = await detectSecretsGuarded(rejected, []);
    expect(detections).toEqual([]);

    // One char earlier with a space separator: correctly found.
    const accepted = build([{ at: STRIDE - 1, s: ` ${GH_TOKEN}` }], 300_000);
    const ok = await detectSecretsGuarded(accepted, []);
    expect(ok.detections).toEqual([{ kind: 'github-token', count: 1 }]);
  });

  it('a prefix-run monster touching its slice end is recovered by bounded growth', async () => {
    probe.mockImplementation(inlineProbe);
    // 170 KB openai-shaped run: the windowed match is cut at the slice end
    // (165 536), so growMatch re-measures on doubling slices (100 K → 200 K)
    // and must recover the FULL run — redacted wholly, exactly once.
    const run = ` sk-${'A'.repeat(170_000)}`; // ' ' so the lookbehind accepts 'sk-'
    const text = build([{ at: STRIDE + 100, s: run }], 300_000);
    const detections = detectSecrets(text, []);
    expect(detections.length).toBe(1);
    expect(detections[0]!.count).toBe(1);

    const out = redactSecrets(text, []);
    expect(markers(out.text)).toBe(1);
    expect(out.text).not.toContain('A'.repeat(100)); // whole run gone, not a stub
  });

  it('structural bound: no synchronous regex input exceeds SCAN_WINDOW_LIMIT', async () => {
    probe.mockImplementation(inlineProbe);
    // Patch RegExp.prototype.exec and record every subject length across a
    // multi-window guarded pass — the #371 invariant itself. (Growth slices
    // are separately bounded by the doubling cap; none fire on this input.)
    const { SCAN_WINDOW_LIMIT } = await import('../src/prompt-firewall/index.js');
    const origExec = RegExp.prototype.exec;
    let maxInput = 0;
    RegExp.prototype.exec = function patched(this: RegExp, str: string | undefined) {
      if (typeof str === 'string' && str.length > maxInput) maxInput = str.length;
      return origExec.call(this, str as never);
    } as typeof RegExp.prototype.exec;
    try {
      const text = build([{ at: 590_000, s: ` ${GH_TOKEN}` }], 600_000); // 6+ windows
      const { detections } = await detectSecretsGuarded(text, []);
      expect(detections).toEqual([{ kind: 'github-token', count: 1 }]);
    } finally {
      RegExp.prototype.exec = origExec;
    }
    expect(maxInput).toBeGreaterThan(0); // the patch actually observed execs
    expect(maxInput).toBeLessThanOrEqual(SCAN_WINDOW_LIMIT);
  });
});
