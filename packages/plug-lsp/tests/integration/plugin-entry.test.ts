import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolExecutor } from '@wrongstack/core/execution';
import { HookRegistry, HookRunner } from '@wrongstack/core/hooks';
import { Container, EventBus } from '@wrongstack/core/kernel';
import type { PluginAPI } from '@wrongstack/core/plugin';
import type { Logger, SlashCommand, Tool } from '@wrongstack/core/types';
import { patchTool, replaceTool } from '@wrongstack/tools';
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
    const hooks = new HookRegistry();
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
      registerHook: ((event, matcher, hook, options) =>
        hooks.registerInProcess(
          event,
          matcher,
          hook,
          PLUGIN_NAME,
          options,
        )) as PluginAPI['registerHook'],
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
    expect(commands.has(`${PLUGIN_NAME}:lsp-list`)).toBe(true);
    expect(promptContributors).toHaveLength(1);
    expect((await promptContributors[0]!())[0]?.text).toContain('lsp_diagnostics');

    let startupStarted = false;
    const ready = new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopStarting = events.on('lsp.server.starting', () => {
        startupStarted = true;
        // The same 5s startup budget begins at server startup, excluding the
        // preceding edit, permission checks, and post-tool hook preparation.
        timer = setTimeout(() => {
          stopStarting();
          stopReady();
          reject(new Error('background LSP startup timed out'));
        }, 5000);
      });
      const stopReady = events.on('lsp.server.ready', () => {
        if (timer !== undefined) clearTimeout(timer);
        stopStarting();
        stopReady();
        resolve();
      });
    });
    // Preserve rejection for the assertion without an early unhandled promise
    // while the real tool/hook call is still completing.
    void ready.catch(() => {});
    const edit: Tool = {
      name: 'edit',
      description: 'fixture edit',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: true,
      async execute() {
        await fs.writeFile(source, 'const answer: number = "wrong";\n');
        return 'edited';
      },
    };
    const executable: Tool[] = [edit, patchTool as unknown as Tool, replaceTool as unknown as Tool];
    const executor = new ToolExecutor(
      { get: (name) => executable.find((tool) => tool.name === name), list: () => executable },
      {
        hookRunner: new HookRunner({ registry: hooks }),
        permissionPolicy: { evaluate: async () => ({ permission: 'auto' }) } as never,
        secretScrubber: { scrub: (text: string) => text } as never,
        perIterationOutputCapBytes: 50_000,
        confirmAwaiter: async () => 'yes',
      },
    );
    const executed = await executor.executeBatch(
      [{ type: 'tool_use', id: 'edit-1', name: 'edit', input: { path: source } }],
      {
        cwd: root,
        projectRoot: root,
        signal: new AbortController().signal,
        session: { id: 'owned-session', append: async () => {} },
        messages: [],
        todos: [],
        readFiles: new Set(),
        fileMtimes: new Map(),
        meta: {},
      } as never,
      'sequential',
    );
    expect(startupStarted).toBe(true);
    await ready;
    expect(executed.outputs[0]?.result).toMatchObject({
      type: 'tool_result',
      is_error: false,
      content: expect.stringContaining('[Post-edit LSP feedback]'),
    });
    expect(executed.outputs[0]?.result).toMatchObject({
      content: expect.stringContaining('MOCK001'),
    });
    events.emit('tool.executed', { name: 'edit', ok: true, input: { path: source } } as never);
    const repeatedFeedback = await new HookRunner({ registry: hooks }).postToolUse(
      'edit',
      { path: source },
      { content: 'edited', isError: false },
      { cwd: root, session: { id: 'owned-session' }, signal: new AbortController().signal },
    );
    expect(repeatedFeedback.additionalContext).toContain('version=1;');
    const second = path.join(root, 'second.ts');
    await fs.writeFile(second, 'const second: number = "wrong";\n');
    const context = {
      cwd: root,
      projectRoot: root,
      signal: new AbortController().signal,
      session: { id: 'owned-session', append: async () => {} },
      messages: [],
      todos: [],
      readFiles: new Set(),
      fileMtimes: new Map(),
      meta: {},
    } as never;
    const replaced = await executor.executeBatch(
      [
        {
          type: 'tool_use',
          id: 'replace-bulk',
          name: 'replace',
          input: {
            files: 'edited.ts,second.ts',
            pattern: 'wrong',
            replacement: 'bulk',
            dry_run: false,
          },
        },
      ],
      context,
      'sequential',
    );
    const replaceResult = replaced.outputs[0]?.result;
    expect(replaceResult).toMatchObject({
      is_error: false,
      content: expect.stringContaining('Verified file(s): 2'),
    });
    expect(replaceResult).toMatchObject({ content: expect.stringContaining('MOCK001') });
    expect(await fs.readFile(second, 'utf8')).toContain('"bulk"');
    const patched = await executor.executeBatch(
      [
        {
          type: 'tool_use',
          id: 'patch-bulk',
          name: 'patch',
          input: {
            patch:
              '--- a/edited.ts\n+++ b/edited.ts\n@@ -1 +1 @@\n-const answer: number = "bulk";\n+const answer: number = "patched";\n' +
              '--- a/second.ts\n+++ b/second.ts\n@@ -1 +1 @@\n-const second: number = "bulk";\n+const second: number = "patched";\n',
          },
        },
      ],
      context,
      'sequential',
    );
    expect(patched.outputs[0]?.result).toMatchObject({
      is_error: false,
      content: expect.stringContaining('Verified file(s): 2'),
    });
    expect(await fs.readFile(second, 'utf8')).toContain('"patched"');
    expect(await plugin.health?.()).toMatchObject({ ok: true });

    await plugin.teardown?.(api);
    expect(tools.size).toBe(0);
    expect(commands.size).toBe(0);
    expect(promptContributors).toHaveLength(0);
    expect(hooks.list('PostToolUse')).toHaveLength(0);
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
