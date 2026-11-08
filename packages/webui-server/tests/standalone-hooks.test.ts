import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type {
  Config,
  Logger,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from '@wrongstack/contracts/types';
import { type Agent, type Context, createDefaultPipelines } from '@wrongstack/core/agent';
import { ToolExecutor } from '@wrongstack/core/execution';
import { ExtensionRegistry } from '@wrongstack/core/extension';
import { CONFIG_BEHAVIOR_DEFAULTS, DefaultConfigStore } from '@wrongstack/core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStandaloneHooks } from '../src/server/standalone-hooks.js';

let dir: string;
let recordLog: string;
let recordScript: string;
let blockScript: string;
const disposers: Array<() => void> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ws-standalone-hooks-'));
  recordLog = join(dir, 'hook-input.log');
  recordScript = join(dir, 'record.cjs');
  blockScript = join(dir, 'block.cjs');
  // An ordinary user hook: records what it was asked about.
  await writeFile(
    recordScript,
    `let s='';process.stdin.on('data',(d)=>{s+=d});process.stdin.on('end',()=>{require('node:fs').appendFileSync(${JSON.stringify(recordLog)},s+'\\n');process.exit(0)});`,
  );
  // An enforcement hook: exit code 2 forces a block.
  await writeFile(
    blockScript,
    `process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('danger is denied by policy');process.exit(2)});`,
  );
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await rm(dir, { recursive: true, force: true });
});

const logger: Logger = {
  level: 'info',
  trace: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

type UserHooks = NonNullable<Config['hooks']>;

function userHooks(): UserHooks {
  return {
    PreToolUse: [
      { matcher: 'echo', command: `node "${recordScript}"` },
      { matcher: 'danger', command: `node "${blockScript}"`, policy: true },
    ],
  } as UserHooks;
}

function tool(name: string): Tool {
  return {
    name,
    description: `fixture tool ${name}`,
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    execute: vi.fn().mockResolvedValue({ ok: true }),
  } as Tool;
}

function ctx(): Context {
  return {
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    provider: { id: 'fixture', capabilities: {}, complete: vi.fn(), stream: vi.fn() },
    session: { id: 'tab-1', append: vi.fn(), close: vi.fn() },
    signal: new AbortController().signal,
    tokenCounter: {
      account: vi.fn(),
      total: vi.fn().mockReturnValue({ input: 0, output: 0 }),
      estimateCost: vi.fn().mockReturnValue({ total: 0 }),
    },
    cwd: dir,
    projectRoot: dir,
    model: 'fixture-model',
    tools: [],
    meta: {},
    registerAbortHook: vi.fn().mockReturnValue(() => {}),
    drainAbortHooks: vi.fn(),
    recordRead: vi.fn(),
    hasRead: vi.fn(),
    lastReadMtime: vi.fn(),
    usage: vi.fn().mockReturnValue({ input: 0, output: 0 }),
  } as never as Context;
}

function host(options: { safeMode?: boolean; hooks?: UserHooks } = {}) {
  const config = {
    ...CONFIG_BEHAVIOR_DEFAULTS,
    provider: 'fixture',
    model: 'fixture-model',
    hooks: options.hooks ?? userHooks(),
  } as Config;
  const configStore = new DefaultConfigStore(config);
  const pipelines = createDefaultPipelines();
  const hooks = createStandaloneHooks({
    config,
    configStore,
    pipelines,
    events: new EventBus(),
    logger,
    projectRoot: dir,
    context: { session: { id: 'tab-1' }, cwd: dir },
    safeMode: options.safeMode ?? false,
  });
  disposers.push(() => hooks.dispose());
  const tools = [tool('echo'), tool('danger')];
  // The executor the standalone host builds for every tab (backend-services.ts).
  const executor = new ToolExecutor(
    { get: (name: string) => tools.find((t) => t.name === name), list: () => tools } as never,
    {
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'default' }),
      } as never,
      secretScrubber: { scrub: (s: string) => s } as never,
      perIterationOutputCapBytes: 50_000,
      hookRunner: hooks.hookRunner,
    },
  );
  const run = async (name: string) => {
    const use: ToolUseBlock = { type: 'tool_use', id: `id_${name}`, name, input: { n: 1 } };
    const result = await executor.executeBatch([use], ctx(), 'sequential');
    return String((result.outputs[0]!.result as ToolResultBlock).content);
  };
  return { hooks, tools, run, configStore, pipelines };
}

describe('standalone host user hooks', () => {
  it('runs config.hooks in the tool pipeline: an ordinary hook fires and a policy hook blocks', async () => {
    const { run, tools } = host();

    await run('echo');
    expect(tools[0]?.execute).toHaveBeenCalledOnce();
    const recorded = await readFile(recordLog, 'utf8');
    expect(recorded).toContain('"toolName":"echo"');

    const denied = await run('danger');
    expect(denied).toContain('blocked by a PreToolUse hook');
    expect(denied).toContain('danger is denied by policy');
    expect(tools[1]?.execute).not.toHaveBeenCalled();
  });

  it('keeps only policy hooks in safe mode, as --safe-mode does in the CLI', async () => {
    const { run, tools } = host({ safeMode: true });

    await run('echo');
    expect(tools[0]?.execute).toHaveBeenCalledOnce();
    expect(existsSync(recordLog)).toBe(false);

    expect(await run('danger')).toContain('blocked by a PreToolUse hook');
    expect(tools[1]?.execute).not.toHaveBeenCalled();
  });

  it('hot-reloads config.hooks until disposed', async () => {
    const { run, tools, configStore, hooks } = host({ hooks: {} as UserHooks });
    await run('danger');
    expect(tools[1]?.execute).toHaveBeenCalledOnce();

    configStore.update({ hooks: userHooks() });
    expect(await run('danger')).toContain('blocked by a PreToolUse hook');

    hooks.dispose();
    configStore.update({ hooks: {} as UserHooks });
    expect(await run('danger')).toContain('blocked by a PreToolUse hook');
  });

  it('installs the UserPromptSubmit point, SessionStart/Stop per agent, and keeps workers on WrongTrace only', async () => {
    const { hooks, pipelines } = host();
    expect(pipelines.userInput.list()).toContain('UserPromptSubmitHooks');
    const agent = { extensions: new ExtensionRegistry() } as unknown as Agent;
    hooks.attach(agent);
    hooks.attach(agent);
    expect(agent.extensions.list()).toEqual(['lifecycle-hooks']);

    // The leader runs the user's policy hook; a Goal/SDD worker does not.
    const env = { cwd: dir, session: { id: 'tab-1' } };
    expect((await hooks.hookRunner.preToolUse('danger', {}, env)).block).toBe(true);
    expect((await hooks.workerHookRunner.preToolUse('danger', {}, env)).block).toBeFalsy();
    expect(hooks.hookRegistry.countByOwner('wrongtrace-gate')).toBe(2);
  });
});
