import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Container, EventBus } from '@wrongstack/core/kernel';
import type { PluginAPI } from '@wrongstack/core/plugin';
import type { Logger, SlashCommand, Tool } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { PLUGIN_NAME } from '../../src/config.js';
import plugin from '../../src/index.js';

const log: Logger = {
  level: 'error',
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return this;
  },
};

const fixtureServer = fileURLToPath(new URL('./fixtures/mock-lsp-server.mjs', import.meta.url));

describe('plugin entry', () => {
  it('registers and unregisters tools and slash commands', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-entry-'));
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    const source = path.join(root, 'edited.ts');
    await fs.writeFile(source, 'const answer = 42;');
    const tools = new Map<string, Tool>();
    const commands = new Map<string, SlashCommand>();
    const promptContributors: Array<() => Promise<Array<{ type: string; text: string }>>> = [];
    const events = new EventBus();
    const api = {
      container: new Container(),
      events,
      pipelines: {},
      tools: {
        register: (tool: Tool) => tools.set(tool.name, tool),
        unregister: (name: string) => {
          tools.delete(name);
        },
        get: (name: string) => tools.get(name),
        list: () => Array.from(tools.values()),
      },
      providers: {},
      mcp: {},
      slashCommands: {
        register: (cmd: SlashCommand) => commands.set(`${PLUGIN_NAME}:${cmd.name}`, cmd),
        unregister: (name: string) => commands.delete(name),
        get: (name: string) => commands.get(name),
        list: () => Array.from(commands.values()),
      },
      registerSystemPromptContributor: (contributor: (typeof promptContributors)[number]) => {
        promptContributors.push(contributor);
        return () => {
          const index = promptContributors.indexOf(contributor);
          if (index >= 0) promptContributors.splice(index, 1);
        };
      },
      config: {
        version: 1,
        cwd: root,
        extensions: {
          [PLUGIN_NAME]: {
            autoDiscover: false,
            autoStart: 'lazy',
            diagnosticsAfterEdit: 'background',
            servers: {
              typescript: {
                command: process.execPath,
                args: [fixtureServer],
                languages: ['typescript'],
                rootPatterns: ['package.json'],
              },
            },
          },
        },
      },
      log,
    } as never as PluginAPI;

    await plugin.setup(api);
    expect(tools.size).toBe(11);
    expect(commands.size).toBe(6);
    expect(tools.has('lsp_diagnostics')).toBe(true);
    expect(tools.has('lsp_references')).toBe(true);
    expect(tools.has('lsp_hover')).toBe(true);
    expect(tools.has('lsp_symbols')).toBe(true);
    expect(tools.has('lsp_code_actions')).toBe(true);
    expect(tools.has('lsp_execute_command')).toBe(true);
    expect(tools.has('lsp_request')).toBe(true);
    expect(tools.has('codebase-lsp-search')).toBe(true);
    expect(commands.has(`${PLUGIN_NAME}:list`)).toBe(true);
    expect(promptContributors).toHaveLength(1);
    expect((await promptContributors[0]!())[0]?.text).toContain('use lsp_diagnostics');

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('background LSP startup timed out')), 5000);
      events.on('lsp.server.ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    events.emit('tool.executed', { name: 'edit', ok: true, input: { path: source } } as never);
    await ready;
    expect(await plugin.health?.()).toMatchObject({ ok: true });

    await plugin.teardown?.(api);
    expect(tools.size).toBe(0);
    expect(commands.size).toBe(0);
    expect(promptContributors).toHaveLength(0);
    expect(await plugin.health?.()).toMatchObject({ ok: false });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps agent tools and prompt guidance disabled when no LSP server exists', async () => {
    const tools = new Map<string, Tool>();
    const commands = new Map<string, SlashCommand>();
    const contributors: Array<() => Promise<Array<{ type: string; text: string }>>> = [];
    const api = {
      container: new Container(),
      events: new EventBus(),
      pipelines: {},
      tools: {
        register: (tool: Tool) => tools.set(tool.name, tool),
        unregister: (name: string) => tools.delete(name),
        get: (name: string) => tools.get(name),
        list: () => [...tools.values()],
      },
      providers: {},
      mcp: {},
      slashCommands: {
        register: (command: SlashCommand) => commands.set(command.name, command),
        unregister: (name: string) => commands.delete(name),
        get: (name: string) => commands.get(name),
        list: () => [...commands.values()],
      },
      registerSystemPromptContributor: (contributor: (typeof contributors)[number]) => {
        contributors.push(contributor);
        return () => contributors.splice(contributors.indexOf(contributor), 1);
      },
      config: {
        version: 1,
        cwd: process.cwd(),
        extensions: { [PLUGIN_NAME]: { autoDiscover: false, servers: {} } },
      },
      log,
    } as never as PluginAPI;

    await plugin.setup(api);

    expect(tools.size).toBe(0);
    expect(commands.size).toBe(6);
    expect(await contributors[0]!()).toEqual([]);

    await plugin.teardown?.(api);
  });
});
