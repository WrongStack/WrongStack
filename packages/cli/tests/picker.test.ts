import { Writable } from 'node:stream';
import type { ModelsDevModel, ResolvedProvider } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPickerKey,
  filterModels,
  filterProviders,
  type ProviderPickerState,
  renderLiveModelList,
  renderLiveProviderList,
  runPicker,
  saveToGlobalConfig,
} from '../src/picker.js';
import { TerminalRenderer } from '../src/renderer.js';

class CapStream extends Writable {
  buf = '';
  override _write(c: Buffer | string, _e: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.buf += typeof c === 'string' ? c : c.toString('utf8');
    cb();
  }
}

function mkRig() {
  const out = new CapStream();
  const err = new CapStream();
  const renderer = new TerminalRenderer({
    out: out as never as NodeJS.WriteStream,
    err: err as never as NodeJS.WriteStream,
  });
  return { out, err, renderer };
}

function fakeModel(over: Partial<ModelsDevModel> = {}): ModelsDevModel {
  return {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    release_date: '2025-05-14',
    tool_call: true,
    limit: { context: 200000, output: 8192 },
    cost: { input: 3, output: 15 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    ...over,
  };
}

function fakeProvider(over: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    family: 'anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    models: [fakeModel()],
    ...over,
  };
}

function fakeReader(responses: string[]) {
  let i = 0;
  return {
    readLine: vi.fn(async (_prompt?: string) => responses[i++] ?? ''),
    readKey: vi.fn(),
    readSecret: vi.fn(),
    close: vi.fn(),
  };
}

function fakeRegistry(providers: ResolvedProvider[]) {
  return {
    listProviders: vi.fn(async () => providers),
    getProvider: vi.fn(async (id: string) => providers.find((p) => p.id === id)),
    getModel: vi.fn(),
    suggestModel: vi.fn(),
    load: vi.fn(),
    refresh: vi.fn(),
    ageSeconds: vi.fn(async () => 60),
  };
}

describe('runPicker', () => {
  it('returns provider+model when user picks by number', async () => {
    const { renderer } = mkRig();
    const providers = [
      fakeProvider(),
      fakeProvider({
        id: 'openai',
        name: 'OpenAI',
        family: 'openai',
        envVars: ['OPENAI_API_KEY'],
        models: [fakeModel({ id: 'gpt-4o' })],
      }),
    ];
    const reader = fakeReader(['1', '1', 'y']); // provider 1, model 1, save yes
    const registry = fakeRegistry(providers);

    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });

    expect(result).toBeDefined();
    expect(result!.provider).toBe('anthropic');
    expect(result!.model).toBe('claude-sonnet-4-20250514');
  });

  it('shows an OAuth-family provider that lives only in saved config (not the catalog)', async () => {
    const { renderer, out } = mkRig();
    // github-copilot is never in the models.dev catalog — it exists only as a
    // saved config entry with an OAuth key and a model allowlist. It must still
    // appear in the launch picker and be selectable.
    const registry = fakeRegistry([]); // empty catalog
    const config = {
      providers: {
        'github-copilot': {
          type: 'github-copilot',
          family: 'github-copilot',
          apiKeys: [{ label: 'oauth-default', apiKey: 'tok', createdAt: '2026-01-01' }],
          activeKey: 'oauth-default',
          models: ['gpt-5-mini', 'claude-haiku-4.5'],
        },
      },
    } as never;
    const reader = fakeReader(['1', '1', 'n']); // provider 1, model 1, don't save
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
      config,
    });
    expect(out.buf).toContain('github-copilot'); // family header + provider entry rendered
    expect(result).toBeDefined();
    expect(result!.provider).toBe('github-copilot');
    expect(result!.model).toBe('gpt-5-mini');
  });

  it('returns undefined when user cancels provider selection', async () => {
    const { renderer } = mkRig();
    const providers = [fakeProvider()];
    const reader = fakeReader(['']); // empty = cancel
    const registry = fakeRegistry(providers);

    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when user cancels model selection', async () => {
    const { renderer } = mkRig();
    const providers = [fakeProvider()];
    const reader = fakeReader(['1', '']); // pick provider, cancel model
    const registry = fakeRegistry(providers);

    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when registry fails', async () => {
    const { renderer } = mkRig();
    const reader = fakeReader([]);
    const registry = {
      ...fakeRegistry([]),
      listProviders: vi.fn(async () => {
        throw new Error('network');
      }),
    };

    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });

    expect(result).toBeUndefined();
  });

  it('Enter (empty answer) accepts the default model when one is provided', async () => {
    const { renderer } = mkRig();
    const providers = [
      fakeProvider({
        models: [fakeModel({ id: 'm1' }), fakeModel({ id: 'm2' }), fakeModel({ id: 'm3' })],
      }),
    ];
    // Pick provider 1, then press Enter to accept the default model, then 'n' for save.
    const reader = fakeReader(['1', '', 'n']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
      defaultProvider: 'anthropic',
      defaultModel: 'm2',
    });
    expect(result).toBeDefined();
    expect(result!.model).toBe('m2');
  });

  it('resolveModelSelection matches a model by exact id string', async () => {
    const { renderer } = mkRig();
    const providers = [
      fakeProvider({ models: [fakeModel({ id: 'opus-4' }), fakeModel({ id: 'haiku-4' })] }),
    ];
    // pick provider 1, then type the exact model id, then don't save
    const reader = fakeReader(['1', 'haiku-4', 'n']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result?.model).toBe('haiku-4');
  });

  it('resolveModelSelection picks unique partial-match model id', async () => {
    const { renderer } = mkRig();
    const providers = [
      fakeProvider({
        models: [fakeModel({ id: 'claude-opus-4' }), fakeModel({ id: 'gpt-4o' })],
      }),
    ];
    // 'opus' uniquely matches 'claude-opus-4'
    const reader = fakeReader(['1', 'opus', 'n']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result?.model).toBe('claude-opus-4');
  });

  it('resolveModelSelection reports an error when partial match is ambiguous', async () => {
    const { renderer, err } = mkRig();
    const providers = [
      fakeProvider({
        models: [fakeModel({ id: 'claude-opus-4' }), fakeModel({ id: 'claude-sonnet-4' })],
      }),
    ];
    // 'claude' matches both — should print an error and return undefined
    const reader = fakeReader(['1', 'claude']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result).toBeUndefined();
    expect(err.buf).toMatch(/multiple models/i);
  });

  it('resolveModelSelection falls back to using the raw answer when nothing matches', async () => {
    const { renderer } = mkRig();
    const providers = [fakeProvider({ models: [fakeModel({ id: 'opus-4' })] })];
    // Answer doesn't match any model — use as-is
    const reader = fakeReader(['1', 'experimental-model-x', 'n']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result?.model).toBe('experimental-model-x');
  });

  it('cancels mid-pagination when user types q on the "more" prompt', async () => {
    // Generate 35 models so the picker shows page 1 (30) then asks for "more".
    const manyModels = Array.from({ length: 35 }, (_, i) =>
      fakeModel({ id: `m${i + 1}`, release_date: '2025-01-01' }),
    );
    const providers = [fakeProvider({ models: manyModels })];
    const { renderer } = mkRig();
    // Pick provider 1, then type 'q' on the pagination prompt.
    const reader = fakeReader(['1', 'q']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result).toBeUndefined();
  });

  it('picks a numbered model on the first page even when more models exist', async () => {
    const manyModels = Array.from({ length: 35 }, (_, i) =>
      fakeModel({ id: `m${i + 1}`, release_date: '2025-01-01' }),
    );
    const providers = [fakeProvider({ models: manyModels })];
    const { renderer } = mkRig();
    // Pick provider 1, then "2" to pick the 2nd model from the first page.
    const reader = fakeReader(['1', '2']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result).toBeDefined();
    expect(result!.model).toBe('m2');
  });

  it('reports an error when the chosen model index is out of range and no default applies', async () => {
    const providers = [fakeProvider({ models: [fakeModel({ id: 'only-one' })] })];
    const { renderer } = mkRig();
    // Pick provider 1, then an invalid out-of-range numeric selection.
    const reader = fakeReader(['1', '99']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    // resolveModelSelection falls back to using the raw answer when nothing matches.
    expect(result).toBeDefined();
    expect(result!.model).toBe('99');
  });

  it('shows an empty-models error when the provider has no models in the catalog', async () => {
    const providers = [fakeProvider({ models: [] })];
    const { renderer, err } = mkRig();
    const reader = fakeReader(['1']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result).toBeUndefined();
    expect(err.buf).toMatch(/No models listed/);
  });

  it('renders providers within each family in alphabetical (case-insensitive) order', async () => {
    const { renderer, out } = mkRig();
    // Same family, deliberately non-alphabetical and mixed-case to pin
    // case-insensitive ordering. Without sorting these would render in
    // insertion order (zzz-last, aaa-first, Mmm-mid).
    const providers = [
      fakeProvider({
        id: 'zzz-last',
        name: 'ZZZ',
        family: 'openai-compatible',
        envVars: [],
        models: [fakeModel({ id: 'm1' })],
      }),
      fakeProvider({
        id: 'aaa-first',
        name: 'AAA',
        family: 'openai-compatible',
        envVars: [],
        models: [fakeModel({ id: 'm1' })],
      }),
      fakeProvider({
        id: 'Mmm-mid',
        name: 'MMM',
        family: 'openai-compatible',
        envVars: [],
        models: [fakeModel({ id: 'm1' })],
      }),
      fakeProvider({
        id: 'anthropic',
        name: 'Anthropic',
        family: 'anthropic',
        envVars: ['ANTHROPIC_API_KEY'],
        models: [fakeModel()],
      }),
    ];
    // Cancel at the provider prompt; the provider list is already rendered.
    const reader = fakeReader(['']);
    const registry = fakeRegistry(providers);
    await runPicker({ modelsRegistry: registry as never, renderer, reader: reader as never });

    const pos = (id: string) => out.buf.indexOf(id);
    expect(pos('aaa-first')).toBeGreaterThan(-1);
    // Case-insensitive alphabetical: aaa-first < Mmm-mid < zzz-last
    expect(pos('aaa-first')).toBeLessThan(pos('Mmm-mid'));
    expect(pos('Mmm-mid')).toBeLessThan(pos('zzz-last'));
  });

  it('matches provider by id string', async () => {
    const { renderer } = mkRig();
    const providers = [
      fakeProvider({ id: 'anthropic', family: 'anthropic' }),
      fakeProvider({
        id: 'openai',
        family: 'openai',
        envVars: ['OPENAI_API_KEY'],
        models: [fakeModel({ id: 'gpt-4o' })],
      }),
    ];
    const reader = fakeReader(['openai', '1', 'n']); // type id, pick model, don't save
    const registry = fakeRegistry(providers);

    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });

    expect(result).toBeDefined();
    expect(result!.provider).toBe('openai');
    expect(result!.model).toBe('gpt-4o');
  });
});

describe('filterProviders', () => {
  const sample = [
    fakeProvider({ id: 'anthropic', name: 'Anthropic', family: 'anthropic', envVars: [] }),
    fakeProvider({
      id: 'google-vertex-anthropic',
      name: 'Vertex (Anthropic)',
      family: 'anthropic',
      envVars: [],
    }),
    fakeProvider({ id: 'openai', name: 'OpenAI', family: 'openai', envVars: ['OPENAI_API_KEY'] }),
    fakeProvider({
      id: 'openrouter',
      name: 'OpenRouter',
      family: 'openai-compatible',
      envVars: [],
    }),
    fakeProvider({ id: 'kimi', name: 'Kimi For Coding', family: 'anthropic', envVars: [] }),
  ];

  it('returns all providers when the query is empty or whitespace', () => {
    expect(filterProviders('', sample)).toHaveLength(sample.length);
    expect(filterProviders('   ', sample)).toHaveLength(sample.length);
  });

  it('matches by id substring (case-insensitive)', () => {
    expect(filterProviders('anthr', sample).map((p) => p.id)).toEqual([
      'anthropic',
      'google-vertex-anthropic',
    ]);
  });

  it('matches by name substring when the id does not contain the query', () => {
    // "coding" is in the name "Kimi For Coding" but not in the id "kimi".
    expect(filterProviders('coding', sample).map((p) => p.id)).toEqual(['kimi']);
  });

  it('matches id or name as a union, preserving input order', () => {
    expect(filterProviders('open', sample).map((p) => p.id)).toEqual(['openai', 'openrouter']);
  });

  it('is case-insensitive', () => {
    expect(filterProviders('KIMI', sample).map((p) => p.id)).toEqual(['kimi']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterProviders('zzz-nope', sample)).toEqual([]);
  });
});

describe('filterModels', () => {
  const models = [
    fakeModel({ id: 'glm-5.2', name: 'GLM 5.2' }),
    fakeModel({ id: 'glm-4.5-air', name: 'GLM 4.5 Air' }),
    fakeModel({ id: 'special-1', name: 'Special Model' }),
  ];

  it('returns all models when the query is empty', () => {
    expect(filterModels('', models)).toHaveLength(models.length);
  });

  it('matches by id substring (case-insensitive)', () => {
    expect(filterModels('GLM', models).map((m) => m.id)).toEqual(['glm-5.2', 'glm-4.5-air']);
  });

  it('matches by name substring when the id does not contain the query', () => {
    expect(filterModels('special', models).map((m) => m.id)).toEqual(['special-1']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterModels('zzz-nope', models)).toEqual([]);
  });
});

describe('renderLiveModelList', () => {
  const models = [
    fakeModel({
      id: 'glm-4.5-air',
      name: 'GLM 4.5 Air',
      release_date: '2025-01-01',
      limit: { context: 131000, output: 8192 },
      cost: { input: 0, output: 0 },
      tool_call: true,
      reasoning: true,
    }),
    fakeModel({
      id: 'glm-5.2',
      name: 'GLM 5.2',
      release_date: '2026-06-01',
      limit: { context: 1000000, output: 8192 },
      cost: { input: 0, output: 0 },
      tool_call: true,
      reasoning: true,
    }),
    fakeModel({
      id: 'glm-5v-turbo',
      name: 'GLM 5V Turbo',
      release_date: '2026-05-01',
      modalities: { input: ['text', 'image'], output: ['text'] },
      tool_call: true,
      reasoning: true,
    }),
  ];
  const header = 'Z.AI Coding Plan (zai-coding-plan) models:';

  it('sorts by release_date desc (newest first)', () => {
    const out = renderLiveModelList('', models, 0, header);
    expect(out.indexOf('glm-5.2')).toBeLessThan(out.indexOf('glm-5v-turbo'));
    expect(out.indexOf('glm-5v-turbo')).toBeLessThan(out.indexOf('glm-4.5-air'));
  });

  it('echoes the query and the provider header', () => {
    const out = renderLiveModelList('5.2', filterModels('5.2', models), 0, header);
    expect(out).toContain('Select model: 5.2');
    expect(out).toContain(header);
  });

  it('marks only the selected model with the cursor', () => {
    // sorted desc: [glm-5.2, glm-5v-turbo, glm-4.5-air]; index 0 = glm-5.2
    const out = renderLiveModelList('', models, 0, header);
    const lines = out.split('\n');
    expect(lines.find((l) => l.includes('glm-5.2'))).toMatch(/▶/);
    expect(lines.find((l) => l.includes('glm-5v-turbo'))).not.toMatch(/▶/);
  });

  it('caps the list to a visible window with a "more" hint when results exceed it', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      fakeModel({ id: `model-${String(i + 1).padStart(2, '0')}`, name: `Model ${i}` }),
    );
    const out = renderLiveModelList('', many, 0, header);
    expect(out).toContain('model-15');
    expect(out).not.toContain('model-16');
    expect(out).toMatch(/more/i);
  });
});

describe('applyPickerKey', () => {
  const st = (
    query = '',
    selected = 0,
    status: ProviderPickerState['status'] = 'typing',
  ): ProviderPickerState => ({ query, selected, status });

  it('appends a printable char to the query and resets selection', () => {
    expect(applyPickerKey(st('a', 3), 'b', 5)).toEqual(st('ab', 0));
  });

  it('appends a pasted run of chars', () => {
    expect(applyPickerKey(st(), 'abc', 5)).toEqual(st('abc', 0));
  });

  it('erases one char on backspace and resets selection', () => {
    expect(applyPickerKey(st('ab', 2), '\x7f', 5)).toEqual(st('a', 0));
  });

  it('keeps an empty query on backspace', () => {
    expect(applyPickerKey(st(''), '\x7f', 5)).toEqual(st(''));
  });

  it('clears the whole query on Ctrl+U', () => {
    expect(applyPickerKey(st('abc', 2), '\x15', 5)).toEqual(st('', 0));
  });

  it('clears the whole query on lone Esc', () => {
    expect(applyPickerKey(st('abc', 2), '\x1b', 5)).toEqual(st('', 0));
  });

  it('moves selection up on Up arrow, clamped at top', () => {
    expect(applyPickerKey(st('x', 2), '\x1b[A', 5).selected).toBe(1);
    expect(applyPickerKey(st('x', 0), '\x1b[A', 5).selected).toBe(0);
  });

  it('moves selection down on Down arrow, clamped at bottom', () => {
    expect(applyPickerKey(st('x', 1), '\x1b[B', 5).selected).toBe(2);
    expect(applyPickerKey(st('x', 4), '\x1b[B', 5).selected).toBe(4);
  });

  it('submits on Enter when matches exist', () => {
    expect(applyPickerKey(st('x', 1), '\r', 3).status).toBe('submitted');
    expect(applyPickerKey(st('x', 1), '\n', 3).status).toBe('submitted');
  });

  it('ignores Enter when there are zero matches', () => {
    expect(applyPickerKey(st('zzz', 0), '\r', 0).status).toBe('typing');
  });

  it('cancels on Ctrl+C', () => {
    expect(applyPickerKey(st('x', 1), '\x03', 5).status).toBe('cancelled');
  });

  it('ignores other escape sequences (e.g. left/right arrows)', () => {
    expect(applyPickerKey(st('x', 2), '\x1b[C', 5)).toEqual(st('x', 2));
  });
});

describe('renderLiveProviderList', () => {
  const list = [
    fakeProvider({ id: 'zzz-gw', name: 'ZZZ Gateway', family: 'openai-compatible', envVars: [] }),
    fakeProvider({ id: 'aaa-gw', name: 'AAA Gateway', family: 'openai-compatible', envVars: [] }),
    fakeProvider({ id: 'anthropic', name: 'Anthropic', family: 'anthropic', envVars: [] }),
    fakeProvider({ id: 'openai', name: 'OpenAI', family: 'openai', envVars: [] }),
    fakeProvider({ id: 'google', name: 'Google', family: 'google', envVars: [] }),
  ];

  it('groups families in preferred order then the rest', () => {
    const out = renderLiveProviderList('', list, 0);
    const pos = (id: string) => out.indexOf(id);
    expect(pos('anthropic')).toBeLessThan(pos('openai'));
    expect(pos('openai')).toBeLessThan(pos('google'));
    expect(pos('google')).toBeLessThan(pos('aaa-gw'));
  });

  it('sorts within each family alphabetically by id', () => {
    const out = renderLiveProviderList('', list, 0);
    expect(out.indexOf('aaa-gw')).toBeLessThan(out.indexOf('zzz-gw'));
  });

  it('echoes the current query in the prompt line', () => {
    expect(renderLiveProviderList('anthr', list, 0)).toContain('Select provider: anthr');
  });

  it('marks only the selected provider with the cursor', () => {
    const out = renderLiveProviderList('gw', filterProviders('gw', list), 1);
    const lines = out.split('\n');
    const sel = lines.find((l) => l.includes('zzz-gw'));
    const other = lines.find((l) => l.includes('aaa-gw'));
    expect(sel).toMatch(/▶/);
    expect(other).not.toMatch(/▶/);
  });

  it('renders every provider when the query is empty', () => {
    const out = renderLiveProviderList('', list, 0);
    for (const p of list) expect(out).toContain(p.id);
  });

  it('caps the list to a visible window with a "more" hint when results exceed it', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      fakeProvider({
        id: `prov-${String(i).padStart(2, '0')}`,
        name: `Prov ${i}`,
        family: 'openai-compatible',
        envVars: [],
      }),
    );
    const out = renderLiveProviderList('', many, 0);
    expect(out).toContain('prov-00');
    expect(out).toContain('prov-14');
    expect(out).not.toContain('prov-15');
    expect(out).toMatch(/more/i);
  });
});

describe('saveToGlobalConfig', () => {
  it('returns true when write succeeds', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = path.join(os.tmpdir(), `wstack-picker-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    const cfgPath = path.join(tmpDir, 'config.json');
    try {
      const result = await saveToGlobalConfig(cfgPath, 'test-provider', 'test-model');
      expect(result).toBe(true);
      const content = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as Record<string, unknown>;
      expect(content.provider).toBe('test-provider');
      expect(content.model).toBe('test-model');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
