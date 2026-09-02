import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SubcommandDeps } from '../src/subcommands/contracts.js';

/**
 * Mock `proxy-rewrite` so the test fully controls the in-process singleton.
 *
 * SAGE memory: a bare `vi.hoisted(() => vi.fn())` factory returns `any`,
 * which silently widens the call site. We annotate every factory with an
 * explicit return type so a future change to the real surface surfaces as
 * a TS error in this file rather than a runtime drift.
 */
const mockApplyProxyConfig = vi.hoisted(
  (): Mock<(next: Record<string, unknown>) => unknown> => vi.fn(() => ({})),
);
const mockGetProxyConfig = vi.hoisted(
  (): Mock<() => { enabled: boolean; url: string; active: boolean }> =>
    vi.fn(() => ({ enabled: false, url: '', active: false })),
);
const mockShouldRewriteFor = vi.hoisted(
  (): Mock<(providerId: string) => boolean> => vi.fn(() => false),
);
vi.mock('@wrongstack/core/wiring/proxy-rewrite', () => ({
  applyProxyConfig: mockApplyProxyConfig,
  getProxyConfig: mockGetProxyConfig,
  shouldRewriteFor: mockShouldRewriteFor,
  isProxyEligible: vi.fn(() => true),
  rewriteBaseUrl: vi.fn((u: string) => u),
  PROXY_EXCLUDED_PROVIDERS: new Set(['openai-codex']),
  __resetProxyConfigForTests: vi.fn(),
}));

/**
 * Mock the local `proxy-probe` so `startProxyProbe` returns a `runner.poke`
 * that we control via `mockProbeResponse`. A `fetchImpl` injection point is
 * not exposed by the current probe API; instead, we override `fetchImpl`
 * indirectly by having `poke()` resolve to whatever the latest
 * `mockProbeResponse` says.
 *
 * Each test sets `mockProbeResponse` BEFORE calling `proxyCmd`; the runner
 * instance is created per call and its `poke()` reads the latest value.
 */
const mockStartProxyProbe = vi.hoisted(
  (): Mock<
    (opts?: Record<string, unknown>) => {
      stop(): void;
      poke: () => Promise<boolean>;
    }
  > =>
    vi.fn(() => ({
      stop: vi.fn(),
      poke: vi.fn(async () => mockProbeResponse.value),
    })),
);
const mockProbeResponse = vi.hoisted((): { value: boolean } => ({ value: true }));
vi.mock('../src/wiring/proxy-probe.js', () => ({
  startProxyProbe: mockStartProxyProbe,
  stopProxyProbe: vi.fn(),
  __resetProxyProbeForTests: vi.fn(),
}));

import { proxyCmd } from '../src/subcommands/handlers/diag-doctor.js';

interface CapturedRenderer {
  out: string[];
  renderer: { write: ReturnType<typeof vi.fn> };
}

function makeCapturingRenderer(): CapturedRenderer {
  const out: string[] = [];
  // `write` is itself a `vi.fn()` so `.mock.calls` is populated for
  // assertions; it pushes to `out` for human-readable inspection.
  const write = vi.fn((s: string) => {
    out.push(s);
  });
  return { out, renderer: { write } };
}

interface ProxyToolConfig {
  enabled?: boolean;
  url?: string;
}

interface TestDeps {
  renderer: CapturedRenderer['renderer'];
  config: { tools?: { wrongProxy?: ProxyToolConfig } };
}

function makeDeps(persisted?: ProxyToolConfig): TestDeps {
  const { renderer } = makeCapturingRenderer();
  return {
    renderer,
    config: {
      tools: persisted === undefined ? {} : { wrongProxy: persisted },
    },
  };
}

/**
 * `proxyCmd` is a `SubcommandHandler`, which requires a full `SubcommandDeps`
 * object. The test only exercises the `config` and `renderer` slices, so we
 * build a narrow `TestDeps` (keeping `renderer.write` as a `vi.fn` so its
 * `.mock.calls` is assertable) and widen to the handler contract at the call
 * boundary only.
 */
function runProxyCmd(args: string[], deps: TestDeps): Promise<number> {
  return proxyCmd(args, deps as unknown as SubcommandDeps);
}

beforeEach(() => {
  // Reset all hoisted mocks. `mockClear` keeps the implementation but drops
  // call history; `mockReset` would also wipe `mockImplementation`, which
  // we want to keep so the singleton-shape defaults are stable across tests.
  mockApplyProxyConfig.mockClear();
  mockGetProxyConfig.mockClear();
  mockShouldRewriteFor.mockClear();
  mockStartProxyProbe.mockClear();
  // Reset the singleton the test "sees" — every case rebuilds it.
  mockGetProxyConfig.mockReturnValue({ enabled: false, url: '', active: false });
  mockShouldRewriteFor.mockReturnValue(false);
  mockProbeResponse.value = true;
});

describe('proxyCmd — enabled × url-set × probe-success', () => {
  it('seeds the singleton, runs the probe, and reports live + rewrites applied', async () => {
    mockGetProxyConfig.mockReturnValue({
      enabled: true,
      url: 'http://localhost:3444',
      active: true,
    });
    mockShouldRewriteFor.mockReturnValue(true);
    const deps = makeDeps({ enabled: true, url: 'http://localhost:3444' });

    const code = await runProxyCmd([], deps);

    expect(code).toBe(0);
    // The handler must apply persisted prefs to the singleton before reading.
    expect(mockApplyProxyConfig).toHaveBeenCalledWith({
      enabled: true,
      url: 'http://localhost:3444',
    });
    // The probe must run exactly once, and with NO options at all.
    // `startProxyProbe` is a module singleton: its early-return path drops
    // every field of `opts` when a runner already exists, and `intervalMs` /
    // `timeoutMs` are captured into the runner closure at construction, so
    // they can never be applied retroactively. A subcommand passing them
    // therefore promised a per-call configuration the function cannot honour.
    // This call site is deliberately argument-free; asserting that here makes
    // a future re-introduction fail loudly instead of silently doing nothing.
    expect(mockStartProxyProbe).toHaveBeenCalledTimes(1);
    const opts = mockStartProxyProbe.mock.calls[0]?.[0];
    expect(opts).toBeUndefined();
    // Output assertions: enabled, url, active, shouldRewrite all reflect the
    // seeded singleton state and the `live` label.
    const out = deps.renderer.write.mock.calls.map((c) => c[0]).join('');
    expect(out).toContain('enabled:      true');
    expect(out).toContain('url:          http://localhost:3444');
    expect(out).toContain('active:       true');
    expect(out).toContain('shouldRewrite:true');
    expect(out).toContain('live');
    expect(out).toContain('rewrites applied');
  });
});

describe('proxyCmd — enabled × url-set × probe-failure', () => {
  it('reports enabled but probe not yet active, and rewrites bypassed', async () => {
    // The probe pokes once and writes `active=false` (simulated daemon down).
    mockProbeResponse.value = false;
    mockGetProxyConfig.mockReturnValue({
      enabled: true,
      url: 'http://localhost:3444',
      active: false,
    });
    mockShouldRewriteFor.mockReturnValue(false);
    const deps = makeDeps({ enabled: true, url: 'http://localhost:3444' });

    const code = await runProxyCmd([], deps);

    expect(code).toBe(0);
    expect(mockStartProxyProbe).toHaveBeenCalledTimes(1);
    const out = deps.renderer.write.mock.calls.map((c) => c[0]).join('');
    expect(out).toContain('enabled:      true');
    expect(out).toContain('url:          http://localhost:3444');
    expect(out).toContain('active:       false');
    // The status glyph/label for `enabled && !active` is the amber warning,
    // not the green `live` glyph.
    expect(out).not.toContain('live');
    expect(out).toContain('enabled, probe not yet active');
    expect(out).toContain('rewrites bypassed');
  });

  it('does not start the probe when the persisted config is missing url', async () => {
    // enabled=true with no url is treated as unconfigured at the probe layer.
    const deps = makeDeps({ enabled: true }); // no url

    const code = await runProxyCmd([], deps);

    expect(code).toBe(0);
    expect(mockStartProxyProbe).not.toHaveBeenCalled();
  });
});

describe('proxyCmd — disabled × url-set', () => {
  it('reports url-set toggle off and rewrites bypassed', async () => {
    mockGetProxyConfig.mockReturnValue({
      enabled: false,
      url: 'http://localhost:3444',
      active: false,
    });
    mockShouldRewriteFor.mockReturnValue(false);
    const deps = makeDeps({ enabled: false, url: 'http://localhost:3444' });

    const code = await runProxyCmd([], deps);

    expect(code).toBe(0);
    // The probe is gated on `enabled === true`; a disabled config must not
    // boot the periodic /api/health loop.
    expect(mockStartProxyProbe).not.toHaveBeenCalled();
    const out = deps.renderer.write.mock.calls.map((c) => c[0]).join('');
    expect(out).toContain('enabled:      false');
    expect(out).toContain('url:          http://localhost:3444');
    expect(out).toContain('active:       false');
    expect(out).toContain('url set, toggle off');
    expect(out).toContain('rewrites bypassed');
  });
});

describe('proxyCmd — disabled × url-unset', () => {
  it('reports unconfigured when there are no persisted prefs at all', async () => {
    const deps = makeDeps(undefined);

    const code = await runProxyCmd([], deps);

    expect(code).toBe(0);
    // Nothing to seed, nothing to probe — both calls must be skipped.
    expect(mockApplyProxyConfig).not.toHaveBeenCalled();
    expect(mockStartProxyProbe).not.toHaveBeenCalled();
    const out = deps.renderer.write.mock.calls.map((c) => c[0]).join('');
    expect(out).toContain('enabled:      false');
    expect(out).toContain('url:          <unset>');
    expect(out).toContain('active:       false');
    expect(out).toContain('unconfigured');
    expect(out).toContain('rewrites bypassed');
  });

  it('reports unconfigured when wrongProxy object exists but is empty', async () => {
    // Empty `{}` — both `enabled` and `url` are undefined. The handler's
    // `if (persisted)` guard is truthy for `{}`, so we DO call
    // `applyProxyConfig` (with `enabled: false, url: ''`), but we must NOT
    // boot the probe because the inner `enabled === true` guard fails.
    const deps = makeDeps({});

    const code = await runProxyCmd([], deps);

    expect(code).toBe(0);
    expect(mockApplyProxyConfig).toHaveBeenCalledWith({ enabled: false, url: '' });
    expect(mockStartProxyProbe).not.toHaveBeenCalled();
    const out = deps.renderer.write.mock.calls.map((c) => c[0]).join('');
    expect(out).toContain('url:          <unset>');
    expect(out).toContain('unconfigured');
  });
});
