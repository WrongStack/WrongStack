/**
 * `wstack models <provider>` for providers whose model list lives on the wire
 * rather than in models.dev.
 *
 * The REPL learns those models because boot runs auto-discovery; subcommands
 * have no boot, so a catalog miss used to end the command with "not in
 * catalog" even though the provider served hundreds of models. The handler now
 * runs the same discovery pass — but only AFTER a miss, and only when the
 * registry actually supports an overlay.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretScrubber, DefaultSecretVault } from '@wrongstack/core/security';
import type { Config, ModelsDevProvider, ModelsRegistry } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';
import { modelsCmd } from '../src/subcommands/handlers/providers-models.js';

const discoverAndMergeProviders = vi.fn();
vi.mock('../src/boot/auto-discover-providers.js', () => ({
  discoverAndMergeProviders: (...args: unknown[]) => discoverAndMergeProviders(...args),
}));

const GATEWAY_MODELS = [
  { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
  { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B' },
];

function makeRenderer() {
  const messages: string[] = [];
  const push = (value: unknown) => {
    messages.push(String(value));
  };
  const renderer = {
    write: vi.fn(push),
    writeLine: vi.fn(push),
    writeBlock: vi.fn(push),
    writeToolCall: vi.fn(),
    writeToolResult: vi.fn(),
    writeDiff: vi.fn(),
    writeWarning: vi.fn(push),
    writeError: vi.fn(push),
    writeInfo: vi.fn(push),
    clear: vi.fn(),
    render: vi.fn(),
  } as never as TerminalRenderer;
  return { renderer, text: () => messages.join('\n') };
}

/**
 * @param discovered ids the registry starts answering for once discovery has
 *   run; before that every lookup misses, as models.dev does for `ai-gateway`.
 * @param withOverlay whether the registry advertises `mergeOverlay` at all.
 */
function makeRegistry(discovered: string[], withOverlay = true) {
  let merged = false;
  discoverAndMergeProviders.mockImplementation(async () => {
    merged = true;
  });
  const getProvider = vi.fn(async (id: string) => {
    if (!merged || !discovered.includes(id)) return undefined;
    return {
      id,
      name: id,
      family: 'openai-compatible',
      envVars: [],
      models: GATEWAY_MODELS,
    };
  });
  const registry = {
    listProviders: vi.fn(async () => []),
    refresh: vi.fn(async () => ({})),
    suggestModel: vi.fn(async () => undefined),
    getProvider,
    getModel: vi.fn(async () => undefined),
    ageSeconds: vi.fn(async () => 0),
    ...(withOverlay
      ? { mergeOverlay: vi.fn((_: Record<string, ModelsDevProvider>) => undefined) }
      : {}),
  } as never as ModelsRegistry;
  return { registry, getProvider };
}

function makeDeps(cfg: Config, configPath: string, registry: ModelsRegistry) {
  const { renderer, text } = makeRenderer();
  const dir = path.dirname(configPath);
  return {
    text,
    deps: {
      config: cfg,
      renderer,
      reader: {} as never as ReadlineInputReader,
      sessionStore: undefined,
      skillLoader: undefined,
      toolRegistry: undefined,
      modelsRegistry: registry,
      paths: {
        globalConfig: configPath,
        profileConfig: () => configPath,
        cacheDir: dir,
        modelsCache: path.join(dir, 'models.dev.json'),
      },
      vault: new DefaultSecretVault({ keyFile: path.join(dir, '.key') }),
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      userHome: os.homedir(),
      flags: {},
      scrubber: new DefaultSecretScrubber(),
    },
  };
}

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-discovery-'));
  configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, '{}', 'utf8');
  discoverAndMergeProviders.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('wstack models — wire-discovered providers', () => {
  it('discovers models when the catalog misses, and lists them', async () => {
    const { registry } = makeRegistry(['ai-gateway']);
    const { deps, text } = makeDeps(
      { providers: { 'ai-gateway': { type: 'ai-gateway' } } } as never as Config,
      configPath,
      registry,
    );

    await expect(modelsCmd(['ai-gateway'], deps as never)).resolves.toBe(0);

    expect(discoverAndMergeProviders).toHaveBeenCalledTimes(1);
    expect(text()).toContain('anthropic/claude-haiku-4.5');
    expect(text()).not.toContain('not in catalog');
  });

  it('resolves an alias whose overlay is keyed on the config id, not the type', async () => {
    // Discovery merges under the CONFIG key, so a `gateway-work` entry of type
    // `ai-gateway` lands under `gateway-work` — not the aliased lookup id.
    const { registry } = makeRegistry(['gateway-work']);
    const { deps, text } = makeDeps(
      { providers: { 'gateway-work': { type: 'ai-gateway' } } } as never as Config,
      configPath,
      registry,
    );

    await expect(modelsCmd(['gateway-work'], deps as never)).resolves.toBe(0);
    expect(text()).toContain('openai/gpt-oss-20b');
  });

  it('does not run discovery when the catalog already answers', async () => {
    const { registry } = makeRegistry(['ai-gateway']);
    discoverAndMergeProviders.mockImplementation(async () => undefined);
    (registry.getProvider as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => ({
      id,
      name: id,
      family: 'openai-compatible',
      envVars: [],
      models: GATEWAY_MODELS,
    }));
    const { deps } = makeDeps(
      { providers: { 'ai-gateway': { type: 'ai-gateway' } } } as never as Config,
      configPath,
      registry,
    );

    await expect(modelsCmd(['ai-gateway'], deps as never)).resolves.toBe(0);
    expect(discoverAndMergeProviders).not.toHaveBeenCalled();
  });

  it('skips discovery entirely for a registry with no overlay support', async () => {
    const { registry } = makeRegistry(['ai-gateway'], false);
    const { deps, text } = makeDeps(
      { providers: { 'ai-gateway': { type: 'ai-gateway' } } } as never as Config,
      configPath,
      registry,
    );

    await expect(modelsCmd(['ai-gateway'], deps as never)).resolves.toBe(1);
    expect(discoverAndMergeProviders).not.toHaveBeenCalled();
    expect(text()).toContain('not in catalog');
  });

  it('applies --search from the top-level parse, which strips it out of args', async () => {
    // `wstack models ai-gateway --search haiku` reaches the handler as
    // args=['ai-gateway'] with the flag parked on deps.flags. Reading only args
    // meant a 208-model listing ignored every filter and paging flag.
    const { registry } = makeRegistry(['ai-gateway']);
    const { deps, text } = makeDeps(
      { providers: { 'ai-gateway': { type: 'ai-gateway' } } } as never as Config,
      configPath,
      registry,
    );
    deps.flags = { search: 'haiku' };

    await expect(modelsCmd(['ai-gateway'], deps as never)).resolves.toBe(0);

    expect(text()).toContain('anthropic/claude-haiku-4.5');
    expect(text()).not.toContain('openai/gpt-oss-20b');
  });

  it('lets an explicitly parsed arg override the top-level flag', async () => {
    const { registry } = makeRegistry(['ai-gateway']);
    const { deps, text } = makeDeps(
      { providers: { 'ai-gateway': { type: 'ai-gateway' } } } as never as Config,
      configPath,
      registry,
    );
    deps.flags = { search: 'haiku' };

    await expect(modelsCmd(['ai-gateway', '--search=gpt-oss'], deps as never)).resolves.toBe(0);

    expect(text()).toContain('openai/gpt-oss-20b');
    expect(text()).not.toContain('anthropic/claude-haiku-4.5');
  });

  it('reports a plain catalog miss when discovery itself fails', async () => {
    // A down gateway must degrade to the ordinary error, never a stack trace.
    const { registry } = makeRegistry(['ai-gateway']);
    discoverAndMergeProviders.mockRejectedValue(new Error('gateway unreachable'));
    const { deps, text } = makeDeps(
      { providers: { 'ai-gateway': { type: 'ai-gateway' } } } as never as Config,
      configPath,
      registry,
    );

    await expect(modelsCmd(['ai-gateway'], deps as never)).resolves.toBe(1);
    expect(text()).toContain('not in catalog');
  });
});
