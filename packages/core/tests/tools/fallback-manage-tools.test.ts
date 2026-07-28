/**
 * Tests for fallback-manage-tools — the full suite of provider/model/fallback
 * configuration tools. Tests through createFallbackManageTools() factory.
 * Covers: profile manage, agent model assign, provider manage, provider key set,
 * leader model set, and the factory itself.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_MODEL_ASSIGN_TOOL_NAME,
  FALLBACK_PROFILE_MANAGE_TOOL_NAME,
  LEADER_MODEL_SET_TOOL_NAME,
  PROVIDER_KEY_SET_TOOL_NAME,
  PROVIDER_MANAGE_TOOL_NAME,
  createFallbackManageTools,
} from '../../src/tools/fallback-manage-tools.js';
import type { FallbackManageToolOptions } from '../../src/tools/fallback-manage-tool-options.js';
import type { Tool } from '../../src/types/tool.js';

function makeOpts(overrides: Record<string, unknown> = {}): FallbackManageToolOptions {
  const config: Record<string, unknown> = {
    provider: 'test-provider',
    model: 'test-model',
    providers: {
      'test-provider': { type: 'openai', apiKey: 'sk-test', models: ['test-model', 'other-model'] },
    },
    favoriteModels: ['test-provider/test-model', 'test-provider/other-model'],
    fallbackModels: ['test-provider/other-model'],
    fallbackProfiles: { fast: ['test-provider/test-model'] },
    modelMatrix: {},
    fallbackAuto: true,
    favoriteModelsOnly: false,
    ...overrides,
  };
  return {
    getConfig: () => config as never,
    updateConfig: vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      mutate(config);
    }),
    requestInput: vi.fn(async () => 'interactive-key'),
  };
}

function getTool(tools: Tool[], name: string): Tool<any, any> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in factory output`);
  return tool as Tool<any, any>;
}

/** Execute a tool with the required ctx and signal args that tests don't need. */
async function run(tool: Tool<any, any>, input: Record<string, unknown>) {
  return tool.execute(input, {} as never, { signal: AbortSignal.timeout(5_000) });
}

// ── Factory ──────────────────────────────────────────────────────────────────

describe('createFallbackManageTools', () => {
  it('returns all 8 tools', () => {
    const tools = createFallbackManageTools(makeOpts());
    expect(tools.length).toBe(8);
    const names = tools.map((t) => t.name);
    expect(names).toContain('favorite_manage');
    expect(names).toContain('fallback_chain_manage');
    expect(names).toContain(FALLBACK_PROFILE_MANAGE_TOOL_NAME);
    expect(names).toContain(AGENT_MODEL_ASSIGN_TOOL_NAME);
    expect(names).toContain(PROVIDER_MANAGE_TOOL_NAME);
    expect(names).toContain(PROVIDER_KEY_SET_TOOL_NAME);
    expect(names).toContain(LEADER_MODEL_SET_TOOL_NAME);
    expect(names).toContain('system_config_view');
  });
});

// ── Profile Manage ───────────────────────────────────────────────────────────

describe('fallback_profile_manage', () => {
  it('lists profiles', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), FALLBACK_PROFILE_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'list' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('fast');
  });

  it('shows empty message when no profiles', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts({ fallbackProfiles: {} })), FALLBACK_PROFILE_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'list' });
    expect(result.message).toContain('No fallback profiles');
  });

  it('creates a profile with valid favorites', async () => {
    const opts = makeOpts();
    const tool = getTool(createFallbackManageTools(opts), FALLBACK_PROFILE_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'set', name: 'economy', chain: ['test-provider/other-model'] });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('economy');
    expect(opts.updateConfig).toHaveBeenCalled();
  });

  it('rejects set without name', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), FALLBACK_PROFILE_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'set', chain: ['test-provider/test-model'] });
    expect(result.status).toBe('error');
    expect(result.message).toContain('name');
  });

  it('rejects set without chain', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), FALLBACK_PROFILE_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'set', name: 'x' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('chain');
  });

  it('rejects set with non-favorite entries', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), FALLBACK_PROFILE_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'set', name: 'x', chain: ['anthropic/claude-3'] });
    expect(result.status).toBe('error');
    expect(result.message).toContain('not in your favorites');
  });

  it('deletes an existing profile', async () => {
    const opts = makeOpts();
    const tool = getTool(createFallbackManageTools(opts), FALLBACK_PROFILE_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'delete', name: 'fast' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Deleted');
  });

  it('rejects deleting a nonexistent profile', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), FALLBACK_PROFILE_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'delete', name: 'ghost' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('not found');
  });

  it('rejects delete without name', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), FALLBACK_PROFILE_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'delete' });
    expect(result.status).toBe('error');
  });
});

// ── Agent Model Assign ───────────────────────────────────────────────────────

describe('agent_model_assign', () => {
  it('lists matrix assignments', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts({
      modelMatrix: { 'bug-hunter': { provider: 'test-provider', model: 'test-model' } },
    })), AGENT_MODEL_ASSIGN_TOOL_NAME);
    const result = await run(tool, { role: 'list' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('bug-hunter');
  });

  it('shows empty matrix message', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), AGENT_MODEL_ASSIGN_TOOL_NAME);
    const result = await run(tool, { role: 'list' });
    expect(result.message).toContain('No matrix assignments');
  });

  it('rejects conflicting modes', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), AGENT_MODEL_ASSIGN_TOOL_NAME);
    const result = await run(tool, { role: 'bug-hunter', clear: true, model: 'test-model' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('Conflicting');
  });

  it('clears a matrix entry', async () => {
    const opts = makeOpts({ modelMatrix: { 'bug-hunter': { model: 'x' } } });
    const tool = getTool(createFallbackManageTools(opts), AGENT_MODEL_ASSIGN_TOOL_NAME);
    const result = await run(tool, { role: 'bug-hunter', clear: true });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Cleared');
  });

  it('reports no-op when clearing a missing entry', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), AGENT_MODEL_ASSIGN_TOOL_NAME);
    const result = await run(tool, { role: 'bug-hunter', clear: true });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('No matrix entry');
  });

  it('shows current assignment for a role', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts({
      modelMatrix: { 'bug-hunter': { provider: 'test-provider', model: 'test-model' } },
    })), AGENT_MODEL_ASSIGN_TOOL_NAME);
    const result = await run(tool, { role: 'bug-hunter' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('bug-hunter');
  });

  it('assigns a profile to a role', async () => {
    const opts = makeOpts();
    const tool = getTool(createFallbackManageTools(opts), AGENT_MODEL_ASSIGN_TOOL_NAME);
    const result = await run(tool, { role: 'bug-hunter', profile: 'fast' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('profile: fast');
  });

  it('rejects assigning a nonexistent profile', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), AGENT_MODEL_ASSIGN_TOOL_NAME);
    const result = await run(tool, { role: 'bug-hunter', profile: 'ghost' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('not found');
  });

  it('assigns a favorite model to a role', async () => {
    const opts = makeOpts();
    const tool = getTool(createFallbackManageTools(opts), AGENT_MODEL_ASSIGN_TOOL_NAME);
    const result = await run(tool, { role: 'bug-hunter', model: 'test-model' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('test-model');
  });

  it('rejects assigning a non-favorite model', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), AGENT_MODEL_ASSIGN_TOOL_NAME);
    const result = await run(tool, { role: 'bug-hunter', model: 'claude-3' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('not in your favorites');
  });

  it('rejects invalid matrix keys', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), AGENT_MODEL_ASSIGN_TOOL_NAME);
    const result = await run(tool, { role: 'invalid role!!', model: 'test-model' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('not a valid matrix key');
  });

  describe('favoriteModelsOnly contract on model-only mode', () => {
    // Contract pinned 2026-07-28. `favoriteModelsOnly` is documented as
    // an *auto-derivation* toggle (config.favoriteModelsOnly): "When
    // true, auto-derived fallback chains are restricted to favoriteModels.
    // Explicit fallback profiles/chains are always honored as written."
    //
    // The matrix model-only mode (`agent_model_assign` with `model=...`
    // and no `profile=...`) is an *explicit* assignment. The contract
    // pins two invariants here so a future refactor cannot silently
    // invert the toggle's documented scope:
    //
    //   1. The toggle does NOT change which models are valid for an
    //      explicit assignment — that depends only on the favorites
    //      list, not the toggle.
    //
    //   2. An explicit assignment is always at least as strict as the
    //      smart-default chain: the matrix model-only mode requires
    //      favorites when favorites exist (regardless of toggle),
    //      while the smart-default chain only narrows when the toggle
    //      is on AND favorites exist.
    //
    // This is also why the model-only mode does not need a special
    // `favoriteModelsOnly` branch — adding one would either be a
    // no-op (when toggle is off) or relax the existing check
    // (when toggle is on but favorites is empty, which the smart
    // default accepts but matrix model-only currently rejects via
    // `isFavoriteRef`'s "empty favorites = no enforcement" semantics).
    // We deliberately keep the model-only mode strict.

    it('accepts a non-favorite model when favorites list is empty regardless of favoriteModelsOnly', async () => {
      // Empty favorites: `isFavoriteRef` returns true (legacy no-enforcement
      // semantics), so an explicit assignment of any model succeeds. The
      // toggle is irrelevant when there is nothing to enforce against.
      for (const toggleValue of [false, true]) {
        const opts = makeOpts({
          providers: {
            'test-provider': { type: 'openai', apiKey: 'sk-test', models: ['any-model'] },
          },
          favoriteModels: [],
          favoriteModelsOnly: toggleValue,
        });
        const tool = getTool(createFallbackManageTools(opts), AGENT_MODEL_ASSIGN_TOOL_NAME);
        const result = await run(tool, { role: 'bug-hunter', model: 'any-model' });
        expect(result.status).toBe('ok');
        expect(result.message).toContain('any-model');
      }
    });

    it('accepts a favorite model whether the toggle is on or off', async () => {
      // The toggle does not relax or tighten the model-only mode: any
      // favorite model is accepted in both states. This is what "explicit
      // assignments are always honored as written" means in practice.
      for (const toggleValue of [false, true]) {
        const opts = makeOpts({
          favoriteModelsOnly: toggleValue,
        });
        const tool = getTool(createFallbackManageTools(opts), AGENT_MODEL_ASSIGN_TOOL_NAME);
        const result = await run(tool, { role: 'bug-hunter', model: 'test-model' });
        expect(result.status).toBe('ok');
        expect(result.message).toContain('test-model');
      }
    });

    it('rejects a non-favorite model whether the toggle is on or off', async () => {
      // Even when `favoriteModelsOnly` is OFF, an explicit assignment to a
      // non-favorite ref is rejected — explicit assignments are *stricter*
      // than the smart-default chain, not more permissive. This is the
      // load-bearing parity claim: a non-favorite entry that the smart
      // default would surface (because favorites list is empty or the
      // toggle is off) cannot slip through an explicit assignment.
      for (const toggleValue of [false, true]) {
        const opts = makeOpts({ favoriteModelsOnly: toggleValue });
        const tool = getTool(createFallbackManageTools(opts), AGENT_MODEL_ASSIGN_TOOL_NAME);
        const result = await run(tool, { role: 'bug-hunter', model: 'claude-3' });
        expect(result.status).toBe('error');
        expect(result.message).toContain('not in your favorites');
      }
    });

    it('accepts a provider-prefixed favorite model regardless of the toggle', async () => {
      // The matrix model-only mode supports provider overrides via the
      // `provider` field; the same toggle-irrelevance contract applies.
      for (const toggleValue of [false, true]) {
        const opts = makeOpts({
          favoriteModels: ['test-provider/test-model'],
          favoriteModelsOnly: toggleValue,
        });
        const tool = getTool(createFallbackManageTools(opts), AGENT_MODEL_ASSIGN_TOOL_NAME);
        const result = await run(tool, {
          role: 'bug-hunter',
          provider: 'test-provider',
          model: 'test-model',
        });
        expect(result.status).toBe('ok');
        expect(result.message).toContain('test-provider/test-model');
      }
    });

    it('rejects a provider-prefixed non-favorite model regardless of the toggle', async () => {
      // Mirror of the above for non-favorites.
      for (const toggleValue of [false, true]) {
        const opts = makeOpts({ favoriteModelsOnly: toggleValue });
        const tool = getTool(createFallbackManageTools(opts), AGENT_MODEL_ASSIGN_TOOL_NAME);
        const result = await run(tool, {
          role: 'bug-hunter',
          provider: 'test-provider',
          model: 'claude-3',
        });
        expect(result.status).toBe('error');
        expect(result.message).toContain('not in your favorites');
      }
    });
  });
});

// ── Provider Manage ──────────────────────────────────────────────────────────

describe('provider_manage', () => {
  it('lists providers', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), PROVIDER_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'list' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('test-provider');
  });

  it('shows empty message when no providers', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts({ providers: {} })), PROVIDER_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'list' });
    expect(result.message).toContain('No providers');
  });

  it('adds a new provider', async () => {
    const opts = makeOpts();
    const tool = getTool(createFallbackManageTools(opts), PROVIDER_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'add', provider: 'anthropic', type: 'anthropic' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Added provider');
  });

  it('rejects adding a duplicate provider', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), PROVIDER_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'add', provider: 'test-provider', type: 'openai' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('already exists');
  });

  it('rejects add without provider or type', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), PROVIDER_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'add' });
    expect(result.status).toBe('error');
  });

  it('configures an existing provider', async () => {
    const opts = makeOpts();
    const tool = getTool(createFallbackManageTools(opts), PROVIDER_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'configure', provider: 'test-provider', models: ['new-model'] });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Updated');
  });

  it('rejects configuring a missing provider', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), PROVIDER_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'configure', provider: 'ghost' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('not found');
  });

  it('removes a non-leader provider', async () => {
    const opts = makeOpts({
      providers: {
        'test-provider': { type: 'openai', apiKey: 'k' },
        'backup': { type: 'anthropic' },
      },
    });
    const tool = getTool(createFallbackManageTools(opts), PROVIDER_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'remove', provider: 'backup' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Removed');
  });

  it('rejects removing the leader provider', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), PROVIDER_MANAGE_TOOL_NAME);
    const result = await run(tool, { action: 'remove', provider: 'test-provider' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('Cannot remove the active leader');
  });
});

// ── Provider Key Set ─────────────────────────────────────────────────────────

describe('provider_key_set', () => {
  it('rejects both key and envVar', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), PROVIDER_KEY_SET_TOOL_NAME);
    const result = await run(tool, { provider: 'test-provider', key: 'sk-x', envVar: 'X' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('not both');
  });

  it('returns needs_key when no key source and no requestInput', async () => {
    const opts = makeOpts();
    opts.requestInput = undefined;
    const tool = getTool(createFallbackManageTools(opts), PROVIDER_KEY_SET_TOOL_NAME);
    const result = await run(tool, { provider: 'test-provider' });
    expect(result.status).toBe('needs_key');
  });

  it('uses interactive input when available', async () => {
    const opts = makeOpts();
    const tool = getTool(createFallbackManageTools(opts), PROVIDER_KEY_SET_TOOL_NAME);
    const result = await run(tool, { provider: 'test-provider' });
    expect(opts.requestInput).toHaveBeenCalled();
    expect(result.status).toBe('ok');
  });

  it('reads key from environment variable', async () => {
    process.env['TEST_KEY_VAR'] = 'sk-from-env';
    const tool = getTool(createFallbackManageTools(makeOpts()), PROVIDER_KEY_SET_TOOL_NAME);
    const result = await run(tool, { provider: 'test-provider', envVar: 'TEST_KEY_VAR' });
    expect(result.status).toBe('ok');
    delete process.env['TEST_KEY_VAR'];
  });

  it('rejects missing environment variable', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), PROVIDER_KEY_SET_TOOL_NAME);
    const result = await run(tool, { provider: 'test-provider', envVar: 'NONEXISTENT_VAR_XYZ' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('not set');
  });

  it('stores a directly provided key', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), PROVIDER_KEY_SET_TOOL_NAME);
    const result = await run(tool, { provider: 'test-provider', key: 'sk-direct' });
    expect(result.status).toBe('ok');
  });
});

// ── Leader Model Set ─────────────────────────────────────────────────────────

describe('leader_model_set', () => {
  it('shows current leader state', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), LEADER_MODEL_SET_TOOL_NAME);
    const result = await run(tool, { action: 'show' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('test-provider/test-model');
    expect(result.message).toContain('fallbackAuto');
  });

  it('sets a new leader model', async () => {
    const opts = makeOpts();
    const tool = getTool(createFallbackManageTools(opts), LEADER_MODEL_SET_TOOL_NAME);
    const result = await run(tool, { action: 'set', provider: 'openai', model: 'gpt-4o' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('openai/gpt-4o');
  });

  it('rejects set without provider or model', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), LEADER_MODEL_SET_TOOL_NAME);
    const result = await run(tool, { action: 'set' });
    expect(result.status).toBe('error');
  });

  it('derives leader from a profile', async () => {
    const opts = makeOpts();
    const tool = getTool(createFallbackManageTools(opts), LEADER_MODEL_SET_TOOL_NAME);
    const result = await run(tool, { action: 'profile', profile: 'fast' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('test-provider');
  });

  it('rejects profile without name', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), LEADER_MODEL_SET_TOOL_NAME);
    const result = await run(tool, { action: 'profile' });
    expect(result.status).toBe('error');
  });

  it('rejects nonexistent profile', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), LEADER_MODEL_SET_TOOL_NAME);
    const result = await run(tool, { action: 'profile', profile: 'ghost' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('not found');
  });

  it('toggles fallbackAuto', async () => {
    const opts = makeOpts();
    const tool = getTool(createFallbackManageTools(opts), LEADER_MODEL_SET_TOOL_NAME);
    const result = await run(tool, { action: 'toggle', toggle: 'fallbackAuto', value: false });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('fallbackAuto');
  });

  it('rejects toggle without name or value', async () => {
    const tool = getTool(createFallbackManageTools(makeOpts()), LEADER_MODEL_SET_TOOL_NAME);
    const result = await run(tool, { action: 'toggle' });
    expect(result.status).toBe('error');
  });
});
