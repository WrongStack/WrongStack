/**
 * `bash` owns its timeout: `timeout_ms` up to 600s is honoured (the
 * executor's generic 300s ceiling used to cut it short), `timeout_ms: 0`
 * means no wall-clock limit, and `hermetic: true` runs without shell startup
 * files and with a minimal environment.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { ToolExecutor } from '@wrongstack/core/execution';
import type { PermissionDecision, ToolResultBlock } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bashTool } from '../src/bash.js';
import { hermeticEnv, hermeticPosixArgv } from '../src/bash-hermetic.js';
import { execTool } from '../src/exec.js';
import { pwshTool } from '../src/pwsh.js';
import { mkSandbox, newSignal } from './fixtures.js';

const isWin = os.platform() === 'win32';
// A command that outlives a short executor ceiling but finishes on its own.
// A script file, not `node -e`: cmd.exe mangles quoted `=>` / `>`.
async function slowCommand(dir: string, ms = 1200): Promise<string> {
  await fs.writeFile(
    path.join(dir, 'slow.js'),
    `require('node:fs').writeFileSync('slow-ready', 'ready');\nsetTimeout(() => console.log('slow-done'), ${ms});\n`,
  );
  return 'node slow.js';
}

// The regular child env forwards NPM_* (and other tooling prefixes); the
// hermetic env does not.
const PROBE = 'NPM_CONFIG_WS_HERMETIC_PROBE';
afterEach(() => {
  delete process.env[PROBE];
});

describe('bash timeout_ms: 0', () => {
  it('runs without a wall-clock limit instead of being killed after 1ms', async () => {
    const sb = await mkSandbox();
    try {
      const command = await slowCommand(sb.dir);
      const out = await bashTool.execute({ command, timeout_ms: 0 }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.timed_out).toBe(false);
      expect(out.exit_code).toBe(0);
      expect(out.output).toContain('slow-done');
    } finally {
      await sb.cleanup();
    }
  });

  it('is still stopped by the caller abort signal', async () => {
    const sb = await mkSandbox();
    const ac = new AbortController();
    let running: Promise<unknown> | undefined;
    try {
      const cmd = await slowCommand(sb.dir, 20_000);
      running = bashTool
        .execute({ command: cmd, timeout_ms: 0 }, sb.ctx, { signal: ac.signal })
        .catch((err: unknown) => ({ aborted: err }));
      // Measure cancellation after the real command starts, independently of
      // shell/child startup under full-suite load.
      await vi.waitFor(
        async () => {
          expect(await fs.readFile(path.join(sb.dir, 'slow-ready'), 'utf8')).toBe('ready');
        },
        { timeout: 10_000 },
      );
      const started = Date.now();
      ac.abort();
      const out = await running;
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(out).not.toMatchObject({ exit_code: 0 });
    } finally {
      ac.abort();
      await running;
      await sb.cleanup();
    }
  });
});

describe('shell tools own their timeout', () => {
  it('declare managesOwnTimeout so the executor ceiling cannot cut them short', () => {
    expect(bashTool.managesOwnTimeout).toBe(true);
    expect(pwshTool.managesOwnTimeout).toBe(true);
    expect(execTool.managesOwnTimeout).toBe(true);
  });

  it('bash and exec outlive a shorter executor maxToolTimeoutMs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-own-timeout-'));
    try {
      await slowCommand(dir);
      const tools = [bashTool, execTool];
      const executor = new ToolExecutor(
        { get: (n: string) => tools.find((t) => t.name === n), list: () => tools } as never,
        {
          permissionPolicy: {
            evaluate: async (): Promise<PermissionDecision> => ({
              permission: 'auto',
              source: 'default',
            }),
          } as never,
          confirmAwaiter: vi.fn(async () => 'yes' as const),
          secretScrubber: { scrub: (s: string) => s } as never,
          perIterationOutputCapBytes: 200_000,
          // Far below the 1.2s the command needs: before the fix the executor
          // aborted every shell call here regardless of its own timeout.
          maxToolTimeoutMs: 300,
        },
      );
      const ctx = {
        messages: [],
        todos: [],
        readFiles: new Set<string>(),
        fileMtimes: new Map<string, number>(),
        session: { id: 'own-timeout', append: vi.fn(), close: vi.fn() },
        signal: new AbortController().signal,
        cwd: dir,
        projectRoot: dir,
        tools,
        meta: {},
        registerAbortHook: vi.fn().mockReturnValue(() => {}),
        drainAbortHooks: vi.fn(),
      } as never as Context;
      const result = await executor.executeBatch(
        [
          {
            type: 'tool_use',
            id: 'b1',
            name: 'bash',
            input: { command: 'node slow.js', timeout_ms: 10_000 },
          },
          {
            type: 'tool_use',
            id: 'e1',
            name: 'exec',
            input: {
              command: 'node',
              args: ['slow.js'],
              timeout: 10_000,
            },
          },
        ],
        ctx,
        'sequential',
      );
      for (const o of result.outputs) {
        const block = o.result as ToolResultBlock;
        expect(block.is_error, String(block.content)).not.toBe(true);
        expect(String(block.content)).toContain('slow-done');
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('bash hermetic', () => {
  it('drops variables outside the fixed set but keeps PATH', async () => {
    process.env[PROBE] = 'leaked';
    const sb = await mkSandbox();
    try {
      const cmd = isWin ? `echo [%${PROBE}%]` : `echo "[$${PROBE}]"`;
      const open = await bashTool.execute({ command: cmd }, sb.ctx, { signal: newSignal() });
      expect(open.output).toContain('[leaked]');
      const sealed = await bashTool.execute({ command: cmd, hermetic: true }, sb.ctx, {
        signal: newSignal(),
      });
      expect(sealed.output).not.toContain('leaked');
      // PATH survives: a PATH-resolved program still runs.
      const node = await bashTool.execute({ command: 'node -p 6*7', hermetic: true }, sb.ctx, {
        signal: newSignal(),
      });
      expect(node.exit_code).toBe(0);
      expect(node.output).toContain('42');
    } finally {
      await sb.cleanup();
    }
  });

  it('hermeticEnv keeps the fixed keys case-insensitively and forces TERM=dumb', () => {
    const env = hermeticEnv({
      Path: '/bin',
      SystemRoot: 'C:\\Windows',
      HOME: '/home/u',
      BASH_ENV: '/rc',
      ENV: '/rc',
      NPM_CONFIG_PREFIX: '/x',
      TERM: 'xterm-256color',
      WRONGSTACK_SESSION_ID: 's1',
    });
    expect(env).toEqual({
      Path: '/bin',
      SystemRoot: 'C:\\Windows',
      HOME: '/home/u',
      WRONGSTACK_SESSION_ID: 's1',
      TERM: 'dumb',
    });
  });

  it('hermeticPosixArgv switches off each shell’s startup files', () => {
    expect(hermeticPosixArgv('/bin/bash')).toEqual(['--noprofile', '--norc', '-c']);
    expect(hermeticPosixArgv('/usr/bin/zsh')).toEqual(['-f', '-c']);
    expect(hermeticPosixArgv('/usr/bin/fish')).toEqual(['--no-config', '-c']);
    expect(hermeticPosixArgv('/bin/sh')).toEqual(['-c']);
  });
});
