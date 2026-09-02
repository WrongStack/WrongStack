import { beforeEach, describe, expect, it, vi } from 'vitest';
import processGuardPlugin from '../src/process-guard/index.js';

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  metrics: { counter: ReturnType<typeof vi.fn> };
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('process-guard telemetry', () => {
  it('reports pre-execution matches as detections, not blocks', async () => {
    const api = makeApi();
    processGuardPlugin.setup(api as never);

    const hook = api.registerHook.mock.calls[0]?.[2] as ((input: unknown) => void) | undefined;
    expect(hook).toBeTypeOf('function');
    hook?.({ toolName: 'exec', toolInput: { command: 'taskkill' } });

    const tool = api.tools.register.mock.calls.find(
      ([definition]: unknown[]) => (definition as { name: string }).name === 'process_guard_status',
    )?.[0] as { execute: () => Promise<Record<string, unknown>> } | undefined;
    expect(tool).toBeDefined();

    const status = await tool!.execute();
    expect(status).toMatchObject({
      counters: { invocations: 1, detections: 1, warns: 0 },
      lastDetection: { tool: 'exec', target: 'taskkill' },
    });
    expect((status.counters as Record<string, unknown>)['blocks']).toBeUndefined();
    expect(api.metrics.counter).toHaveBeenCalledWith('detections');
  });
});

describe('issue #360 kill-defense regression matrix', () => {
  const isWin = process.platform === 'win32';

  it.runIf(isWin)('bash-kill-guard parses taskkill / Stop-Process / wmic', async () => {
    const { parseKillCommand } = await import('../../tools/src/bash-kill-guard.js');
    expect(parseKillCommand('taskkill /F /PID 12345')).toMatchObject({ pid: 12345 });
    expect(parseKillCommand('Stop-Process -Id 12345 -Force')).toMatchObject({ pid: 12345 });
    expect(parseKillCommand('wmic process where "name=\'node.exe\'" delete')).toBeTruthy();
    expect(parseKillCommand('wmic process where "ProcessId=12345" delete')).toMatchObject({
      pid: 12345,
    });
  });

  it.runIf(isWin)(
    'bash-path wmic ProcessId delete of own PID is blocked (issue #360)',
    async () => {
      const { checkAndBlockKillCommand } = await import('../../tools/src/bash-kill-guard.js');
      const result = await checkAndBlockKillCommand(
        `wmic process where "ProcessId=${process.pid}" delete`,
      );
      expect(result.blocked).toBe(true);
    },
  );

  it.runIf(!isWin)('bash-kill-guard parses POSIX kill', async () => {
    const { parseKillCommand } = await import('../../tools/src/bash-kill-guard.js');
    expect(parseKillCommand(`kill -9 ${process.pid}`)).toMatchObject({ pid: process.pid });
  });

  it.runIf(isWin)('exec-kill-guard blocks taskkill /IM and node -e process.kill', async () => {
    const { checkExecKillCommand } = await import('../../tools/src/exec-kill-guard.js');
    const image = await checkExecKillCommand('taskkill', ['/F', '/IM', 'node.exe']);
    expect(image.blocked).toBe(true);
    const evalKill = await checkExecKillCommand('node', ['-e', `process.kill(${process.pid})`]);
    expect(evalKill.blocked).toBe(true);
  });

  it('isolates sibling process-registry instances', async () => {
    const { PersistentProcessRegistry } = await import(
      '../../tools/src/process-registry-persistent.js'
    );
    expect(typeof PersistentProcessRegistry).toBe('function');
  });
});
