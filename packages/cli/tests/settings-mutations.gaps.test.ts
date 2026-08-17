import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { executeSettingsSubcommand } from '../src/slash-commands/settings-mutations.js';

let dir: string;
let globalConfig: string;
let inProjectConfig: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wstack-settings-mutations-'));
  globalConfig = path.join(dir, 'global', 'config.json');
  inProjectConfig = path.join(dir, 'project', 'config.json');
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await import('node:fs/promises').then((fsp) =>
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {}),
  );
});

function makeCtx(config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const store = {
    get: vi.fn(() => config),
    update: vi.fn(),
  };
  const ctx = {
    configStore: store,
    paths: { globalConfig, profileConfig: () => globalConfig, inProjectConfig },
    ...extra,
  } as never as SlashCommandContext;
  return { ctx };
}

function run(sub: string, args: string, ctx: SlashCommandContext) {
  return executeSettingsSubcommand(sub, args.length > 0 ? args.split(' ') : [], ctx);
}

function written(): Record<string, unknown> {
  // config-scope project redirects subsequent writes into the in-project
  // file, so read whichever of the two exists.
  try {
    return JSON.parse(readFileSync(globalConfig, 'utf8'));
  } catch {
    return JSON.parse(readFileSync(inProjectConfig, 'utf8'));
  }
}

/** Read a dotted path out of the persisted profile config. */
function at(obj: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split('.')) {
    cur = (cur as Record<string, unknown>)?.[key];
  }
  return cur;
}

describe('executeSettingsSubcommand — toggles, enums, and numbers', () => {
  it.each([
    { sub: 'hq', args: 'on', msg: 'HQ publishing → on', at: 'hq.enabled', want: true },
    { sub: 'hq', args: 'off', msg: 'HQ publishing → off', at: 'hq.enabled', want: false },
    { sub: 'hq-url', args: 'http://localhost:3499', msg: 'HQ URL → http://localhost:3499', at: 'hq.url', want: 'http://localhost:3499' },
    { sub: 'hq-token', args: 'tok-123', msg: 'HQ token saved', at: 'hq.token', want: 'tok-123' },
    { sub: 'hq-raw', args: 'on', msg: 'HQ raw content → on', at: 'hq.rawContent', want: true },
    { sub: 'delay', args: '30', msg: 'auto-proceed delay →', at: 'autonomy.autoProceedDelayMs', want: 30_000 },
    { sub: 'mode', args: 'suggest', msg: 'default autonomy → suggest', at: 'autonomy.defaultMode', want: 'suggest' },
    { sub: 'hints', args: 'off', msg: 'launch hints → off', at: 'hints', want: false },
    { sub: 'debug-stream', args: 'on', msg: 'debug stream → on', at: 'debugStream', want: true },
    { sub: 'config-scope', args: 'project', msg: 'config scope → project', at: 'configScope', want: 'project' },
    { sub: 'fs-access', args: 'project', msg: 'filesystem access → project', at: 'tools.restrictToProjectRoot', want: true },
    { sub: 'refine', args: 'on', msg: 'refine → on', at: 'autonomy.enhance', want: true },
    { sub: 'refine-delay', args: '5', msg: 'refine-delay →', at: 'autonomy.enhanceDelayMs', want: 5_000 },
    { sub: 'refine-language', args: 'english', msg: 'refine-language → english', at: 'autonomy.enhanceLanguage', want: 'english' },
    { sub: 'refiner-provider', args: 'openai', msg: 'refiner-provider → openai', at: 'autonomy.refinerProvider', want: 'openai' },
    { sub: 'refiner-model', args: 'gpt-4o-mini', msg: 'refiner-model → gpt-4o-mini', at: 'autonomy.refinerModel', want: 'gpt-4o-mini' },
    { sub: 'refiner-fallback-profile', args: 'nightly', msg: 'refiner-fallback-profile → nightly', at: 'autonomy.refinerFallbackProfile', want: 'nightly' },
    { sub: 'semver-part', args: 'minor', msg: 'semver default part → minor', at: 'extensions.semver-bump.defaultPart', want: 'minor' },
    { sub: 'breaker', args: 'off', msg: 'circuit breaker → off', at: 'circuitBreaker.enabled', want: false },
    { sub: 'breaker-timeout', args: '60', msg: 'breaker kill/reset timeout →', at: 'circuitBreaker.autoKillResetMs', want: 60_000 },
    { sub: 'context-mode', args: 'frugal', msg: 'context mode → frugal', at: 'context.mode', want: 'frugal' },
    { sub: 'context-strategy', args: 'selective', msg: 'context strategy → selective', at: 'context.strategy', want: 'selective' },
    { sub: 'context-auto-compact', args: 'off', msg: 'context auto-compact → off', at: 'context.autoCompact', want: false },
    { sub: 'token-saving', args: 'aggressive', msg: 'token-saving → aggressive', at: 'features.tokenSavingMode', want: 'aggressive' },
    { sub: 'max-concurrent', args: '6', msg: 'max-concurrent → 6', at: 'maxConcurrent', want: 6 },
    { sub: 'title-animation', args: 'off', msg: 'title animation → off', at: 'autonomy.terminalTitleAnimation', want: false },
    { sub: 'reasoning', args: 'auto', msg: 'reasoning mode → auto', at: 'modelRuntime.reasoning.mode', want: 'auto' },
    { sub: 'reasoning-effort', args: 'xhigh', msg: 'reasoning effort → xhigh', at: 'modelRuntime.reasoning.effort', want: 'xhigh' },
    { sub: 'reasoning-preserve', args: 'on', msg: 'reasoning preserve → on', at: 'modelRuntime.reasoning.preserve', want: true },
    { sub: 'cache-ttl', args: '1h', msg: 'cache TTL → 1h', at: 'modelRuntime.cache.ttl', want: '1h' },
    { sub: 'mcp', args: 'off', msg: 'MCP features → off', at: 'features.mcp', want: false },
    { sub: 'plugins', args: 'off', msg: 'Plugin features → off', at: 'features.plugins', want: false },
    { sub: 'memory', args: 'off', msg: 'Memory features → off', at: 'features.memory', want: false },
    { sub: 'skills', args: 'off', msg: 'Skills features → off', at: 'features.skills', want: false },
    { sub: 'models-registry', args: 'off', msg: 'Models registry → off', at: 'features.modelsRegistry', want: false },
    { sub: 'stream-fleet', args: 'full', msg: 'fleet chat → full', at: 'autonomy.fleetChatVerbosity', want: 'full' },
    { sub: 'chime', args: 'on', msg: 'completion chime → on', at: 'autonomy.chime', want: true },
    { sub: 'confirm-exit', args: 'off', msg: 'confirm before exit → off', at: 'autonomy.confirmExit', want: false },
    { sub: 'max-iterations', args: '12', msg: 'max iterations → 12', at: 'tools.maxIterations', want: 12 },
    { sub: 'auto-proceed-max-iterations', args: '3', msg: 'auto-proceed max iterations → 3', at: 'autonomy.autoProceedMaxIterations', want: 3 },
    { sub: 'index-on-start', args: 'on', msg: 'index on session start → on', at: 'indexing.onSessionStart', want: true },
    { sub: 'log-level', args: 'trace', msg: 'log level → trace', at: 'log.level', want: 'trace' },
    { sub: 'audit-level', args: 'full', msg: 'audit level → full', at: 'session.auditLevel', want: 'full' },
    { sub: 'thinking-word', args: 'vibing', msg: 'thinking word → vibing', at: 'autonomy.thinkingWord', want: 'vibing' },
    { sub: 'statusline', args: 'no-color', msg: 'statusline mode → no-color', at: 'autonomy.statuslineMode', want: 'no-color' },
    { sub: 'read-symbols', args: 'on', msg: 'read symbols → on', at: 'autonomy.readAdvancedMode', want: true },
    { sub: 'animation', args: 'breathe', msg: 'animation style → breathe', at: 'autonomy.animationStyle', want: 'breathe' },
  ])(
    'persists "$sub $args"',
    async ({ sub, args, msg, at: jsonPath, want }) => {
      const { ctx } = makeCtx();
      const out = await run(sub, args, ctx);
      expect(stripAnsi(out.message)).toContain(msg);
      expect(at(written(), jsonPath)).toEqual(want);
    },
  );

  it.each([
    { sub: 'hq', args: '' },
    { sub: 'hq-url', args: '' },
    { sub: 'hq-raw', args: 'maybe' },
    { sub: 'delay', args: '' },
    { sub: 'delay', args: 'abc' },
    { sub: 'delay', args: '-5' },
    { sub: 'mode', args: 'berserk' },
    { sub: 'hints', args: 'maybe' },
    { sub: 'debug-stream', args: 'maybe' },
    { sub: 'config-scope', args: 'galaxy' },
    { sub: 'fs-access', args: 'sandbox' },
    { sub: 'refine', args: 'maybe' },
    { sub: 'refine-delay', args: 'soon' },
    { sub: 'refine-language', args: 'turkish' },
    { sub: 'refiner-provider', args: '' },
    { sub: 'refiner-model', args: '' },
    { sub: 'refiner-fallback-profile', args: '' },
    { sub: 'semver-part', args: 'mega' },
    { sub: 'breaker', args: 'maybe' },
    { sub: 'breaker-timeout', args: 'soon' },
    { sub: 'context-mode', args: 'turbo' },
    { sub: 'context-strategy', args: 'random' },
    { sub: 'context-auto-compact', args: 'maybe' },
    { sub: 'token-saving', args: 'extreme' },
    { sub: 'max-concurrent', args: '' },
    { sub: 'max-concurrent', args: 'x' },
    { sub: 'title-animation', args: 'maybe' },
    { sub: 'reasoning', args: 'maybe' },
    { sub: 'reasoning-effort', args: 'ultra' },
    { sub: 'reasoning-preserve', args: 'maybe' },
    { sub: 'cache-ttl', args: '9h' },
    { sub: 'mcp', args: 'maybe' },
    { sub: 'plugins', args: 'maybe' },
    { sub: 'memory', args: 'maybe' },
    { sub: 'skills', args: 'maybe' },
    { sub: 'models-registry', args: 'maybe' },
    { sub: 'stream-fleet', args: 'loud' },
    { sub: 'chime', args: 'maybe' },
    { sub: 'confirm-exit', args: 'maybe' },
    { sub: 'max-iterations', args: '' },
    { sub: 'max-iterations', args: 'x' },
    { sub: 'auto-proceed-max-iterations', args: 'x' },
    { sub: 'index-on-start', args: 'maybe' },
    { sub: 'log-level', args: 'verbose' },
    { sub: 'audit-level', args: 'verbose' },
    { sub: 'thinking-word', args: '' },
    { sub: 'thinking-word', args: 'x'.repeat(17) },
    { sub: 'statusline', args: 'fancy' },
    { sub: 'read-symbols', args: 'maybe' },
    { sub: 'animation', args: 'glitter' },
  ])(
    'prints usage for invalid "$sub $args"',
    async ({ sub, args }) => {
      const { ctx } = makeCtx();
      const out = await run(sub, args, ctx);
      const text = stripAnsi(out.message);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('✓');
    },
  );
});

describe('executeSettingsSubcommand — special paths', () => {
  it('rejects a non-http hq-url', async () => {
    const { ctx } = makeCtx();
    const out = await run('hq-url', 'ftp://host', ctx);
    expect(stripAnsi(out.message)).toContain('Invalid URL');
  });

  it('includes the current refiner value in usage hints', async () => {
    const { ctx } = makeCtx({ autonomy: { refinerProvider: 'anthropic' } });
    const out = await run('refiner-provider', '', ctx);
    expect(stripAnsi(out.message)).toContain('Current: anthropic');
  });

  it('clears the whole refiner config', async () => {
    const { ctx } = makeCtx({ autonomy: { refinerProvider: 'a', refinerModel: 'b', refinerFallbackProfile: 'c' } });
    const out = await run('refiner-clear', '', ctx);
    expect(stripAnsi(out.message)).toContain('Refiner config cleared');
    const autonomy = written()['autonomy'] as Record<string, unknown>;
    expect(autonomy['refinerProvider']).toBeUndefined();
    expect(autonomy['refinerModel']).toBeUndefined();
    expect(autonomy['refinerFallbackProfile']).toBeUndefined();
  });

  it('forwards refine toggles to the live enhance controller', async () => {
    const enhanceController = { setEnabled: vi.fn() };
    const { ctx } = makeCtx({}, { enhanceController });
    const out = await run('refine', 'off', ctx);
    expect(stripAnsi(out.message)).toContain('refine → off');
    expect(enhanceController.setEnabled).toHaveBeenCalledWith(false);
  });

  it('forwards stream-fleet mode to the live fleet stream controller', async () => {
    const fleetStreamController = { setMode: vi.fn() };
    const { ctx } = makeCtx({}, { fleetStreamController });
    const out = await run('stream-fleet', 'off', ctx);
    expect(stripAnsi(out.message)).toContain('fleet chat → off');
    expect(fleetStreamController.setMode).toHaveBeenCalledWith('off');
  });

  it('maps stream-fleet "on" to full verbosity', async () => {
    const { ctx } = makeCtx();
    const out = await run('stream-fleet', 'on', ctx);
    expect(stripAnsi(out.message)).toContain('fleet chat → full');
    expect(at(written(), 'autonomy.fleetChatVerbosity')).toBe('full');
  });

  it('updates the live context meta for read-symbols', async () => {
    const meta: Record<string, unknown> = {};
    const { ctx } = makeCtx({}, { context: { meta } });
    const out = await run('read-symbols', 'on', ctx);
    expect(stripAnsi(out.message)).toContain('read symbols → on');
    expect(meta['tools.read.advancedMode']).toBe(true);
  });

  it('renders zero-value numbers with their default labels', async () => {
    const concurrent = await run('max-concurrent', '0', makeCtx().ctx);
    expect(stripAnsi(concurrent.message)).toContain('max-concurrent → default');

    const iterations = await run('max-iterations', '0', makeCtx().ctx);
    expect(stripAnsi(iterations.message)).toContain('max iterations → default');

    const auto = await run('auto-proceed-max-iterations', '0', makeCtx().ctx);
    expect(stripAnsi(auto.message)).toContain('auto-proceed max iterations → unlimited');

    const breaker = await run('breaker-timeout', '0', makeCtx().ctx);
    expect(stripAnsi(breaker.message)).toContain('manual');
  });

  it('keeps existing nested config when persisting a sibling field', async () => {
    const { ctx } = makeCtx();
    await run('context-mode', 'deep', ctx);
    await run('context-strategy', 'hybrid', ctx);
    const cfg = written();
    expect(at(cfg, 'context.mode')).toBe('deep');
    expect(at(cfg, 'context.strategy')).toBe('hybrid');
  });

  it('reports unknown settings with the closest match hint', async () => {
    const { ctx } = makeCtx();
    const out = await run('mod', '', ctx);
    const text = stripAnsi(out.message);
    expect(text).toContain('Unknown setting "mod"');
    expect(text).toContain('mode');
  });

  it('wraps persistence failures in a settings error message', async () => {
    // Point the profile config at a directory: the JSON write fails with
    // EISDIR, which the command must convert into a friendly message.
    const store = { get: vi.fn(() => ({})), update: vi.fn() };
    const stat = statSync(dir);
    expect(stat.isDirectory()).toBe(true);
    const ctx = {
      configStore: store,
      paths: { profileConfig: () => dir, inProjectConfig },
    } as never as SlashCommandContext;
    const out = await executeSettingsSubcommand('hints', ['on'], ctx);
    expect(stripAnsi(out.message)).toContain('Settings error');
  });
});
