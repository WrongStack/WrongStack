import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SlashCommandRegistry,
  ToolRegistry,
  DefaultMemoryStore,
  DefaultModeStore,
  EventBus,
  type WstackPaths,
} from '@wrongstack/core';
import { setupSlashCommands } from '../src/wiring/slash-commands.js';

let tmp: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiring-slash-'));
  prevEnv = process.env.WRONGSTACK_STATUSLINE_CONFIG;
  process.env.WRONGSTACK_STATUSLINE_CONFIG = path.join(tmp, 'statusline.json');
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.WRONGSTACK_STATUSLINE_CONFIG;
  else process.env.WRONGSTACK_STATUSLINE_CONFIG = prevEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeWpaths(): WstackPaths {
  return {
    configDir: tmp,
    globalConfig: path.join(tmp, 'config.json'),
    secretsKey: path.join(tmp, '.key'),
    globalSkills: path.join(tmp, 'skills'),
    cacheDir: path.join(tmp, 'cache'),
    modelsCache: path.join(tmp, 'models.json'),
    historyFile: path.join(tmp, 'history'),
    logFile: path.join(tmp, 'log.txt'),
    projectDir: tmp,
    projectMemory: path.join(tmp, 'project-memory.md'),
    projectSessions: tmp,
    projectTrust: path.join(tmp, 'trust.json'),
    projectMeta: path.join(tmp, 'meta.json'),
    projectLocalConfig: path.join(tmp, 'config.local.json'),
    globalRoot: tmp,
    globalMemory: path.join(tmp, 'global-memory.md'),
    inProjectAgentsFile: path.join(tmp, 'AGENTS.md'),
    inProjectSkills: path.join(tmp, '.wrongstack', 'skills'),
    projectHash: 'testhash',
    projectGoal: path.join(tmp, 'goal.json'),
    projectSpecs: path.join(tmp, 'specs'),
    projectTaskGraphs: path.join(tmp, 'task-graphs'),
    projectSddSession: path.join(tmp, 'sdd-session.json'),
    projectPlan: path.join(tmp, 'plan.json'),
  } as WstackPaths;
}

function fakeContext() {
  return {
    session: { id: 'sess-x' },
    meta: {},
    state: {
      replaceTodos: vi.fn(),
      setMeta: vi.fn(),
    },
    todos: [],
    cwd: tmp,
    projectRoot: tmp,
    messages: [],
  } as never;
}

function fakeMultiAgentHost() {
  return {
    spawn: vi.fn().mockResolvedValue({ subagentId: 'sub-1', taskId: 'task-1' }),
    status: vi.fn().mockReturnValue({ live: [] }),
  } as never;
}

function fakeEvents(): EventBus {
  return new EventBus();
}

function callSetup(overrides: Record<string, unknown> = {}): Promise<void> {
  const wpaths = makeWpaths();
  return setupSlashCommands({
    slashRegistry: new SlashCommandRegistry(),
    toolRegistry: new ToolRegistry(),
    paths: wpaths,
    sessionStore: {} as never,
    skillLoader: undefined,
    tokenCounter: {} as never,
    renderer: { write: vi.fn(), writeInfo: vi.fn(), writeError: vi.fn() } as never,
    events: fakeEvents(),
    memoryStore: new DefaultMemoryStore({ paths: wpaths }),
    context: fakeContext(),
    cwd: tmp,
    projectRoot: tmp,
    metricsSink: undefined,
    healthRegistry: undefined,
    planPath: path.join(tmp, 'plan.json'),
    modeStore: new DefaultModeStore({ directory: tmp }),
    provider: { id: 'p' } as never,
    model: 'm',
    multiAgentHost: fakeMultiAgentHost(),
    fleetStreamController: { enabled: false, setEnabled: vi.fn() },
    compactor: { compact: vi.fn() },
    ...overrides,
  } as never);
}

describe('setupSlashCommands', () => {
  it('runs to completion when no statusline config file exists', async () => {
    await expect(callSetup()).resolves.toBeUndefined();
  });

  it('runs with all chips enabled (default statusline)', async () => {
    await fs.writeFile(
      process.env.WRONGSTACK_STATUSLINE_CONFIG!,
      JSON.stringify({
        todos: true,
        plan: true,
        fleet: true,
        git: true,
        elapsed: true,
        context: true,
        cost: true,
      }),
    );
    await expect(callSetup()).resolves.toBeUndefined();
  });

  it('runs with some chips hidden via statusline config', async () => {
    await fs.writeFile(
      process.env.WRONGSTACK_STATUSLINE_CONFIG!,
      JSON.stringify({
        todos: true,
        plan: false,
        fleet: false,
        git: true,
        elapsed: true,
        context: true,
        cost: true,
      }),
    );
    await expect(callSetup()).resolves.toBeUndefined();
  });

  it('runs when multiAgentHost.spawn / status have no live subagents', async () => {
    const host = fakeMultiAgentHost();
    await callSetup({ multiAgentHost: host });
    // Smoke: spawn/status shouldn't have been invoked since the slash command
    // hasn't been triggered yet (callbacks only run on /spawn or /agents).
    expect((host as { spawn: ReturnType<typeof vi.fn> }).spawn).not.toHaveBeenCalled();
  });
});
