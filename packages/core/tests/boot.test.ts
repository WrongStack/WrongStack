import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `bootConfig` is the single canonical boot routine shared by the CLI and the
 * WebUI server (packages/cli/src/boot-config.ts and
 * packages/webui/src/server/boot.ts are thin wrappers). These tests pin the
 * behaviors that used to live in the per-package boot tests — directory
 * creation, the plaintext-secret migration notice, and best-effort migration
 * failure — against the canonical implementation so the two consumers can't
 * drift. End-to-end shape/flag/sync coverage lives in the CLI's
 * boot-config.test.ts (which runs the real core against a temp HOME).
 */

const { canonicalRootMock, mkdirMock, writeFileMock, renameMock, mockWpaths } = vi.hoisted(() => ({
  canonicalRootMock: vi.fn((root: string) => root),
  mkdirMock: vi.fn().mockResolvedValue(undefined),
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  renameMock: vi.fn().mockResolvedValue(undefined),
  mockWpaths: {
    globalRoot: '/home/testuser/.wrongstack',
    projectDir: '/tmp/test/.wrongstack',
    projectSessions: '/tmp/test/.wrongstack/sessions',
    projectMeta: '/tmp/test/.wrongstack/meta.json',
    projectHash: 'abc123',
    globalConfig: '/home/testuser/.wrongstack/config.json',
    profilesDir: '/home/testuser/.wrongstack/profiles',
    profileConfig: (name: string) => `/home/testuser/.wrongstack/profiles/${name}/config.json`,
    profileStatuslineConfig: (name: string) =>
      `/home/testuser/.wrongstack/profiles/${name}/statusline.json`,
    profileModeConfig: (name: string) => `/home/testuser/.wrongstack/profiles/${name}/mode.json`,
    profileProviderStatus: (name: string) =>
      `/home/testuser/.wrongstack/profiles/${name}/provider-status.json`,
    profileUpdateCache: (name: string) =>
      `/home/testuser/.wrongstack/profiles/${name}/update-cache.json`,
    projectLocalConfig: '/tmp/test/.wrongstack/config.json',
    secretsKey: '/home/testuser/.wrongstack/.key',
    logFile: '/home/testuser/.wrongstack/wrongstack.log',
  },
}));

vi.mock('node:os', () => ({ homedir: () => '/home/testuser' }));
// The project-meta write goes through atomicWrite (temp + rename); the
// mock needs rename/unlink too, while the best-effort open/stat/chmod
// steps inside atomicWrite tolerate being absent (they throw, are caught).
vi.mock('node:fs/promises', () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
  rename: renameMock,
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/storage/config-loader.js', () => ({
  DefaultConfigLoader: vi.fn().mockImplementation(function (this: any) {
    this.load = vi.fn().mockResolvedValue({
      version: 1,
      provider: 'anthropic',
      model: 'anthropic-test-model',
      log: { level: 'info' },
    });
    this.loadSyncConfig = vi.fn().mockResolvedValue(null);
  }),
}));
vi.mock('../src/infrastructure/logger.js', () => ({
  DefaultLogger: vi.fn().mockImplementation(function (this: any, opts: { level: string }) {
    this.level = opts?.level;
  }),
  // boot.ts passes noOpLogger into migratePlaintextSecrets. A missing export
  // on a vitest module mock THROWS on access — which the migration loop's
  // best-effort catch silently swallows, making migrate look "never called".
  noOpLogger: {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  },
}));
vi.mock('../src/infrastructure/path-resolver.js', () => ({
  DefaultPathResolver: vi.fn().mockImplementation(function (this: any) {
    this.projectRoot = '/tmp/test';
  }),
}));
vi.mock('../src/security/secret-vault.js', () => ({
  DefaultSecretVault: vi.fn().mockImplementation(function (this: any) {}),
  migratePlaintextSecrets: vi.fn().mockResolvedValue({ migrated: 0, file: '' }),
}));
vi.mock('../src/utils/wstack-paths.js', () => ({
  canonicalProjectRoot: canonicalRootMock,
  resolveWstackPaths: vi.fn().mockReturnValue(mockWpaths),
}));
vi.mock('../src/utils/term.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/term.js')>()),
  writeErr: (s: string) => process.stderr.write(s),
}));

import { bootConfig, flagsToConfigPatch } from '../src/boot.js';
import { migratePlaintextSecrets } from '../src/security/secret-vault.js';
import { DefaultConfigLoader } from '../src/storage/config-loader.js';

const migrateMock = migratePlaintextSecrets as never as ReturnType<typeof vi.fn>;
const loaderMock = DefaultConfigLoader as never as ReturnType<typeof vi.fn>;

describe('bootConfig (core)', () => {
  beforeEach(() => {
    canonicalRootMock.mockReset();
    canonicalRootMock.mockImplementation((root: string) => root);
    mkdirMock.mockClear();
    renameMock.mockClear();
    writeFileMock.mockClear();
    migrateMock.mockReset();
    migrateMock.mockResolvedValue({ migrated: 0, file: '' });
  });

  it('returns the full canonical shape', async () => {
    const result = await bootConfig();
    expect(result.config.provider).toBe('anthropic');
    expect(result.projectRoot).toBe('/tmp/test');
    expect(result.globalConfigPath).toBe('/home/testuser/.wrongstack/config.json');
    expect(result.wpaths).toBe(mockWpaths);
    expect(result.vault).toBeDefined();
    expect(result.logger).toBeDefined();
  });

  it('creates the global, project, and session directories', async () => {
    await bootConfig();
    expect(mkdirMock).toHaveBeenCalledWith('/home/testuser/.wrongstack', { recursive: true });
    expect(mkdirMock).toHaveBeenCalledWith('/home/testuser/.wrongstack/profiles', {
      recursive: true,
    });
    expect(mkdirMock).toHaveBeenCalledWith('/tmp/test/.wrongstack', { recursive: true });
    expect(mkdirMock).toHaveBeenCalledWith('/tmp/test/.wrongstack/sessions', { recursive: true });
  });

  it('writes the project meta file atomically (temp write + rename)', async () => {
    await bootConfig();
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringContaining('meta.json'),
      expect.stringContaining('"hash": "abc123"'),
      expect.objectContaining({ flag: 'wx' }),
    );
    expect(renameMock).toHaveBeenCalledWith(
      expect.stringContaining('meta.json'),
      '/tmp/test/.wrongstack/meta.json',
    );
  });

  it('pins shared project metadata to the canonical worktree identity root', async () => {
    canonicalRootMock.mockReturnValue('/tmp/main-checkout');
    await bootConfig();
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringContaining('meta.json'),
      expect.stringContaining('"root": "/tmp/main-checkout"'),
      expect.objectContaining({ flag: 'wx' }),
    );
  });

  it('uses the supplied appLabel in the plaintext-secret notice', async () => {
    migrateMock
      .mockResolvedValueOnce({ migrated: 2, file: '/path/global.json' })
      .mockResolvedValueOnce({ migrated: 0, file: '' });
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await bootConfig({ appLabel: 'WebUI' });
      expect(stderrWrites.some((w) => w.includes('[WebUI] Encrypted 2 plaintext'))).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('swallows migration errors (best-effort)', async () => {
    migrateMock.mockRejectedValueOnce(new Error('vault locked'));
    await expect(bootConfig()).resolves.toBeDefined();
  });
});

describe('flagsToConfigPatch — fallbackModels', () => {
  it('splits a comma list into a trimmed array', () => {
    const patch = flagsToConfigPatch({ 'fallback-model': 'planner, haiku ,opus' });
    expect(patch.fallbackModels).toEqual(['planner', 'haiku', 'opus']);
  });

  it('omits fallbackModels when the flag is absent or empty', () => {
    expect(flagsToConfigPatch({}).fallbackModels).toBeUndefined();
    expect(flagsToConfigPatch({ 'fallback-model': ' , ' }).fallbackModels).toBeUndefined();
  });
});

// ── flagsToConfigPatch — all branches (pure) ─────────────────────────

describe('flagsToConfigPatch — all branches', () => {
  it('patches provider/model/cwd', () => {
    expect(flagsToConfigPatch({ provider: 'openai', model: 'gpt', cwd: '/x' })).toMatchObject({
      provider: 'openai',
      model: 'gpt',
      cwd: '/x',
    });
  });

  it('log-level wins over verbose/trace; verbose→debug; trace→trace', () => {
    expect(flagsToConfigPatch({ 'log-level': 'warn', verbose: true, trace: true }).log).toEqual({
      level: 'warn',
    });
    expect(flagsToConfigPatch({ verbose: true }).log).toEqual({ level: 'debug' });
    expect(flagsToConfigPatch({ trace: true }).log).toEqual({ level: 'trace' });
  });

  it('applies explicit YOLO overrides with the safe opt-out taking precedence', () => {
    expect(flagsToConfigPatch({ yolo: true }).yolo).toBe(true);
    expect(flagsToConfigPatch({ 'no-yolo': true }).yolo).toBe(false);
    expect(flagsToConfigPatch({ yolo: true, 'no-yolo': true }).yolo).toBe(false);
  });

  it('no-features disables every feature', () => {
    expect(flagsToConfigPatch({ 'no-features': true }).features).toEqual({
      mcp: false,
      plugins: false,
      memory: false,
      modelsRegistry: false,
      skills: false,
    });
  });

  it('token-saving-mode → boolean true', () => {
    expect(flagsToConfigPatch({ 'token-saving-mode': true }).features?.tokenSavingMode).toBe(true);
  });

  it('token-saving-tier normalises and takes precedence', () => {
    expect(
      flagsToConfigPatch({ 'token-saving-tier': 'aggressive' }).features?.tokenSavingMode,
    ).toBe('aggressive');
    // precedence: tier overrides mode
    expect(
      flagsToConfigPatch({ 'token-saving-mode': true, 'token-saving-tier': 'light' }).features
        ?.tokenSavingMode,
    ).toBe('light');
  });

  it('maps system prompt selection flags to config patches', () => {
    expect(flagsToConfigPatch({ 'system-pro': true }).systemPrompt?.variant).toBe('pro');
    expect(flagsToConfigPatch({ 'system-pro': 'true' }).systemPrompt?.variant).toBe('pro');
    expect(flagsToConfigPatch({ 'system-pro': '1' }).systemPrompt?.variant).toBe('pro');
    expect(flagsToConfigPatch({ 'system-pro': 'false' }).systemPrompt).toBeUndefined();
    expect(flagsToConfigPatch({ 'system-lite': true }).systemPrompt?.variant).toBe('lite');
    expect(flagsToConfigPatch({ 'system-lite': 'true' }).systemPrompt?.variant).toBe('lite');
    expect(flagsToConfigPatch({ 'system-lite': '1' }).systemPrompt?.variant).toBe('lite');
    expect(flagsToConfigPatch({ 'system-lite': 'false' }).systemPrompt).toBeUndefined();
    expect(flagsToConfigPatch({ 'system-prompt': 'pro' }).systemPrompt?.variant).toBe('pro');
    expect(flagsToConfigPatch({ 'system-prompt': 'lite' }).systemPrompt?.variant).toBe('lite');
    expect(flagsToConfigPatch({ 'system-prompt': 'default' }).systemPrompt?.variant).toBe(
      'default',
    );
    expect(flagsToConfigPatch({ 'system-prompt': 'other' }).systemPrompt).toBeUndefined();
  });
});

// ── bootConfig identity-validation catch + sync merge ────────────────

describe('bootConfig identity + sync', () => {
  it('skipIdentityValidation keeps provider/model unset on "no provider configured"', async () => {
    loaderMock.mockImplementationOnce(function (this: any) {
      this.load = vi
        .fn()
        .mockRejectedValueOnce(new Error('no provider configured'))
        .mockResolvedValueOnce({ version: 1, log: { level: 'info' } });
      this.loadSyncConfig = vi.fn().mockResolvedValue(null);
    });
    const result = await bootConfig({ skipIdentityValidation: true });
    expect(result.config.provider).toBeUndefined();
    expect(result.config.model).toBeUndefined();
  });

  it('rethrows non-identity errors', async () => {
    loaderMock.mockImplementationOnce(function (this: any) {
      this.load = vi.fn().mockRejectedValue(new Error('disk on fire'));
      this.loadSyncConfig = vi.fn().mockResolvedValue(null);
    });
    await expect(bootConfig()).rejects.toThrow('disk on fire');
  });

  it('merges a loaded sync config', async () => {
    loaderMock.mockImplementationOnce(function (this: any) {
      this.load = vi.fn().mockResolvedValue({
        version: 1,
        provider: 'anthropic',
        model: 'x',
        log: { level: 'info' },
      });
      this.loadSyncConfig = vi.fn().mockResolvedValue({ category: 'memory', repoUrl: 'gh://x' });
    });
    const result = await bootConfig({ loadSyncConfig: true });
    expect((result.config as never as { sync: unknown }).sync).toEqual({
      category: 'memory',
      repoUrl: 'gh://x',
    });
  });

  it('loadSyncConfig=false skips the sync merge', async () => {
    loaderMock.mockImplementationOnce(function (this: any) {
      this.load = vi.fn().mockResolvedValue({
        version: 1,
        provider: 'anthropic',
        model: 'x',
        log: { level: 'info' },
      });
      this.loadSyncConfig = vi.fn().mockResolvedValue({ category: 'memory' });
    });
    const result = await bootConfig({ loadSyncConfig: false });
    expect((result.config as never as { sync?: unknown }).sync).toBeUndefined();
  });
});
