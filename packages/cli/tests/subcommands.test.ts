import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import {
  type Config,
  DefaultSessionStore,
  type ModelsRegistry,
  type ResolvedModel,
  type ResolvedProvider,
  ToolRegistry,
  resolveWstackPaths,
} from '@wrongstack/core';
import { stripAnsi } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalRenderer } from '../src/renderer.js';
import { type SubcommandDeps, subcommands } from '../src/subcommands/index.js';

class CapStream extends Writable {
  buf = '';
  _write(c: Buffer | string, _e: BufferEncoding, cb: (err?: Error | null) => void): void {
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

function fakeProvider(over: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    family: 'anthropic',
    npm: '@ai-sdk/anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    doc: 'https://docs.anthropic.com',
    models: [
      {
        id: 'anthropic-test-model',
        name: 'Anthropic Test Model',
        tool_call: true,
        reasoning: false,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 200_000, output: 8000 },
        cost: { input: 3, output: 15 },
        release_date: '2026-01-01',
      } as ResolvedModel,
    ],
    ...over,
  };
}

function fakeRegistry(providers: ResolvedProvider[]): ModelsRegistry {
  return {
    load: async () => ({}) as never,
    refresh: async () => ({}) as never,
    listProviders: async () => providers,
    getProvider: async (id: string) => providers.find((p) => p.id === id),
    getModel: async (pid: string, mid: string) =>
      providers.find((p) => p.id === pid)?.models.find((m) => m.id === mid),
    suggestModel: async (pid: string) => providers.find((p) => p.id === pid)?.models[0]?.id,
    ageSeconds: async () => 60,
  } as ModelsRegistry;
}

function mkDeps(over: Partial<SubcommandDeps> = {}): SubcommandDeps {
  const rig = mkRig();
  return {
    config: { providers: {}, log: { level: 'error' } } as never as Config,
    renderer: rig.renderer,
    reader: {
      readLine: vi.fn(async () => ''),
      readKey: vi.fn(async () => ''),
      close: vi.fn(async () => undefined),
    } as never,
    modelsRegistry: fakeRegistry([fakeProvider()]),
    paths: resolveWstackPaths({
      projectRoot: process.cwd(),
      globalRoot: '/tmp/g',
      userHome: '/tmp',
    }),
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    userHome: '/tmp',
    ...over,
  };
}

function getOut(deps: SubcommandDeps): string {
  // Renderer was injected from mkRig, but TerminalRenderer doesn't expose the stream.
  // We need to keep ref. So we change strategy: build rig manually.
  return stripAnsi((deps.renderer as never as { out: CapStream }).out?.buf ?? '');
}

function withRig() {
  const out = new CapStream();
  const err = new CapStream();
  const renderer = new TerminalRenderer({
    out: out as never as NodeJS.WriteStream,
    err: err as never as NodeJS.WriteStream,
  });
  return { out, err, renderer };
}

describe('subcommands', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sub-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('version prints version line', async () => {
    const rig = withRig();
    const code = await subcommands['version']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toMatch(/WrongStack \d+\.\d+\.\d+/);
  });

  it('help lists subcommands', async () => {
    const rig = withRig();
    const code = await subcommands['help']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('wstack');
    expect(text).toContain('resume');
    // `init` is deprecated and hidden from help; `auth` is its replacement.
    expect(text).toContain('auth');
  });

  it('init is a deprecated stub that points to `wstack auth`', async () => {
    const rig = withRig();
    const code = await subcommands['init']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toMatch(/deprecated/i);
    expect(text).toContain('wstack auth');
  });

  it('config show prints redacted config', async () => {
    const rig = withRig();
    const config = {
      providers: {},
      apiKey: 'sk-secret',
      log: { level: 'error' },
    } as never as Config;
    await subcommands['config']!(['show'], mkDeps({ renderer: rig.renderer, config }));
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-secret');
  });

  it('config edit shows hint', async () => {
    const rig = withRig();
    const code = await subcommands['config']!(['edit'], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('Run:');
  });

  it('config rejects unknown subcommand', async () => {
    const rig = withRig();
    const code = await subcommands['config']!(['wat'], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('Unknown');
  });

  it('tools lists registered tools', async () => {
    const rig = withRig();
    const reg = new ToolRegistry();
    reg.register(
      {
        name: 'echo',
        description: '',
        inputSchema: { type: 'object' },
        permission: 'auto',
        mutating: false,
        async execute() {
          return '';
        },
      },
      'core',
    );
    const code = await subcommands['tools']!(
      [],
      mkDeps({ renderer: rig.renderer, toolRegistry: reg }),
    );
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('echo');
    expect(stripAnsi(rig.out.buf)).toContain('[core]');
  });

  it('providers groups by wire family', async () => {
    const rig = withRig();
    const reg = fakeRegistry([
      fakeProvider({ id: 'anthropic', family: 'anthropic', name: 'Anthropic' }),
      fakeProvider({ id: 'openai', family: 'openai', name: 'OpenAI', envVars: ['OPENAI_API_KEY'] }),
      fakeProvider({ id: 'gemini', family: 'google', name: 'Gemini', envVars: ['GEMINI_API_KEY'] }),
    ]);
    const code = await subcommands['providers']!(
      [],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('anthropic');
    expect(text).toContain('openai');
    expect(text).toContain('google');
  });

  it('models <provider> lists models sorted by release_date desc', async () => {
    const rig = withRig();
    const provider = fakeProvider({
      models: [
        {
          id: 'old',
          release_date: '2024-01-01',
          tool_call: false,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 1000, output: 100 },
        } as ResolvedModel,
        {
          id: 'new',
          release_date: '2026-01-01',
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 200_000, output: 8000 },
        } as ResolvedModel,
      ],
    });
    const reg = fakeRegistry([provider]);
    const code = await subcommands['models']!(
      ['anthropic'],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    const newIdx = text.indexOf('new');
    const oldIdx = text.indexOf('old');
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('models refresh delegates to registry.refresh', async () => {
    const rig = withRig();
    const refresh = vi.fn().mockResolvedValue({ anthropic: {} });
    const reg = { ...fakeRegistry([]), refresh } as never as ModelsRegistry;
    const code = await subcommands['models']!(
      ['refresh'],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(0);
    expect(refresh).toHaveBeenCalled();
  });

  it('models with unknown provider errors out', async () => {
    const rig = withRig();
    const code = await subcommands['models']!(
      ['no-such-provider'],
      mkDeps({ renderer: rig.renderer }),
    );
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('not in catalog');
  });

  it('mcp list says none configured by default', async () => {
    const rig = withRig();
    const code = await subcommands['mcp']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('No MCP servers');
  });

  it('plugin list says none configured by default', async () => {
    const rig = withRig();
    const code = await subcommands['plugin']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('No plugins');
  });

  it('diag prints diagnostics', async () => {
    const rig = withRig();
    const code = await subcommands['diag']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('apiVersion');
    expect(text).toContain('projectRoot');
    expect(text).toContain('cacheAge');
  });

  it('doctor returns 0 when minimum config is healthy', async () => {
    const rig = withRig();
    const paths = resolveWstackPaths({
      projectRoot: tmp,
      globalRoot: path.join(tmp, 'g'),
      userHome: tmp,
    });
    const config = {
      provider: 'anthropic',
      model: 'anthropic-test-model',
      providers: { anthropic: { envVars: ['ANTHROPIC_API_KEY'] } },
      log: { level: 'error' },
    } as never as Config;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const code = await subcommands['doctor']!(
        [],
        mkDeps({ renderer: rig.renderer, config, paths }),
      );
      expect(code).toBe(0);
      const text = stripAnsi(rig.out.buf);
      expect(text).toContain('WrongStack doctor');
      expect(text).toContain('provider');
      expect(text).toContain('anthropic');
      expect(text).toContain('api key');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('doctor returns 1 when no provider/model configured', async () => {
    const rig = withRig();
    const paths = resolveWstackPaths({
      projectRoot: tmp,
      globalRoot: path.join(tmp, 'g'),
      userHome: tmp,
    });
    const config = { providers: {}, log: { level: 'error' } } as never as Config;
    const code = await subcommands['doctor']!(
      [],
      mkDeps({ renderer: rig.renderer, config, paths }),
    );
    expect(code).toBe(1);
    const text = stripAnsi(rig.out.buf);
    expect(text).toMatch(/no provider configured/);
    expect(text).toMatch(/no model configured/);
    expect(text).toContain('failed');
  });

  it('doctor warns on stale models cache', async () => {
    const rig = withRig();
    const paths = resolveWstackPaths({
      projectRoot: tmp,
      globalRoot: path.join(tmp, 'g'),
      userHome: tmp,
    });
    const config = {
      provider: 'anthropic',
      model: 'anthropic-test-model',
      providers: { anthropic: { envVars: ['ANTHROPIC_API_KEY'] } },
      log: { level: 'error' },
    } as never as Config;
    const reg: ModelsRegistry = {
      ...fakeRegistry([fakeProvider()]),
      ageSeconds: async () => 30 * 24 * 3600,
    } as ModelsRegistry;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const code = await subcommands['doctor']!(
        [],
        mkDeps({ renderer: rig.renderer, config, paths, modelsRegistry: reg }),
      );
      expect(code).toBe(0);
      const text = stripAnsi(rig.out.buf);
      expect(text).toMatch(/30 days old/);
      expect(text).toContain('warning');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('doctor flags MCP server with stdio transport but no command', async () => {
    const rig = withRig();
    const paths = resolveWstackPaths({
      projectRoot: tmp,
      globalRoot: path.join(tmp, 'g'),
      userHome: tmp,
    });
    const config = {
      provider: 'anthropic',
      model: 'anthropic-test-model',
      providers: { anthropic: { envVars: ['ANTHROPIC_API_KEY'] } },
      log: { level: 'error' },
      mcpServers: {
        broken: { name: 'broken', enabled: true, transport: 'stdio' },
      },
    } as never as Config;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const code = await subcommands['doctor']!(
        [],
        mkDeps({ renderer: rig.renderer, config, paths }),
      );
      expect(code).toBe(1);
      const text = stripAnsi(rig.out.buf);
      expect(text).toContain('mcp:broken');
      expect(text).toMatch(/stdio transport requires command/);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('export <id> writes markdown to stdout by default', async () => {
    const rig = withRig();
    const sessionsDir = path.join(tmp, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    const id = 'sess-1';
    const events = [
      { type: 'session_start', ts: '2026-05-14T10:00:00.000Z', id, model: 'm', provider: 'p' },
      { type: 'user_input', ts: '2026-05-14T10:00:01.000Z', content: 'hello world' },
      {
        type: 'llm_response',
        ts: '2026-05-14T10:00:02.000Z',
        content: [{ type: 'text', text: 'hi there' }],
        stopReason: 'end_turn',
        usage: { input: 10, output: 5 },
      },
      {
        type: 'session_end',
        ts: '2026-05-14T10:00:03.000Z',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    await fs.writeFile(
      path.join(sessionsDir, `${id}.jsonl`),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    const sessionStore = new DefaultSessionStore({ dir: sessionsDir });
    const code = await subcommands['export']!(
      [id],
      mkDeps({ renderer: rig.renderer, sessionStore }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('hello world');
    expect(text).toContain('hi there');
  });

  it('export <id> --format json emits JSONL', async () => {
    const rig = withRig();
    const sessionsDir = path.join(tmp, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    const id = 'sess-json';
    const events = [
      { type: 'session_start', ts: '2026-05-14T10:00:00.000Z', id, model: 'm', provider: 'p' },
      { type: 'user_input', ts: '2026-05-14T10:00:01.000Z', content: 'q' },
    ];
    await fs.writeFile(
      path.join(sessionsDir, `${id}.jsonl`),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    const sessionStore = new DefaultSessionStore({ dir: sessionsDir });
    const code = await subcommands['export']!(
      [id, '--format', 'json'],
      mkDeps({ renderer: rig.renderer, sessionStore }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    // Format is pretty JSON — keys may have spaces.
    expect(text).toMatch(/"type"\s*:\s*"session_start"/);
    expect(text).toMatch(/"type"\s*:\s*"user_input"/);
  });

  it('export <id> --out writes to file', async () => {
    const rig = withRig();
    const sessionsDir = path.join(tmp, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    const id = 'sess-out';
    const events = [
      { type: 'session_start', ts: '2026-05-14T10:00:00.000Z', id, model: 'm', provider: 'p' },
      { type: 'user_input', ts: '2026-05-14T10:00:01.000Z', content: 'hello' },
    ];
    await fs.writeFile(
      path.join(sessionsDir, `${id}.jsonl`),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    const sessionStore = new DefaultSessionStore({ dir: sessionsDir });
    const outFile = path.join(tmp, 'export.md');
    const code = await subcommands['export']!(
      [id, '--out', outFile],
      mkDeps({ renderer: rig.renderer, sessionStore, cwd: tmp }),
    );
    expect(code).toBe(0);
    const written = await fs.readFile(outFile, 'utf8');
    expect(written).toContain('hello');
    expect(stripAnsi(rig.out.buf)).toMatch(/Wrote \d+ bytes/);
  });

  it('export without id prints usage and exits 1', async () => {
    const rig = withRig();
    const sessionStore = new DefaultSessionStore({ dir: tmp });
    const code = await subcommands['export']!([], mkDeps({ renderer: rig.renderer, sessionStore }));
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toMatch(/Usage:/);
  });

  it('export rejects unknown flags', async () => {
    const rig = withRig();
    const sessionStore = new DefaultSessionStore({ dir: tmp });
    const code = await subcommands['export']!(
      ['abc', '--frobnicate'],
      mkDeps({ renderer: rig.renderer, sessionStore }),
    );
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('--frobnicate');
  });

  it('projects reports empty when no projects dir', async () => {
    const rig = withRig();
    const paths = resolveWstackPaths({
      projectRoot: process.cwd(),
      globalRoot: path.join(tmp, 'definitely-empty'),
      userHome: tmp,
    });
    const code = await subcommands['projects']!([], mkDeps({ renderer: rig.renderer, paths }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('No projects');
  });

  it('projects lists entries with meta.json', async () => {
    const rig = withRig();
    const globalRoot = path.join(tmp, 'g');
    const projectsRoot = path.join(globalRoot, 'projects');
    await fs.mkdir(path.join(projectsRoot, 'abc123'), { recursive: true });
    await fs.writeFile(
      path.join(projectsRoot, 'abc123', 'meta.json'),
      JSON.stringify({ root: '/some/path', lastSeen: '2026-05-13T00:00:00Z' }),
    );
    await fs.mkdir(path.join(projectsRoot, 'def456'), { recursive: true });
    const paths = resolveWstackPaths({
      projectRoot: process.cwd(),
      globalRoot,
      userHome: tmp,
    });
    const code = await subcommands['projects']!([], mkDeps({ renderer: rig.renderer, paths }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('abc123');
    expect(text).toContain('/some/path');
    expect(text).toContain('def456');
    expect(text).toContain('(no meta)');
  });

  it('mcp lists configured servers', async () => {
    const rig = withRig();
    const config = {
      providers: {},
      log: { level: 'error' },
      mcpServers: {
        primary: { name: 'primary', transport: 'stdio', command: 'noop' },
        disabled: { name: 'disabled', transport: 'stdio', enabled: false },
      },
    } as never as Config;
    const code = await subcommands['mcp']!([], mkDeps({ renderer: rig.renderer, config }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('primary');
    expect(text).toContain('disabled');
  });

  it('mcp add lists built-in vision presets', async () => {
    const rig = withRig();
    const code = await subcommands['mcp']!(['add'], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(1);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('zai-vision');
    expect(text).toContain('minimax-vision');
  });

  it('mcp add minimax-vision writes an enabled read-only preset', async () => {
    const rig = withRig();
    const paths = resolveWstackPaths({
      projectRoot: tmp,
      globalRoot: path.join(tmp, 'g'),
      userHome: tmp,
    });
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ version: 1 }, null, 2));

    const code = await subcommands['mcp']!(
      ['add', 'minimax-vision', '--enable'],
      mkDeps({ renderer: rig.renderer, paths }),
    );

    expect(code).toBe(0);
    const written = JSON.parse(await fs.readFile(paths.globalConfig, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(written.mcpServers['minimax-vision']).toMatchObject({
      name: 'minimax-vision',
      transport: 'stdio',
      command: 'uvx',
      allowedTools: ['understand_image'],
      permission: 'auto',
      enabled: true,
    });
  });

  it('plugin lists configured plugins', async () => {
    const rig = withRig();
    const config = {
      providers: {},
      log: { level: 'error' },
      plugins: ['npm:simple', { name: 'fancy', enabled: false }],
    } as never as Config;
    const code = await subcommands['plugin']!([], mkDeps({ renderer: rig.renderer, config }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('npm:simple');
    expect(text).toContain('fancy');
    expect(text).toContain('disabled');
  });

  it('plugins is an alias for plugin', async () => {
    const rig = withRig();
    const config = {
      providers: {},
      log: { level: 'error' },
      plugins: ['@wrongstack/telegram'],
    } as never as Config;
    const code = await subcommands['plugins']!(
      ['list'],
      mkDeps({ renderer: rig.renderer, config }),
    );
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('@wrongstack/telegram');
  });

  it('plugin status is an alias for list', async () => {
    const rig = withRig();
    const config = {
      providers: {},
      log: { level: 'error' },
      plugins: [{ name: '@wrongstack/telegram', enabled: false }],
    } as never as Config;
    const code = await subcommands['plugin']!(
      ['status'],
      mkDeps({ renderer: rig.renderer, config }),
    );

    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('@wrongstack/telegram');
    expect(text).toContain('disabled');
  });

  it('plugin add writes an enabled plugin entry', async () => {
    const rig = withRig();
    const paths = resolveWstackPaths({
      projectRoot: tmp,
      globalRoot: path.join(tmp, 'g'),
      userHome: tmp,
    });
    const code = await subcommands['plugin']!(
      ['add', '@wrongstack/telegram'],
      mkDeps({ renderer: rig.renderer, paths }),
    );

    expect(code).toBe(0);
    const written = JSON.parse(await fs.readFile(paths.globalConfig, 'utf8')) as {
      plugins: unknown[];
      features: { plugins: boolean };
    };
    expect(written.plugins).toEqual(['@wrongstack/telegram']);
    expect(written.features.plugins).toBe(true);
  });

  it('plugin install resolves official aliases', async () => {
    const rig = withRig();
    const paths = resolveWstackPaths({
      projectRoot: tmp,
      globalRoot: path.join(tmp, 'g'),
      userHome: tmp,
    });
    const code = await subcommands['plugin']!(
      ['install', 'telegram'],
      mkDeps({ renderer: rig.renderer, paths }),
    );

    expect(code).toBe(0);
    const written = JSON.parse(await fs.readFile(paths.globalConfig, 'utf8')) as {
      plugins: unknown[];
      features: { plugins: boolean };
    };
    expect(written.plugins).toEqual(['@wrongstack/telegram']);
    expect(written.features.plugins).toBe(true);
  });

  it('plugin official lists bundled aliases and config state', async () => {
    const rig = withRig();
    const config = {
      providers: {},
      log: { level: 'error' },
      plugins: [{ name: '@wrongstack/telegram', enabled: false }],
    } as never as Config;
    const code = await subcommands['plugin']!(
      ['official'],
      mkDeps({ renderer: rig.renderer, config }),
    );

    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('telegram');
    expect(text).toContain('@wrongstack/telegram');
    expect(text).toContain('disabled');
    expect(text).toContain('lsp');
    expect(text).toContain('@wrongstack/plug-lsp');
    expect(text).toContain('not configured');
  });

  it('plugin disable converts an entry into a disabled object', async () => {
    const rig = withRig();
    const paths = resolveWstackPaths({
      projectRoot: tmp,
      globalRoot: path.join(tmp, 'g'),
      userHome: tmp,
    });
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ plugins: ['@wrongstack/telegram'] }));

    const code = await subcommands['plugin']!(
      ['disable', '@wrongstack/telegram'],
      mkDeps({ renderer: rig.renderer, paths }),
    );

    expect(code).toBe(0);
    const written = JSON.parse(await fs.readFile(paths.globalConfig, 'utf8')) as {
      plugins: Array<{ name: string; enabled: boolean }>;
    };
    expect(written.plugins).toEqual([{ name: '@wrongstack/telegram', enabled: false }]);
  });

  it('plugin remove deletes a plugin entry', async () => {
    const rig = withRig();
    const paths = resolveWstackPaths({
      projectRoot: tmp,
      globalRoot: path.join(tmp, 'g'),
      userHome: tmp,
    });
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ plugins: ['@wrongstack/telegram', 'other'] }),
    );

    const code = await subcommands['plugin']!(
      ['remove', '@wrongstack/telegram'],
      mkDeps({ renderer: rig.renderer, paths }),
    );

    expect(code).toBe(0);
    const written = JSON.parse(await fs.readFile(paths.globalConfig, 'utf8')) as {
      plugins: unknown[];
    };
    expect(written.plugins).toEqual(['other']);
  });

  it('sessions reports empty when none exist', async () => {
    const rig = withRig();
    const sessionStore = {
      create: async () => ({
        id: 'x',
        append: async () => undefined,
        close: async () => undefined,
      }),
      load: async () => ({
        metadata: {},
        events: [],
        messages: [],
        usage: { input: 0, output: 0 },
      }),
      list: async () => [],
      delete: async () => undefined,
    } as never;
    const code = await subcommands['sessions']!(
      [],
      mkDeps({ renderer: rig.renderer, sessionStore }),
    );
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('No sessions');
  });

  it('sessions lists summaries', async () => {
    const rig = withRig();
    const sessionStore = {
      create: async () => ({
        id: 'x',
        append: async () => undefined,
        close: async () => undefined,
      }),
      load: async () => ({
        metadata: {},
        events: [],
        messages: [],
        usage: { input: 0, output: 0 },
      }),
      list: async () => [
        {
          id: 's1',
          title: 'Hello task',
          startedAt: '2026-05-12T00:00:00Z',
          model: 'm',
          provider: 'p',
          tokenTotal: 100,
        },
      ],
      delete: async () => undefined,
    } as never;
    const code = await subcommands['sessions']!(
      [],
      mkDeps({ renderer: rig.renderer, sessionStore }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('s1');
    expect(text).toContain('Hello task');
    expect(text).toContain('100');
  });

  // `resume <id>` is no longer a standalone subcommand — it's lifted in
  // src/index.ts into the `--resume <id>` flag before subcommand dispatch.
  // Resume behaviour is covered end-to-end by the session-store resume
  // round-trip test in packages/core.

  it('skills lists discovered skills', async () => {
    const rig = withRig();
    const skillLoader = {
      list: async () => [
        {
          name: 'graphify',
          description: 'turn input into knowledge graph',
          source: 'bundled',
          path: '/x',
        },
      ],
      find: async () => undefined,
      manifestText: async () => '',
      readBody: async () => '',
    } as never;
    const code = await subcommands['skills']!([], mkDeps({ renderer: rig.renderer, skillLoader }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('graphify');
    expect(text).toContain('[bundled]');
  });

  it('providers --unsupported only shows unsupported family', async () => {
    const rig = withRig();
    const reg = fakeRegistry([
      fakeProvider({ id: 'anthropic', family: 'anthropic' }),
      fakeProvider({
        id: 'weird',
        family: 'unsupported',
        npm: '@something/unknown',
        name: 'Weird',
      }),
    ]);
    const code = await subcommands['providers']!(
      ['--unsupported'],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('weird');
    expect(text).toContain('needs plugin');
    expect(text).not.toContain('anthropic');
  });

  it('providers --all includes unsupported alongside supported', async () => {
    const rig = withRig();
    const reg = fakeRegistry([
      fakeProvider({ id: 'anthropic', family: 'anthropic' }),
      fakeProvider({ id: 'weird', family: 'unsupported', name: 'Weird' }),
    ]);
    const code = await subcommands['providers']!(
      ['--all'],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('anthropic');
    expect(text).toContain('weird');
  });

  it('providers handles registry failure with non-zero exit', async () => {
    const rig = withRig();
    const reg = {
      ...fakeRegistry([]),
      listProviders: async () => {
        throw new Error('network down');
      },
    } as ModelsRegistry;
    const code = await subcommands['providers']!(
      [],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('network down');
  });

  it('models without args uses config.provider', async () => {
    const rig = withRig();
    const config = {
      providers: {},
      log: { level: 'error' },
      provider: 'anthropic',
      model: 'anthropic-test-model',
    } as never as Config;
    const reg = fakeRegistry([fakeProvider()]);
    const code = await subcommands['models']!(
      [],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg, config }),
    );
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('anthropic-test-model');
  });

  it('models without args + no config provider returns usage error', async () => {
    const rig = withRig();
    const code = await subcommands['models']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('Usage');
  });

  it('models refresh surfaces failure', async () => {
    const rig = withRig();
    const reg = {
      ...fakeRegistry([]),
      refresh: async () => {
        throw new Error('fetch failed');
      },
    } as ModelsRegistry;
    const code = await subcommands['models']!(
      ['refresh'],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('fetch failed');
  });

  it('mcp rejects unknown subcommand', async () => {
    const rig = withRig();
    const code = await subcommands['mcp']!(['frobnicate'], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('Unknown mcp subcommand');
  });

  it('mcp restart warns and exits 0 outside REPL', async () => {
    const rig = withRig();
    const code = await subcommands['mcp']!(['restart'], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.err.buf)).toContain('only available in REPL');
  });

  it('plugin rejects unknown subcommand', async () => {
    const rig = withRig();
    const code = await subcommands['plugin']!(
      ['frobnicate', 'foo'],
      mkDeps({ renderer: rig.renderer }),
    );
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('Unknown plugin subcommand');
  });

  it('usage prints session token totals', async () => {
    const rig = withRig();
    const sessionStore = {
      create: async () => ({
        id: 'x',
        append: async () => undefined,
        close: async () => undefined,
      }),
      load: async () => ({
        metadata: {},
        events: [],
        messages: [],
        usage: { input: 0, output: 0 },
      }),
      list: async () => [
        { id: 'a', title: '', startedAt: '', model: '', provider: '', tokenTotal: 50 },
        { id: 'b', title: '', startedAt: '', model: '', provider: '', tokenTotal: 75 },
      ],
      delete: async () => undefined,
    } as never;
    const code = await subcommands['usage']!([], mkDeps({ renderer: rig.renderer, sessionStore }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('Sessions: 2');
    expect(text).toContain('125');
  });
});

// silence unused-helpers lint
void getOut;
void mkDeps;
