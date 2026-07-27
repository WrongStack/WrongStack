import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  buildPrompt: vi.fn(),
  setQueuedMessagesSnapshot: vi.fn(),
}));

vi.mock('@wrongstack/core/storage', async (original) => {
  const actual = await original<typeof import('@wrongstack/core/storage')>();
  return {
    ...actual,
    DefaultSessionStore: class {
      create = mocks.create;
      delete = mocks.delete;
    },
  };
});

vi.mock('@wrongstack/core/agent', async (original) => {
  const actual = await original<typeof import('@wrongstack/core/agent')>();
  return {
    ...actual,
    DefaultSystemPromptBuilder: class {
      build = mocks.buildPrompt;
    },
    setQueuedMessagesSnapshot: mocks.setQueuedMessagesSnapshot,
  };
});

import { switchProjectInPlace } from '../src/boot/tui-project-switch.js';

function writer(id: string) {
  return {
    id,
    append: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('TUI project switch identity', () => {
  let root: string;
  let targetRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tui-project-switch-'));
    targetRoot = path.join(root, 'target-project');
    await fs.mkdir(targetRoot, { recursive: true });
    mocks.create.mockReset();
    mocks.delete.mockReset().mockResolvedValue(undefined);
    mocks.buildPrompt.mockReset().mockResolvedValue('new system prompt');
    mocks.setQueuedMessagesSnapshot.mockReset();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeHarness() {
    const oldWriter = writer('2026-07-27/sess_old');
    const nextWriter = writer('2026-07-27/sess_new');
    mocks.create.mockResolvedValue(nextWriter);
    const activateSessionIdentity = vi.fn(async () => undefined);
    const state = {
      projectRoot: path.join(root, 'old-project'),
      wpaths: {
        globalRoot: path.join(root, 'global'),
        globalConfig: path.join(root, 'global', 'config.json'),
      },
      activeSessionStore: {},
      activateSessionIdentity,
      detachActiveTodosCheckpoint: vi.fn(),
      pendingProjectSwitch: null,
      autonomousCoordinator: null,
      coordinatorRun: null,
      coordinatorEvents: new Set(),
    };
    const context = {
      session: oldWriter,
      model: 'test-model',
      provider: { id: 'test-provider' },
      cwd: state.projectRoot,
      projectRoot: state.projectRoot,
      workingDir: state.projectRoot,
      state: {
        replaceMessages: vi.fn(),
        replaceTodos: vi.fn(),
        setMeta: vi.fn(),
      },
      clearFileTracking: vi.fn(),
      tokenCounter: { reset: vi.fn() },
      meta: {},
      traceId: 'trace-test',
      systemPrompt: 'old system prompt',
    };
    const tokenCounter = {
      total: vi.fn(() => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })),
    };
    const switchContext = {
      state,
      context,
      events: { emit: vi.fn() },
      agent: { tools: { list: vi.fn(() => []) } },
      config: { provider: 'test-provider', systemPrompt: {} },
      tokenCounter,
      modeId: undefined,
      modeStore: undefined,
      memoryStore: undefined,
      skillLoader: undefined,
      attachTodosCheckpoint: vi.fn(() => vi.fn()),
    };
    return {
      switchContext,
      state,
      context,
      oldWriter,
      nextWriter,
      activateSessionIdentity,
    };
  }

  it('moves registry identity with the new project before committing the switch', async () => {
    const h = makeHarness();

    await expect(
      switchProjectInPlace(h.switchContext as never, targetRoot, 'Target Project'),
    ).resolves.toBeNull();

    expect(h.activateSessionIdentity).toHaveBeenCalledWith(
      h.nextWriter.id,
      expect.objectContaining({
        projectRoot: targetRoot,
        projectName: 'Target Project',
        workingDir: targetRoot,
      }),
    );
    expect(h.state.projectRoot).toBe(targetRoot);
    expect(h.context.session).toBe(h.nextWriter);
    expect(h.oldWriter.close).toHaveBeenCalledOnce();
  });

  it('keeps the old project active and deletes the fresh writer when claim fails', async () => {
    const h = makeHarness();
    h.activateSessionIdentity.mockRejectedValue(new Error('registry unavailable'));

    const message = await switchProjectInPlace(
      h.switchContext as never,
      targetRoot,
      'Target Project',
    );

    expect(message).toContain('registry unavailable');
    expect(h.state.projectRoot).not.toBe(targetRoot);
    expect(h.context.session).toBe(h.oldWriter);
    expect(h.nextWriter.close).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledWith(h.nextWriter.id);
    expect(process.cwd()).toBe(originalCwd);
  });
});
