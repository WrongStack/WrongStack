import { describe, expect, it, vi } from 'vitest';
import { runInteractive } from '../src/cli-main.js';
import { execute } from '../src/execution.js';
import { modeldiagCmd } from '../src/subcommands/handlers/modeldiag.js';
import { setupBrainAndOrchestration } from '../src/wiring/brain-and-orchestration.js';
import { setupLifecycleAndPlugins } from '../src/wiring/lifecycle-plugins.js';

const mocks = vi.hoisted(() => ({
  resolveModeAndCapabilities: vi.fn(),
  resolveBrainConfigDefaults: vi.fn(),
  HookRegistry: vi.fn(),
  writeErr: vi.fn(),
}));

vi.mock('../src/boot/system-prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/boot/system-prompt.js')>();
  return { ...actual, resolveModeAndCapabilities: mocks.resolveModeAndCapabilities };
});
vi.mock('@wrongstack/core/execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/execution')>();
  return { ...actual, resolveBrainConfigDefaults: mocks.resolveBrainConfigDefaults };
});
vi.mock('@wrongstack/core/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/hooks')>();
  return { ...actual, HookRegistry: mocks.HookRegistry };
});
vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return { ...actual, writeErr: mocks.writeErr };
});

describe('large CLI entrypoint guards', () => {
  it('returns the mode-resolution exit without constructing the interactive runtime', async () => {
    mocks.resolveModeAndCapabilities.mockResolvedValueOnce({
      kind: 'exit',
      message: 'model unavailable',
      code: 2,
    });
    const reader = { close: vi.fn().mockResolvedValue(undefined) };
    const modeStore = { getActiveMode: vi.fn().mockResolvedValue(null) };
    const context = {
      config: { features: {} },
      vault: {},
      wpaths: { profileConfig: () => 'D:/config.json' },
      cwd: 'D:/repo',
      projectRoot: 'D:/repo',
      flags: {},
      positional: [],
      modelsRegistry: {},
      renderer: {},
      reader,
      logger: {},
      needsSetup: false,
      events: {},
      container: { resolve: vi.fn().mockReturnValue(modeStore) },
      configStore: {},
      updateInfo: undefined,
    };

    await expect(runInteractive(context as never)).resolves.toBe(2);
    expect(reader.close).toHaveBeenCalledOnce();
    expect(mocks.writeErr).toHaveBeenCalledWith('model unavailable\n');
  });

  it('propagates storage-observability subscription failures during execution wiring', async () => {
    const on = vi.fn(() => {
      throw new Error('event bus closed');
    });
    const deps = {
      core: {
        events: { on },
        config: {},
        wpaths: {},
        projectRoot: 'D:/repo',
        flags: {},
        positional: [],
      },
      session: { context: { traceId: 'trace' } },
      provider: {},
      ui: {},
      fleet: {},
      controllers: {},
      commands: {},
      pickers: {},
      lifecycles: {},
    };
    await expect(execute(deps as never)).rejects.toThrow('event bus closed');
    expect(on).toHaveBeenCalled();
  });

  it('reports an unreadable model cache through the modeldiag command', async () => {
    const renderer = { write: vi.fn() };
    const code = await modeldiagCmd(['keys'], {
      paths: { modelsCache: 'D:/definitely-missing/providers.json' },
      renderer,
      config: {},
    } as never);
    expect([0, 1]).toContain(code);
    expect(renderer.write).toHaveBeenCalledWith(expect.stringContaining('Models cache'));
  });

  it('propagates invalid Brain configuration before constructing orchestration services', () => {
    mocks.resolveBrainConfigDefaults.mockImplementationOnce(() => {
      throw new Error('invalid brain config');
    });
    expect(() =>
      setupBrainAndOrchestration({
        config: {},
        wpaths: {
          projectDir: 'D:/project',
          globalConfig: 'D:/config.json',
          profileConfig: () => 'D:/config.json',
        },
        teardownHandlers: [],
      } as never),
    ).toThrow('invalid brain config');
  });

  it('propagates hook-registry construction failures during lifecycle setup', async () => {
    mocks.HookRegistry.mockImplementationOnce(() => {
      throw new Error('hook registry unavailable');
    });
    await expect(
      setupLifecycleAndPlugins({
        flags: {},
        config: {},
      } as never),
    ).rejects.toThrow('hook registry unavailable');
  });
});
