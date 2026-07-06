import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_CATALOG, type Config } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildSetModelCommand } from '../src/slash-commands/setmodel.js';
import { buildShadowCommand } from '../src/slash-commands/shadow.js';

const sampleRole = Object.keys(AGENT_CATALOG)[0]!;

function baseConfig(): Partial<Config> {
  return {
    version: 1,
    provider: 'anthropic',
    model: 'anthropic-test-model',
    providers: {
      anthropic: { type: 'anthropic', apiKey: 'sk-ant-x' },
      minimax: { type: 'minimax', apiKey: 'mm-y' },
      nokey: { type: 'nokey' },
    },
  };
}

let tmpDir: string;
let globalConfigPath: string;

function makeCtx(initial: Partial<Config>): {
  ctx: SlashCommandContext;
  store: { value: Partial<Config> };
} {
  const store = { value: { ...initial } };
  const ctx = {
    paths: { globalConfig: globalConfigPath },
    configStore: {
      get: () => store.value,
      update: (partial: Partial<Config>) => {
        store.value = { ...store.value, ...partial };
        return store.value;
      },
    },
  } as never as SlashCommandContext;
  return { ctx, store };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-setmodel-'));
  globalConfigPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(globalConfigPath, JSON.stringify(baseConfig(), null, 2));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const readFile = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(globalConfigPath, 'utf8')) as Record<string, unknown>;

describe('/setmodel slash command', () => {
  it('exposes metadata', () => {
    const cmd = buildSetModelCommand(makeCtx(baseConfig()).ctx);
    expect(cmd.name).toBe('setmodel');
    expect(cmd.help).toContain('/setmodel set');
  });

  it('shows the leader model and an empty matrix hint with no args', async () => {
    const cmd = buildSetModelCommand(makeCtx(baseConfig()).ctx);
    const out = await cmd.run!('', undefined);
    expect(out!.message).toContain('anthropic/anthropic-test-model');
    expect(out!.message).toMatch(/empty/);
  });

  it('lists keyed providers (excluding key-less ones)', async () => {
    const cmd = buildSetModelCommand(makeCtx(baseConfig()).ctx);
    const out = await cmd.run!('list', undefined);
    expect(out!.message).toContain('anthropic');
    expect(out!.message).toContain('minimax');
    expect(out!.message).not.toContain('nokey');
    expect(out!.message).toContain(sampleRole);
  });

  it('sets the leader model and persists it', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('leader minimax minimax-m3', undefined);
    expect(out!.message).toMatch(/✓|leader/);
    expect(store.value.provider).toBe('minimax');
    expect(store.value.model).toBe('minimax-m3');
    expect(readFile().provider).toBe('minimax');
    expect(readFile().model).toBe('minimax-m3');
  });

  it('sets the leader from a fallback profile and uses the rest as fallbacks', async () => {
    const initial = {
      ...baseConfig(),
      fallbackProfiles: {
        fallback1: ['minimax/minimax-m3', 'anthropic/claude-haiku-4-5'],
      },
    };
    fs.writeFileSync(globalConfigPath, JSON.stringify(initial, null, 2));
    const { ctx, store } = makeCtx(initial);
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('leader fallback1', undefined);
    expect(out!.message).toContain('profile:fallback1');
    expect(store.value.provider).toBe('minimax');
    expect(store.value.model).toBe('minimax-m3');
    expect(store.value.fallbackModels).toEqual(['anthropic/claude-haiku-4-5']);
    expect(readFile().fallbackModels).toEqual(['anthropic/claude-haiku-4-5']);
  });

  it('updated leader model becomes the shadow default on next start', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const setmodel = buildSetModelCommand(ctx);
    await setmodel.run!('leader minimax minimax-m3', undefined);

    const onSpawn = vi.fn(async () => 'sub-shadow');
    const shadow = buildShadowCommand({
      onSpawn,
      configStore: ctx.configStore,
      shadowController: {
        activeId: null,
        register: vi.fn(),
        clear: vi.fn(),
        getDefaults: vi.fn(() => ({})),
        setDefaults: vi.fn(),
      },
      llmProvider: { id: 'anthropic' },
      llmModel: 'stale-session-model',
    } as never);

    const out = await shadow.run!('start', undefined as never);

    expect(onSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ provider: 'minimax', model: 'minimax-m3' }),
    );
    expect(out!.message).toContain('minimax/minimax-m3');
    expect(store.value.provider).toBe('minimax');
    expect(store.value.model).toBe('minimax-m3');
  });

  it('rejects a leader provider without a key', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('leader nokey some-model', undefined);
    expect(out!.message).toMatch(/not available/);
    expect(store.value.provider).toBe('anthropic');
  });

  it('sets a matrix entry by role with provider/model syntax', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!(`set ${sampleRole} minimax/minimax-m3`, undefined);
    expect(out!.message).toMatch(/✓|→/);
    const matrix = (store.value.modelMatrix ?? {}) as Record<string, unknown>;
    expect(matrix[sampleRole]).toEqual({ provider: 'minimax', model: 'minimax-m3' });
    const persisted = (readFile().modelMatrix as Record<string, unknown>)[sampleRole];
    expect(persisted).toEqual({ provider: 'minimax', model: 'minimax-m3' });
  });

  it('sets a bare-model matrix entry (leader provider at resolve)', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    await cmd.run!('set * some-model', undefined);
    expect((store.value.modelMatrix as Record<string, unknown>)['*']).toEqual({
      model: 'some-model',
    });
  });

  it('sets a matrix key to a fallback profile', async () => {
    const initial = {
      ...baseConfig(),
      fallbackProfiles: {
        fallback1: ['minimax/minimax-m3', 'anthropic/claude-haiku-4-5'],
      },
    };
    fs.writeFileSync(globalConfigPath, JSON.stringify(initial, null, 2));
    const { ctx, store } = makeCtx(initial);
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!(`set ${sampleRole} fallback1`, undefined);
    expect(out!.message).toContain('profile:fallback1');
    expect((store.value.modelMatrix as Record<string, unknown>)[sampleRole]).toEqual({
      fallbackProfile: 'fallback1',
    });
    expect((readFile().modelMatrix as Record<string, unknown>)[sampleRole]).toEqual({
      fallbackProfile: 'fallback1',
    });
  });

  it('sets role-specific reasoning runtime without requiring a model override', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!(`reasoning ${sampleRole} on low`, undefined);
    expect(out!.message).toContain('effort:low');
    const entry = (store.value.modelMatrix as Record<string, unknown>)[sampleRole];
    expect(entry).toEqual({
      modelRuntime: { reasoning: { mode: 'on', effort: 'low' } },
    });
    const persisted = (readFile().modelMatrix as Record<string, unknown>)[sampleRole];
    expect(persisted).toEqual(entry);
  });

  it('rejects an unknown matrix key', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('set not-a-real-key minimax/x', undefined);
    expect(out!.message).toMatch(/Unknown key/);
    expect(store.value.modelMatrix).toBeUndefined();
  });

  it('rejects a matrix provider without a key', async () => {
    const { ctx } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!(`set ${sampleRole} nokey/x`, undefined);
    expect(out!.message).toMatch(/not available/);
  });

  it('clears a matrix entry', async () => {
    const initial = { ...baseConfig(), modelMatrix: { '*': { model: 'x' } } };
    const { ctx, store } = makeCtx(initial);
    fs.writeFileSync(globalConfigPath, JSON.stringify(initial, null, 2));
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('clear *', undefined);
    expect(out!.message).toMatch(/cleared/);
    expect((store.value.modelMatrix as Record<string, unknown>)['*']).toBeUndefined();
    expect((readFile().modelMatrix as Record<string, unknown>)['*']).toBeUndefined();
  });

  it('reports unavailable when paths are missing', async () => {
    const { ctx } = makeCtx(baseConfig());
    (ctx as { paths?: unknown }).paths = undefined;
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('list', undefined);
    expect(out!.message).toMatch(/not available/);
  });

  // ---- resolve ----
  it('resolve shows the resolution chain for a role', async () => {
    const { ctx } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('resolve explore', undefined);
    expect(out!.message).toContain('Resolution chain');
    expect(out!.message).toContain('explore');
    expect(out!.message).toContain('not set'); // no matrix entry
    expect(out!.message).toContain('leader fallback');
    expect(out!.message).toContain('✓ Resolved');
  });

  it('resolve shows exact role match when set', async () => {
    const initial = {
      ...baseConfig(),
      modelMatrix: { explore: { model: 'claude-opus-5' } },
    };
    const { ctx } = makeCtx(initial);
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('resolve explore', undefined);
    expect(out!.message).toContain('✓ exact role');
    expect(out!.message).toContain('claude-opus-5');
  });

  it('resolve rejects an unknown role', async () => {
    const { ctx } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('resolve not-a-role', undefined);
    expect(out!.message).toMatch(/Unknown role/);
  });

  // ---- doctor ----
  it('doctor reports clean when matrix is empty', async () => {
    const { ctx } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('doctor', undefined);
    expect(out!.message).toContain('All matrix entries are valid');
  });

  it('doctor flags unknown keys', async () => {
    const initial = {
      ...baseConfig(),
      modelMatrix: { 'stale-role': { model: 'x' } as { model: string } },
    };
    const { ctx } = makeCtx(initial);
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('doctor', undefined);
    expect(out!.message).toContain('not a valid role');
  });

  it('doctor flags missing providers', async () => {
    const initial = {
      ...baseConfig(),
      modelMatrix: { [sampleRole]: { provider: 'nonexistent', model: 'x' } },
    };
    const { ctx } = makeCtx(initial);
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('doctor', undefined);
    expect(out!.message).toContain('not configured');
  });

  it('doctor warns about uncovered roles when no * default', async () => {
    const initial = {
      ...baseConfig(),
      modelMatrix: { 'security-scanner': { model: 'x' } },
    };
    const { ctx } = makeCtx(initial);
    fs.writeFileSync(globalConfigPath, JSON.stringify(initial, null, 2));
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('doctor', undefined);
    expect(out!.message).toContain('no matrix coverage');
  });

  // ---- enhanced default view ----
  it('shows resolution summary in default view', async () => {
    const { ctx } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('', undefined);
    expect(out!.message).toContain('resolution');
    expect(out!.message).toContain('leader');
  });

  it('default view shows matrix entries when set', async () => {
    const initial = {
      ...baseConfig(),
      modelMatrix: { '*': { model: 'gemini-pro' } },
    };
    const { ctx } = makeCtx(initial);
    fs.writeFileSync(globalConfigPath, JSON.stringify(initial, null, 2));
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('', undefined);
    expect(out!.message).toContain('gemini-pro');
    expect(out!.message).toContain('default');
  });

  it('updated help text includes new subcommands', () => {
    const cmd = buildSetModelCommand(makeCtx(baseConfig()).ctx);
    expect(cmd.help).toContain('/setmodel resolve');
    expect(cmd.help).toContain('/setmodel doctor');
  });

  it('throws a structured ConfigError when global config is corrupt JSON', async () => {
    // Write invalid JSON to the config file. The patchGlobalConfig helper
    // throws ConfigError(CONFIG_PARSE_FAILED) — the slash-command runner
    // catches it and surfaces the message.
    fs.writeFileSync(globalConfigPath, '{not valid json');
    const cmd = buildSetModelCommand(makeCtx(baseConfig()).ctx);
    const res = await cmd.run!('leader anthropic anthropic-test-model', undefined);
    expect(res?.message).toContain('not valid JSON');
    expect(res?.message).toContain(globalConfigPath);
  });
});
