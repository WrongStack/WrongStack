import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DefaultSecretScrubber,
  DefaultSecretVault,
  type Config,
  type ModelsRegistry,
} from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelsCmd } from '../src/subcommands/handlers/providers-models.js';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';

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
  return { renderer, messages };
}

function makeDeps(cfg: Config, configPath: string, renderer: TerminalRenderer) {
  const modelsRegistry: ModelsRegistry = {
    listProviders: vi.fn(async () => []),
    refresh: vi.fn(async () => ({})),
    suggestModel: vi.fn(async () => undefined),
    getProvider: vi.fn(async (id: string) => {
      if (id !== 'anthropic') return undefined;
      return {
        id: 'anthropic',
        name: 'Anthropic',
        family: 'anthropic',
        envVars: ['ANTHROPIC_API_KEY'],
        models: [
          { id: 'anthropic-test-model', name: 'Anthropic Test Model' },
          { id: 'claude-opus-4', name: 'Claude Opus 4' },
          { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
        ],
      };
    }),
    getModel: vi.fn(async () => undefined),
    ageSeconds: vi.fn(async () => 0),
  } as never as ModelsRegistry;

  return {
    config: cfg,
    renderer,
    reader: {} as never as ReadlineInputReader,
    sessionStore: undefined,
    skillLoader: undefined,
    toolRegistry: undefined,
    modelsRegistry,
    paths: {
      globalConfig: configPath,
      modelsCache: path.join(path.dirname(configPath), 'models.dev.json'),
    },
    vault: new DefaultSecretVault({ keyFile: path.join(path.dirname(configPath), '.key') }),
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    userHome: os.homedir(),
    flags: {},
    scrubber: new DefaultSecretScrubber(),
  };
}

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-model-vis-'));
  configPath = path.join(tmpDir, 'config.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(cfg: Config) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

function readConfig(): Config {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Config;
}

describe('models visibility commands', () => {
  it('hide initializes the visible list from catalog and removes the target model', async () => {
    const cfg = {
      version: 1,
      provider: 'anthropic',
      model: 'anthropic-test-model',
      context: { warnThreshold: 0.7, softThreshold: 0.8, hardThreshold: 0.9, preserveK: 4, eliseThreshold: 0.95 },
      tools: {},
      log: { level: 'info' },
      features: { developerMode: false, mcp: true, plugins: true, memory: true, skills: true, modelsRegistry: true, tokenSavingMode: 'off', allowOutsideProjectRoot: false },
      providers: { anthropic: { type: 'anthropic', apiKeys: [{ label: 'default', apiKey: 'enc:x', createdAt: '' }], activeKey: 'default' } },
    } as never as Config;
    writeConfig(cfg);
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(cfg, configPath, renderer);

    const code = await modelsCmd(['hide', 'anthropic', 'claude-opus-4'], deps as never);

    expect(code).toBe(0);
    expect(readConfig().providers?.anthropic?.models).toEqual([
      'anthropic-test-model',
      'claude-haiku-4.5',
    ]);
    expect(messages.join('\n')).toContain('Hidden anthropic/claude-opus-4');
  });

  it('show restores a hidden model into the visible list', async () => {
    const cfg = {
      version: 1,
      provider: 'anthropic',
      model: 'anthropic-test-model',
      context: { warnThreshold: 0.7, softThreshold: 0.8, hardThreshold: 0.9, preserveK: 4, eliseThreshold: 0.95 },
      tools: {},
      log: { level: 'info' },
      features: { developerMode: false, mcp: true, plugins: true, memory: true, skills: true, modelsRegistry: true, tokenSavingMode: 'off', allowOutsideProjectRoot: false },
      providers: { anthropic: { type: 'anthropic', models: ['anthropic-test-model'], apiKeys: [{ label: 'default', apiKey: 'enc:x', createdAt: '' }], activeKey: 'default' } },
    } as never as Config;
    writeConfig(cfg);
    const { renderer } = makeRenderer();
    const deps = makeDeps(cfg, configPath, renderer);

    const code = await modelsCmd(['show', 'anthropic', 'claude-opus-4'], deps as never);

    expect(code).toBe(0);
    expect(readConfig().providers?.anthropic?.models).toEqual([
      'anthropic-test-model',
      'claude-opus-4',
    ]);
  });

  it('hidden lists catalog models excluded by the visible allowlist', async () => {
    const cfg = {
      version: 1,
      provider: 'anthropic',
      model: 'anthropic-test-model',
      context: { warnThreshold: 0.7, softThreshold: 0.8, hardThreshold: 0.9, preserveK: 4, eliseThreshold: 0.95 },
      tools: {},
      log: { level: 'info' },
      features: { developerMode: false, mcp: true, plugins: true, memory: true, skills: true, modelsRegistry: true, tokenSavingMode: 'off', allowOutsideProjectRoot: false },
      providers: { anthropic: { type: 'anthropic', models: ['anthropic-test-model'], apiKeys: [{ label: 'default', apiKey: 'enc:x', createdAt: '' }], activeKey: 'default' } },
    } as never as Config;
    writeConfig(cfg);
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(cfg, configPath, renderer);

    const code = await modelsCmd(['hidden', 'anthropic'], deps as never);

    expect(code).toBe(0);
    const text = messages.join('\n');
    expect(text).toContain('claude-opus-4');
    expect(text).toContain('claude-haiku-4.5');
  });

  it('reset removes the visible allowlist and restores catalog default listing', async () => {
    const cfg = {
      version: 1,
      provider: 'anthropic',
      model: 'anthropic-test-model',
      context: { warnThreshold: 0.7, softThreshold: 0.8, hardThreshold: 0.9, preserveK: 4, eliseThreshold: 0.95 },
      tools: {},
      log: { level: 'info' },
      features: { developerMode: false, mcp: true, plugins: true, memory: true, skills: true, modelsRegistry: true, tokenSavingMode: 'off', allowOutsideProjectRoot: false },
      providers: { anthropic: { type: 'anthropic', models: ['anthropic-test-model'], apiKeys: [{ label: 'default', apiKey: 'enc:x', createdAt: '' }], activeKey: 'default' } },
    } as never as Config;
    writeConfig(cfg);
    const { renderer } = makeRenderer();
    const deps = makeDeps(cfg, configPath, renderer);

    const code = await modelsCmd(['reset', 'anthropic'], deps as never);

    expect(code).toBe(0);
    expect(readConfig().providers?.anthropic?.models).toBeUndefined();
  });
});
