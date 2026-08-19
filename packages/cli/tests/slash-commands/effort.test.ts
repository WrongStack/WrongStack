import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import type {
  Config,
  ModelsRegistry,
  ReasoningEffort,
  SessionWriter,
} from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEffortCommand } from '../../src/slash-commands/effort.js';
import type { SlashCommandContext } from '../../src/slash-commands/index.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Minimal in-memory ConfigStore: get() returns a mutable draft, update()
 *  merges into it — mirroring how the real store surfaces a persisted write. */
function mkConfigStore(initial: Partial<Config>) {
  let state: Partial<Config> = { ...initial };
  return {
    get: () => state,
    update: (patch: Partial<Config>) => {
      state = { ...state, ...patch };
    },
  };
}

/** Registry stub whose getModel returns a fixed reasoningConfig, with an
 * optional raw provider entry list backing getProvider (see the raw-catalog
 * lookup in loadModelLevels). */
function mkRegistry(
  resolved?: { capabilities: { reasoningConfig?: object } },
  rawModels?: Array<{ id: string; reasoning?: boolean }>,
): ModelsRegistry {
  return {
    getModel: async () => resolved,
    getProvider: async () => (rawModels ? { models: rawModels } : undefined),
  } as never as ModelsRegistry;
}

function mkPaths(profileDir: string) {
  return {
    profileConfig: (profile: string) => path.join(profileDir, profile, 'config.json'),
  } as never as SlashCommandContext['paths'];
}

function mkDeps(opts: {
  profileDir: string;
  config?: Partial<Config>;
  registry?: ModelsRegistry;
}): SlashCommandContext {
  return {
    registry: { register: () => undefined, dispatch: async () => undefined, list: () => [] },
    toolRegistry: { register: () => undefined, tools: [] },
    tokenCounter: new DefaultTokenCounter(),
    renderer: {
      write: () => {},
      writeLine: () => {},
      writeBlock: () => {},
      writeToolCall: () => {},
      writeToolResult: () => {},
      writeDiff: () => {},
      writeWarning: () => {},
      writeError: () => {},
      writeInfo: () => {},
      clear: () => {},
    },
    events: { emit: () => {}, on: () => () => {}, off: () => {} },
    cwd: '/tmp',
    projectRoot: '/tmp',
    configStore: mkConfigStore(
      opts.config ?? { provider: 'openai', model: 'gpt-5.2' },
    ) as never as SlashCommandContext['configStore'],
    modelsRegistry: opts.registry,
    paths: mkPaths(opts.profileDir),
  } as never as SlashCommandContext;
}

const GPT52_RC = {
  default: 'enabled' as const,
  disableSupported: true,
  effortSupported: true,
  effortLevels: ['low', 'medium', 'high'] as ReasoningEffort[],
  preserveThinking: 'unsupported' as const,
};

/** B6 tri-state: reasons, vocabulary undocumented → effortSupported absent. */
const UNDOCUMENTED_RC = {
  default: 'always_on' as const,
  disableSupported: false,
  effortSupported: undefined,
  effortLevels: [] as ReasoningEffort[],
  preserveThinking: 'unsupported' as const,
};

/** Documented absence: toggle-only reasoning → effortSupported false. */
const NO_EFFORT_RC = {
  default: 'enabled' as const,
  disableSupported: true,
  effortSupported: false,
  effortLevels: [] as ReasoningEffort[],
  preserveThinking: 'unsupported' as const,
};

// ── Temp dir setup ─────────────────────────────────────────────────────────

let profileDir: string;

beforeEach(async () => {
  profileDir = path.join(
    os.tmpdir(),
    `wstack-effort-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(path.join(profileDir, 'default'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(profileDir, { recursive: true, force: true });
});

async function readPersisted(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(profileDir, 'default', 'config.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('/effort', () => {
  it('shows current effort, model, and advertised levels', async () => {
    const cmd = buildEffortCommand(
      mkDeps({
        profileDir,
        registry: mkRegistry({ capabilities: { reasoningConfig: GPT52_RC } }),
        config: {
          provider: 'openai',
          model: 'gpt-5.2',
          modelRuntime: { reasoning: { effort: 'high' } },
        } as never as Partial<Config>,
      }),
    );
    const res = await cmd.run('');
    expect(res?.message).toContain('openai/gpt-5.2');
    expect(res?.message).toContain('high');
    expect(res?.message).toContain('low');
    expect(res?.message).toContain('medium');
  });

  it('reports "not set" when no session effort is configured', async () => {
    const cmd = buildEffortCommand(
      mkDeps({
        profileDir,
        registry: mkRegistry(undefined),
        config: { provider: 'openai', model: 'gpt-5.2' } as never as Partial<Config>,
      }),
    );
    const res = await cmd.run('');
    expect(res?.message).toContain('not set');
    expect(res?.message).toContain('unknown');
  });

  it('B6: accepts any level and notes transport gating when vocabulary is undocumented', async () => {
    const cmd = buildEffortCommand(
      mkDeps({
        profileDir,
        registry: mkRegistry({ capabilities: { reasoningConfig: UNDOCUMENTED_RC } }),
        config: { provider: 'gateway', model: 'silentthinker' } as never as Partial<Config>,
      }),
    );
    // View: "not enumerated" note, no advertised levels.
    const view = await cmd.run('');
    expect(view?.message).toContain('not enumerated');
    expect(view?.message).toContain('transport applies its own gating');
    // Set: succeeds (resolver forwards; transport gates).
    const set = await cmd.run('high');
    expect(set?.message).toContain('✓');
    await expect(readPersisted()).resolves.toMatchObject({
      modelRuntime: { reasoning: { effort: 'high' } },
    });
  });

  it('B6: rejects effort when the catalog documents no effort control', async () => {
    const cmd = buildEffortCommand(
      mkDeps({
        profileDir,
        registry: mkRegistry({ capabilities: { reasoningConfig: NO_EFFORT_RC } }),
        config: { provider: 'gateway', model: 'toggler' } as never as Partial<Config>,
      }),
    );
    const view = await cmd.run('');
    expect(view?.message).toContain('no effort control');
    const set = await cmd.run('high');
    expect(set?.message).toContain('No effort control');
    // Nothing persisted on rejection.
    await expect(
      fs.readFile(path.join(profileDir, 'default', 'config.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('B6: rejects effort for a model known not to reason (resolved, no reasoningConfig)', async () => {
    // Model resolves in the catalog and its RAW entry explicitly says
    // reasoning: false — a documented non-reasoning model. Must reject.
    const cmd = buildEffortCommand(
      mkDeps({
        profileDir,
        registry: mkRegistry(
          { capabilities: { reasoning: false } as never },
          [{ id: 'plain-llm', reasoning: false }],
        ),
        config: { provider: 'gateway', model: 'plain-llm' } as never as Partial<Config>,
      }),
    );
    const set = await cmd.run('high');
    expect(set?.message).toContain('No effort control');
  });

  it('B6: stays permissive when the model is absent from the catalog entirely', async () => {
    // getModel returns a resolved shape whose derived capabilities.reasoning
    // is false ONLY because getModel coerces missing metadata (`?? false`) —
    // the raw catalog entry does not exist, so nothing was actually
    // documented. This is the ResolvedModel-collapse regression: rejecting
    // here would claim a fact the catalog never stated.
    const cmd = buildEffortCommand(
      mkDeps({
        profileDir,
        registry: mkRegistry({ capabilities: { reasoning: false } as never }),
        config: { provider: 'gateway', model: 'ghost-model' } as never as Partial<Config>,
      }),
    );
    const set = await cmd.run('high');
    expect(set?.message).toContain('✓');
  });

  it('persists a supported effort and mirrors it into the config store', async () => {
    const deps = mkDeps({
      profileDir,
      registry: mkRegistry({ capabilities: { reasoningConfig: GPT52_RC } }),
    });
    const cmd = buildEffortCommand(deps);
    const res = await cmd.run('medium');
    expect(res?.message).toContain('medium');

    // ConfigStore mirror
    expect(deps.configStore.get().modelRuntime?.reasoning?.effort).toBe('medium');
    // Persisted file (decrypted shape: no secrets to encrypt in this fixture)
    const persisted = await readPersisted();
    expect(persisted['modelRuntime']).toEqual({
      reasoning: { effort: 'medium' },
    });
  });

  it('rejects an effort the model does not advertise', async () => {
    const cmd = buildEffortCommand(
      mkDeps({
        profileDir,
        registry: mkRegistry({ capabilities: { reasoningConfig: GPT52_RC } }),
      }),
    );
    const res = await cmd.run('xhigh');
    expect(res?.message).toContain('Unsupported effort');
    expect(res?.message).toContain('low, medium, high');
    // Nothing persisted
    await expect(readPersisted()).rejects.toThrow();
  });

  it('accepts any canonical level when capabilities are unknown', async () => {
    const deps = mkDeps({
      profileDir,
      registry: mkRegistry(undefined),
    });
    const cmd = buildEffortCommand(deps);
    const res = await cmd.run('xhigh');
    expect(res?.message).toContain('xhigh');
    expect(deps.configStore.get().modelRuntime?.reasoning?.effort).toBe('xhigh');
  });

  it('rejects a non-effort token with usage', async () => {
    const cmd = buildEffortCommand(mkDeps({ profileDir }));
    const res = await cmd.run('turbo');
    expect(res?.message).toContain('Usage:');
  });

  it('clear removes the persisted effort', async () => {
    // Seed the FILE (source of truth for patchSessionEffort) plus the
    // in-memory mirror, matching how a real session reaches this state.
    await fs.mkdir(path.join(profileDir, 'default'), { recursive: true });
    await fs.writeFile(
      path.join(profileDir, 'default', 'config.json'),
      JSON.stringify({ modelRuntime: { reasoning: { effort: 'high', mode: 'on' } } }),
      'utf8',
    );
    const deps = mkDeps({
      profileDir,
      registry: mkRegistry({ capabilities: { reasoningConfig: GPT52_RC } }),
      config: {
        provider: 'openai',
        model: 'gpt-5.2',
        modelRuntime: { reasoning: { effort: 'high', mode: 'on' } },
      } as never as Partial<Config>,
    });
    const cmd = buildEffortCommand(deps);
    const res = await cmd.run('clear');
    expect(res?.message).toContain('cleared');
    const persisted = await readPersisted();
    expect(persisted['modelRuntime']).toEqual({ reasoning: { mode: 'on' } });
  });

  it('clear is a no-op message when nothing is set', async () => {
    const cmd = buildEffortCommand(mkDeps({ profileDir }));
    const res = await cmd.run('clear');
    expect(res?.message).toContain('No session effort set');
  });

  it('matrix lists per-key overrides and reports none when empty', async () => {
    const withOverrides = mkDeps({
      profileDir,
      config: {
        provider: 'openai',
        model: 'gpt-5.2',
        modelMatrix: {
          'security-scanner': { modelRuntime: { reasoning: { effort: 'low' } } },
        },
      } as never as Partial<Config>,
    });
    const cmd = buildEffortCommand(withOverrides);
    const res = await cmd.run('matrix');
    expect(res?.message).toContain('security-scanner');
    expect(res?.message).toContain('effort:low');

    const empty = buildEffortCommand(mkDeps({ profileDir }));
    const res2 = await empty.run('matrix');
    expect(res2?.message).toContain('none');
  });

  it('flags a persisted effort the model no longer advertises', async () => {
    const cmd = buildEffortCommand(
      mkDeps({
        profileDir,
        registry: mkRegistry({ capabilities: { reasoningConfig: GPT52_RC } }),
        config: {
          provider: 'openai',
          model: 'gpt-5.2',
          modelRuntime: { reasoning: { effort: 'max' } },
        } as never as Partial<Config>,
      }),
    );
    const res = await cmd.run('');
    expect(res?.message).toContain('not advertised');
  });

  it('shows help', async () => {
    const cmd = buildEffortCommand(mkDeps({ profileDir }));
    const res = await cmd.run('help');
    expect(res?.message).toContain('Usage:');
    expect(res?.message).toContain('/effort clear');
  });
});
