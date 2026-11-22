import { afterEach, describe, expect, it, vi } from 'vitest';

const depGuardPlugin = (await import('../src/dep-guard/index.js')).default;

/**
 * F18: registries fold canonical-equivalent name spellings — PyPI (PEP 503)
 * treats runs of -_. as a single - and ignores case (`pip install Evil_Pkg`
 * installs the SAME distribution as `evil-pkg`); crates.io folds -/_ and case
 * likewise; npm only case-folds (its grammar excludes _/uppercase). The
 * deny/allow matcher lowercased but did not fold separators, so a deny entry
 * for `evil-pkg` was evaded by `pip install Evil_Pkg` / `evil.pkg` /
 * `EVIL__PKG` / `cargo add Evil_Crate` — a supply-chain deny-list bypass in
 * block mode. Both sides (name AND pattern) are now normalized per ecosystem,
 * including the registry check's isAllowed exemption.
 */

function makeApi(extensions: Record<string, unknown>) {
  return {
    tools: { register: vi.fn() },
    config: { extensions },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

async function run(command: string, cfg: Record<string, unknown>) {
  const api = makeApi({
    'dep-guard': {
      mode: 'block',
      registryCheck: false,
      typosquatCheck: false,
      warnOnUnpinned: false,
      lockfileSync: false,
      ...cfg,
    },
  });
  depGuardPlugin.setup(api as never);
  const hook = (api.registerHook.mock.calls[0] as unknown[] | undefined)?.[2] as (
    input: unknown,
  ) => Promise<{ decision?: string; additionalContext?: string } | undefined>;
  return hook({ toolName: 'bash', toolInput: { command } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dep-guard deny/allow binds canonical-equivalent names (F18)', () => {
  it.each([
    'pip install Evil_Pkg',
    'pip install evil.pkg',
    'pip install EVIL__PKG',
    'pip install Evil_Pkg==1.0',
    'pip install Evil_Pkg>=1.0',
    'uv add Evil_Pkg',
    'cargo add Evil_Crate',
    'cargo add Evil_Crate@1.0',
  ])('blocks the canonical-equivalent spelling: %s', async (command) => {
    const deny = command.startsWith('cargo') ? ['evil-crate'] : ['evil-pkg'];
    const r = await run(command, { deny });
    expect(r?.decision, command).toBe('block');
  });

  it('controls: exact names and npm case-folding still block', async () => {
    expect((await run('pip install evil-pkg', { deny: ['evil-pkg'] }))?.decision).toBe('block');
    expect((await run('npm i Evil-Pkg', { deny: ['evil-pkg'] }))?.decision).toBe('block');
    expect((await run('cargo add evil-crate', { deny: ['evil-crate'] }))?.decision).toBe('block');
  });

  it('normalizes glob patterns on both sides', async () => {
    expect((await run('pip install Evil_Pkg', { deny: ['evil-*'] }))?.decision).toBe('block');
    expect((await run('pip install evil-pkg', { deny: ['evil_*'] }))?.decision).toBe('block');
    expect((await run('cargo add Evil_Crate', { deny: ['evil-*'] }))?.decision).toBe('block');
    expect(
      (await run('pip install Evil_Pkg', { deny: ['evil-pkg'], allow: ['evil-*'] }))?.decision,
    ).not.toBe('block');
  });

  it('allow exempts across spellings (deny + allow)', async () => {
    const r = await run('pip install Evil_Pkg', { deny: ['evil-pkg'], allow: ['evil-pkg'] });
    expect(r?.decision).not.toBe('block');
  });

  it('keeps npm scoped globs working and does NOT fold npm separators', async () => {
    expect((await run('npm i @evil/Pkg', { deny: ['@evil/*'] }))?.decision).toBe('block');
    expect((await run('npm i evil_pkg', { deny: ['evil-pkg'] }))?.decision).not.toBe('block');
    expect((await run('npm i evil.pkg', { deny: ['evil-pkg'] }))?.decision).not.toBe('block');
  });

  it('warn mode notes the deny-listed equivalent spelling', async () => {
    const r = await run('pip install Evil_Pkg', { deny: ['evil-pkg'], mode: 'warn' });
    expect(r?.decision).not.toBe('block');
    expect(r?.additionalContext).toContain('DENY-LISTED');
  });

  it('safe: unrelated packages are not blocked', async () => {
    expect((await run('pip install requests', { deny: ['evil-pkg'] }))?.decision).not.toBe('block');
    expect((await run('npm i react', { deny: ['evil-pkg'] }))?.decision).not.toBe('block');
  });

  it('extras never bypass a deny entry', async () => {
    // `pip install evil-pkg[security]` / `uv add evil-pkg[cli]` install the
    // distribution the deny list names. When extras stayed in the parsed name
    // the deny entry matched nothing and the install ran unchecked.
    expect((await run('pip install evil-pkg[security]', { deny: ['evil-pkg'] }))?.decision).toBe(
      'block',
    );
    expect((await run('pip install Evil_Pkg[dev]==1.0', { deny: ['evil-pkg'] }))?.decision).toBe(
      'block',
    );
    expect((await run('uv add evil-pkg[cli]', { deny: ['evil-pkg'] }))?.decision).toBe('block');
    // Prefix globs stay effective through the extras spelling.
    expect((await run('pip install evil-pkg[x]', { deny: ['evil-*'] }))?.decision).toBe('block');
    // Control: extras on an unrelated package are still not blocked.
    expect(
      (await run('pip install benign-pkg[security]', { deny: ['evil-pkg'] }))?.decision,
    ).not.toBe('block');
  });

  it('registry isAllowed skips the allow-listed equivalent spelling (no registry ask)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await run('pip install Evil_Pkg', {
      deny: [],
      allow: ['evil-pkg'],
      registryCheck: true,
    });
    expect(r?.decision).not.toBe('block');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
