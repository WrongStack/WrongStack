import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const surfaceMocks = vi.hoisted(() => ({
  killAll: vi.fn(),
  runTui: vi.fn(async () => 23),
  runWebUI: vi.fn(async () => undefined),
}));

vi.mock('@wrongstack/tools', () => ({
  getProcessRegistry: () => ({ killAll: surfaceMocks.killAll }),
}));

vi.mock('@wrongstack/tui', () => ({
  runTui: surfaceMocks.runTui,
}));

vi.mock('../src/webui-server.js', () => ({
  runWebUI: surfaceMocks.runWebUI,
}));

import { runSingleShotDispatch } from '../src/boot/dispatch-singleshot.js';
import { runTuiDispatch } from '../src/boot/dispatch-tui.js';
import { runWebUIDispatch } from '../src/boot/dispatch-webui.js';
import { resolveExecutionMode } from '../src/boot/execution-mode.js';

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.sequential('CLI production dispatch journeys', () => {
  let tempRoot: string;
  let originalWrongStackHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    surfaceMocks.runTui.mockResolvedValue(23);
    surfaceMocks.runWebUI.mockResolvedValue(undefined);
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dispatch-'));
    originalWrongStackHome = process.env['WRONGSTACK_HOME'];
    process.env['WRONGSTACK_HOME'] = path.join(tempRoot, 'home');
  });

  afterEach(async () => {
    if (originalWrongStackHome === undefined) delete process.env['WRONGSTACK_HOME'];
    else process.env['WRONGSTACK_HOME'] = originalWrongStackHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('keeps dispatch precedence in one production resolver', () => {
    expect(resolveExecutionMode(['fix this'], {})).toBe('single-shot');
    expect(resolveExecutionMode([], { prompt: 'fix this', webui: true })).toBe('single-shot');
    expect(resolveExecutionMode([], { tui: true })).toBe('tui');
    expect(resolveExecutionMode([], { tui: true, webui: true })).toBe('webui');
    expect(resolveExecutionMode([], { tui: true, 'no-tui': true })).toBe('repl');
    expect(resolveExecutionMode([], { webui: true })).toBe('webui');
    expect(resolveExecutionMode([], {})).toBe('repl');
  });

  it('runs a single-shot turn through the production dispatcher and exits', async () => {
    const run = vi.fn(async () => ({
      status: 'done',
      finalText: 'finished',
      iterations: 2,
      messages: [],
    }));
    const renderer = {
      write: vi.fn(),
      writeError: vi.fn(),
      writeWarning: vi.fn(),
      writeDelegateSummaries: vi.fn(),
    };
    const tokenCounter = {
      total: vi
        .fn()
        .mockReturnValueOnce({ input: 10, output: 4 })
        .mockReturnValueOnce({ input: 17, output: 9 }),
      estimateCost: vi
        .fn()
        .mockReturnValueOnce({ input: 0, output: 0, total: 0, currency: 'USD' })
        .mockReturnValueOnce({ input: 0, output: 0, total: 0.02, currency: 'USD' }),
    };

    const code = await within(
      runSingleShotDispatch({
        agent: { run } as never,
        query: 'fix this',
        flags: {},
        tokenCounter: tokenCounter as never,
        renderer: renderer as never,
      }),
      5_000,
    );

    expect(code).toBe(0);
    expect(run).toHaveBeenCalledWith('fix this', { signal: expect.any(AbortSignal) });
    expect(renderer.write).toHaveBeenCalledWith('\nfinished\n');
    expect(surfaceMocks.killAll).toHaveBeenCalledOnce();
  });

  it('loads and invokes the TUI only through its production dispatch boundary', async () => {
    const options = { initialQuery: 'hello' } as never;
    await expect(within(runTuiDispatch(options), 5_000)).resolves.toBe(23);
    expect(surfaceMocks.runTui).toHaveBeenCalledOnce();
    expect(surfaceMocks.runTui).toHaveBeenCalledWith(options);
  });

  it('maps WebUI flags into the production server boundary and shuts down cleanly', async () => {
    const agent = { disableInteractiveConfirmation: vi.fn() };
    const renderer = {
      setSilent: vi.fn(),
      write: vi.fn(),
      writeInfo: vi.fn(),
    };
    const ctx = {
      agent,
      events: {},
      session: { id: 'dispatch-session' },
      config: {},
      flags: { webui: true, host: '127.0.0.1', port: '4123', open: true },
      projectRoot: tempRoot,
      globalConfigPath: path.join(tempRoot, 'config.json'),
      profileConfigPath: path.join(tempRoot, 'profile.json'),
      projectSessionsDir: path.join(tempRoot, 'sessions'),
      modelsRegistry: {},
      mcpRegistry: {},
      renderer,
    } as never;

    await expect(within(runWebUIDispatch(ctx), 5_000)).resolves.toBe(0);

    expect(agent.disableInteractiveConfirmation).toHaveBeenCalledOnce();
    expect(surfaceMocks.runWebUI).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'webui',
        host: '127.0.0.1',
        port: 4123,
        open: true,
        projectRoot: tempRoot,
      }),
    );
    expect(renderer.setSilent.mock.calls).toEqual([[true], [false]]);
  });

  it('short-circuits plugin management in boot before runtime dispatch', async () => {
    const projectDir = path.join(tempRoot, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { boot } = await import('../src/boot.js');
      const result = await within(boot([`--cwd=${projectDir}`, 'plugin', 'report']), 10_000);
      expect(result).toBe(0);
      expect(surfaceMocks.runTui).not.toHaveBeenCalled();
      expect(surfaceMocks.runWebUI).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
