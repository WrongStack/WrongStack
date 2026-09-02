/**
 * Tests for EnsembleRegistry.
 *
 * Strategy: inject a fake `probeFn` so the tests don't depend on what's
 * actually installed on the runner's $PATH. The catalog is the default.
 *
 * At the bottom there's one `it.liveProbe` test gated by `RUN_LIVE_PROBE=1`
 * in the environment — that test runs the real probe against the host's
 * $PATH and prints the result. It's useful for sanity-checking the
 * catalog's `probe` commands on a developer's machine. Skipped by default
 * to keep CI deterministic.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS_CATALOG, findAgentDescriptor } from '../src/registry/agents.catalog.js';
import { defaultProbe, EnsembleRegistry } from '../src/registry/ensemble-registry.js';
import type { ACPAgentDescriptor, DetectedAgent } from '../src/registry/ensemble-registry.js';

const CLAUDE: ACPAgentDescriptor = {
  id: 'claude-code',
  displayName: 'Claude Code',
  vendor: 'anthropic',
  probe: { command: 'claude', args: ['--version'] },
  acp: { command: 'claude', args: [] },
  supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
  integration: 'native',
  docs: 'https://example.com',
};

const GEMINI: ACPAgentDescriptor = {
  ...CLAUDE,
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  vendor: 'google',
  probe: { command: 'gemini', args: ['--version'] },
  integration: 'native',
};

const FAKE_CATALOG: readonly ACPAgentDescriptor[] = [CLAUDE, GEMINI];

function fakeChild(exitCode: number | null = 0): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode,
    signalCode: null,
  }) as unknown as ChildProcess;
}

function fakeSpawn(
  action: (child: ChildProcess) => void,
  exitCode: number | null = 0,
): typeof spawn {
  return vi.fn(() => {
    const child = fakeChild(exitCode);
    queueMicrotask(() => action(child));
    return child;
  }) as unknown as typeof spawn;
}

describe('EnsembleRegistry', () => {
  it('listAll returns the catalog in declaration order', () => {
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG });
    expect(reg.listAll().map((a) => a.id)).toEqual(['claude-code', 'gemini-cli']);
  });

  it('uses the bundled catalog when no options are supplied', () => {
    expect(new EnsembleRegistry().listAll()).toBe(AGENTS_CATALOG);
  });

  it('detect() marks an agent installed when the probe reports success', async () => {
    const probe = vi.fn(async () => ({
      ok: true as const,
      version: '2.1.178',
      path: '/usr/local/bin/claude',
      durationMs: 12,
    }));
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG, probeFn: probe });
    const got: DetectedAgent = await reg.detect(CLAUDE);
    expect(got.installed).toBe(true);
    expect(got.version).toBe('2.1.178');
    expect(got.path).toBe('/usr/local/bin/claude');
  });

  it('detect() marks an agent not-installed and reports the reason on failure', async () => {
    const probe = vi.fn(async () => ({
      ok: false as const,
      reason: 'binary not found',
      durationMs: 0,
    }));
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG, probeFn: probe });
    const got = await reg.detect(CLAUDE);
    expect(got.installed).toBe(false);
    expect(got.reason).toBe('binary not found');
    expect(got.path).toBeUndefined();
  });

  it('list() probes every catalog entry in parallel', async () => {
    const probe = vi.fn(async (d: ACPAgentDescriptor) =>
      d.id === 'claude-code'
        ? { ok: true as const, version: '1', durationMs: 1 }
        : { ok: false as const, reason: 'no', durationMs: 0 },
    );
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG, probeFn: probe });
    const all = await reg.list();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(all.find((a) => a.id === 'claude-code')?.installed).toBe(true);
    expect(all.find((a) => a.id === 'gemini-cli')?.installed).toBe(false);
  });

  it('list() caches results for PROBE_CACHE_MS', async () => {
    const probe = vi.fn(async () => ({
      ok: true as const,
      version: '1',
      durationMs: 1,
    }));
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG, probeFn: probe });
    await reg.list();
    await reg.list();
    expect(probe).toHaveBeenCalledTimes(2); // once per entry, only on first list
    reg.invalidate();
    await reg.list();
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('listInstalled returns only the installed entries', async () => {
    const probe = vi.fn(async (d: ACPAgentDescriptor) =>
      d.id === 'claude-code'
        ? { ok: true as const, version: '1', durationMs: 1 }
        : { ok: false as const, reason: 'no', durationMs: 0 },
    );
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG, probeFn: probe });
    const installed = await reg.listInstalled();
    expect(installed.map((a) => a.id)).toEqual(['claude-code']);
  });
});

describe('AGENTS_CATALOG', () => {
  it('has unique ids', () => {
    const ids = AGENTS_CATALOG.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has non-empty displayName, vendor, and docs', () => {
    for (const a of AGENTS_CATALOG) {
      expect(a.displayName.length).toBeGreaterThan(0);
      expect(a.vendor).toBeTruthy();
      expect(a.docs.length).toBeGreaterThan(0);
    }
  });

  it('every entry has a non-empty probe command', () => {
    for (const a of AGENTS_CATALOG) {
      expect(a.probe.command.length).toBeGreaterThan(0);
    }
  });
});

describe('defaultProbe timeout', () => {
  it('reports timeout when the probe command takes too long', async () => {
    // Use a command that blocks (ping on Windows, sleep on POSIX) with a
    // very short timeout so the probe always fails.
    const isWin = process.platform === 'win32';
    const timeoutEntry: ACPAgentDescriptor = {
      id: 'timeout-test',
      displayName: 'Timeout Test',
      vendor: 'community',
      probe: {
        command: isWin ? 'ping' : 'sleep',
        args: isWin ? ['-n', '60', '127.0.0.1'] : ['60'],
      },
      acp: { command: 'node', args: [] },
      supports: { loadSession: true, promptImages: false, terminal: false, fs: false },
      integration: 'experimental',
      docs: '',
    };
    // Use a very short timeout so the probe fails
    const reg = new EnsembleRegistry({ catalog: [timeoutEntry], probeTimeoutMs: 100 });
    const result = await reg.detect(timeoutEntry);
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('probe timed out');
  });

  it('reports spawn failure when the binary cannot be spawned', async () => {
    // Use an empty command string to trigger a synchronous spawn error
    const badEntry: ACPAgentDescriptor = {
      id: 'bad-spawn',
      displayName: 'Bad Spawn',
      vendor: 'community',
      probe: { command: '', args: [] },
      acp: { command: '', args: [] },
      supports: { loadSession: true, promptImages: false, terminal: false, fs: false },
      integration: 'experimental',
      docs: '',
    };
    const reg = new EnsembleRegistry({ catalog: [badEntry], probeTimeoutMs: 500 });
    const result = await reg.detect(badEntry);
    expect(result.installed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('reports not-installed when the binary produces no output', async () => {
    const noOutputEntry: ACPAgentDescriptor = {
      id: 'no-output',
      displayName: 'No Output',
      vendor: 'community',
      probe: { command: 'node', args: ['-e', ''] }, // runs but produces no output
      acp: { command: 'node', args: [] },
      supports: { loadSession: true, promptImages: false, terminal: false, fs: false },
      integration: 'experimental',
      docs: '',
    };
    const reg = new EnsembleRegistry({ catalog: [noOutputEntry], probeTimeoutMs: 5_000 });
    const result = await reg.detect(noOutputEntry);
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/exit code/);
  });
});

describe('defaultProbe event handling', () => {
  it.each([new Error('synchronous failure'), 'non-error failure'])(
    'turns a synchronous spawn throw into data',
    async (thrown) => {
      const spawnProcess = vi.fn(() => {
        throw thrown;
      }) as unknown as typeof spawn;

      const result = await defaultProbe(CLAUDE, 100, spawnProcess, 'linux');
      expect(result).toMatchObject({
        ok: false,
        reason: `spawn failed: ${thrown instanceof Error ? thrown.message : thrown}`,
      });
    },
  );

  it('handles the child error event', async () => {
    const result = await defaultProbe(
      CLAUDE,
      100,
      fakeSpawn((child) => child.emit('error', new Error('ENOENT'))),
      'linux',
    );
    expect(result).toMatchObject({ ok: false, reason: 'binary not found: ENOENT' });
  });

  it('combines stderr output and accepts a probe without args', async () => {
    const descriptor = { ...CLAUDE, probe: { command: 'agent' } };
    const spawnProcess = fakeSpawn((child) => {
      child.stderr?.emit('data', 'agent 2.0\nextra');
      child.emit('close', 7);
    });
    const result = await defaultProbe(descriptor, 100, spawnProcess, 'linux');
    expect(result).toMatchObject({
      ok: true,
      version: 'agent 2.0',
      path: 'agent',
    });
    expect(spawnProcess).toHaveBeenCalledWith('agent', [], expect.any(Object));
  });

  it('recognizes the Windows command-shell missing-binary message', async () => {
    const result = await defaultProbe(
      CLAUDE,
      100,
      fakeSpawn((child) => {
        child.stdout?.emit('data', "'claude' is not recognized");
        child.emit('close', 1);
      }),
      'win32',
    );
    expect(result).toMatchObject({ ok: false, reason: 'binary not found' });
  });

  it('reports a null exit code when a probe closes without output', async () => {
    const result = await defaultProbe(
      CLAUDE,
      100,
      fakeSpawn((child) => child.emit('close', null)),
      'linux',
    );
    expect(result).toMatchObject({ ok: false, reason: 'exit code null; no output' });
  });

  it('ignores a late close event after the timeout settled the result', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild(0);
      const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
      const pending = defaultProbe(CLAUDE, 10, spawnProcess, 'linux');
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({ ok: false, reason: 'probe timed out' });
      child.emit('close', 0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('defaultProbe integration (real subprocess)', () => {
  // The `defaultProbe` function is called internally when no probeFn is
  // injected. We exercise it with an agent whose probe command is `node`
  // (always available), and another whose command is definitely absent.
  it('probes a real binary that exists on PATH', async () => {
    const nodeEntry: ACPAgentDescriptor = {
      id: 'node-test',
      displayName: 'Node Test',
      vendor: 'community',
      probe: { command: 'node', args: ['--version'] },
      acp: { command: 'node', args: [] },
      supports: { loadSession: true, promptImages: false, terminal: false, fs: false },
      integration: 'community',
      docs: 'https://nodejs.org',
    };
    const reg = new EnsembleRegistry({ catalog: [nodeEntry], probeTimeoutMs: 5_000 });
    const result = await reg.detect(nodeEntry);
    expect(result.installed).toBe(true);
    expect(result.version).toMatch(/^v\d/);
  });

  it('reports a missing binary as not-installed', async () => {
    const missingEntry: ACPAgentDescriptor = {
      id: 'not-installed',
      displayName: 'Not Installed',
      vendor: 'community',
      probe: { command: 'binary-that-definitely-does-not-exist-abc123', args: ['--version'] },
      acp: { command: 'not-installed', args: [] },
      supports: { loadSession: true, promptImages: false, terminal: false, fs: false },
      integration: 'experimental',
      docs: '',
    };
    const reg = new EnsembleRegistry({ catalog: [missingEntry], probeTimeoutMs: 2_000 });
    const result = await reg.detect(missingEntry);
    expect(result.installed).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('AGENTS_CATALOG — Kimi Code CLI', () => {
  it('includes the Kimi entry with the correct ACP invocation', () => {
    const kimi = AGENTS_CATALOG.find((a) => a.id === 'kimi');
    expect(kimi).toBeDefined();
    expect(kimi!.displayName).toBe('Kimi Code CLI');
    expect(kimi!.vendor).toBe('moonshot');
    expect(kimi!.acp.command).toBe('kimi');
    expect(kimi!.acp.args).toEqual(['acp']);
    expect(kimi!.probe.command).toBe('kimi');
    expect(kimi!.probe.args).toEqual(['--version']);
    expect(kimi!.integration).toBe('native');
    expect(kimi!.supports.loadSession).toBe(true);
  });

  it('findAgentDescriptor resolves kimi by id', () => {
    expect(findAgentDescriptor('kimi')?.id).toBe('kimi');
    expect(findAgentDescriptor('nonexistent')).toBeUndefined();
  });

  it('detect() reports installed when the probe succeeds', async () => {
    const KIMI_DESC: ACPAgentDescriptor = {
      id: 'kimi',
      displayName: 'Kimi Code CLI',
      vendor: 'moonshot',
      probe: { command: 'kimi', args: ['--version'] },
      acp: { command: 'kimi', args: ['acp'] },
      supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
      integration: 'native',
      docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/ides.html',
    };
    const probe = vi.fn(async () => ({
      ok: true as const,
      version: '1.48.0',
      path: '/usr/local/bin/kimi',
      durationMs: 10,
    }));
    const reg = new EnsembleRegistry({ catalog: [KIMI_DESC], probeFn: probe });
    const got = await reg.detect(KIMI_DESC);
    expect(got.installed).toBe(true);
    expect(got.version).toBe('1.48.0');
    expect(got.vendor).toBe('moonshot');
  });

  it('detect() reports not-installed when kimi is absent from PATH', async () => {
    const KIMI_DESC: ACPAgentDescriptor = {
      id: 'kimi',
      displayName: 'Kimi Code CLI',
      vendor: 'moonshot',
      probe: { command: 'kimi', args: ['--version'] },
      acp: { command: 'kimi', args: ['acp'] },
      supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
      integration: 'native',
      docs: '',
    };
    const probe = vi.fn(async () => ({
      ok: false as const,
      reason: 'binary not found',
      durationMs: 0,
    }));
    const reg = new EnsembleRegistry({ catalog: [KIMI_DESC], probeFn: probe });
    const got = await reg.detect(KIMI_DESC);
    expect(got.installed).toBe(false);
    expect(got.reason).toBe('binary not found');
  });
});

describe('live probe (opt-in via RUN_LIVE_PROBE=1)', () => {
  it.runIf(process.env.RUN_LIVE_PROBE === '1')(
    'prints the live detection result for the host $PATH',
    async () => {
      const reg = new EnsembleRegistry();
      const all = await reg.list();
      // eslint-disable-next-line no-console
      console.log('\n--- EnsembleRegistry live probe ---');
      for (const a of all) {
        const mark = a.installed ? 'OK ' : '   ';
        const detail = a.installed ? (a.version ?? '?') : (a.reason ?? '?');
        // eslint-disable-next-line no-console
        console.log(`${mark} ${a.id.padEnd(14)} ${detail}`);
      }
      // eslint-disable-next-line no-console
      console.log('-------------------------------------');
      expect(all.length).toBeGreaterThan(0);
    },
  );
});
