import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

// Mock the persistent process registry to isolate kill guard tests.
// Returns empty protections so that none of the PID/name checks trip unless
// we specifically want them to.
vi.mock('../src/process-registry-persistent.js', () => ({
  getPersistentProcessRegistry: () => ({
    shouldBlockKill: vi.fn().mockResolvedValue(false),
    getAllProtectedPids: vi.fn().mockResolvedValue([]),
  }),
  PersistentProcessRegistry: class {},
}));

import { checkExecKillCommand } from '../src/exec-kill-guard.js';

const isWin = os.platform() === 'win32';

describe('exec-kill-guard', () => {
  describe('empty / edge inputs', () => {
    it('returns not blocked for empty command', async () => {
      const result = await checkExecKillCommand('', []);
      expect(result.blocked).toBe(false);
    });

    it('returns not blocked for null/undefined command', async () => {
      const result = await checkExecKillCommand('' as never, []);
      expect(result.blocked).toBe(false);
    });
  });

  // ── Windows-only tests ───────────────────────────────────────────────
  describe.runIf(isWin)('Windows kill variants', () => {
    it('blocks taskkill /IM node.exe', async () => {
      const result = await checkExecKillCommand('taskkill', ['/IM', 'node.exe', '/F']);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/node/);
    });

    it('blocks taskkill /F /IM node.exe', async () => {
      const result = await checkExecKillCommand('taskkill', ['/F', '/IM', 'node.exe']);
      expect(result.blocked).toBe(true);
    });

    it('blocks taskkill /PID targeting current process', async () => {
      const result = await checkExecKillCommand('taskkill', [
        '/F',
        '/PID',
        String(process.pid),
        '/T',
      ]);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/current WrongStack|protected WrongStack/i);
    });

    it('blocks taskkill /PID targeting current process (dash flags)', async () => {
      const result = await checkExecKillCommand('taskkill', [
        '-F',
        '-PID',
        String(process.pid),
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks taskkill.exe with full extension', async () => {
      const result = await checkExecKillCommand('taskkill.exe', [
        '/IM',
        'node.exe',
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks taskkill with /FI IMAGENAME filter', async () => {
      const result = await checkExecKillCommand('taskkill', [
        '/F',
        '/FI',
        'IMAGENAME eq node.exe',
      ]);
      expect(result.blocked).toBe(true);
    });

    it('still checks other /PID args when /IM does not match', async () => {
      // /IM with a non-node name should still check /PID later
      const result = await checkExecKillCommand('taskkill', [
        '/IM',
        'myapp.exe',
        '/F',
        '/PID',
        String(process.pid),
      ]);
      expect(result.blocked).toBe(true);
    });

    it('returns not blocked for taskkill targeting unrelated process', async () => {
      const result = await checkExecKillCommand('taskkill', [
        '/F',
        '/PID',
        '99999999',
      ]);
      expect(result.blocked).toBe(false);
    });

    it('blocks PowerShell Stop-Process -Name node', async () => {
      const result = await checkExecKillCommand('powershell', [
        '-Command',
        'Stop-Process -Name node -Force',
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks PowerShell Stop-Process -Id current PID', async () => {
      const result = await checkExecKillCommand('pwsh', [
        '-Command',
        `Stop-Process -Id ${process.pid}`,
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks cmd /c with taskkill (shell indirection)', async () => {
      const result = await checkExecKillCommand('cmd', [
        '/c',
        `taskkill /F /PID ${process.pid} /T`,
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks Stop-Process alias kill with -Name', async () => {
      const result = await checkExecKillCommand('Stop-Process', [
        '-Name',
        'node',
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks Stop-Process alias kill with -Id current PID', async () => {
      const result = await checkExecKillCommand('Stop-Process', [
        '-Id',
        String(process.pid),
      ]);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/current WrongStack|protected WrongStack/i);
    });

    it('blocks Stop-Process alias kill with -PID flag', async () => {
      const result = await checkExecKillCommand('kill', [
        '-n',
        'node',
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks bare kill alias with name arg', async () => {
      const result = await checkExecKillCommand('kill', ['node']);
      expect(result.blocked).toBe(true);
    });

    it('blocks wmic process delete with name filter', async () => {
      const result = await checkExecKillCommand('wmic', [
        'process',
        'where',
        "name='node.exe'",
        'delete',
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks wmic process delete without name filter', async () => {
      const result = await checkExecKillCommand('wmic', [
        'process',
        'delete',
      ]);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/protected WrongStack/i);
    });

    it('blocks node -e process.kill()', async () => {
      const result = await checkExecKillCommand('node', [
        '-e',
        `process.kill(${process.pid})`,
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks node --eval process.kill() (PID extractable)', async () => {
      const result = await checkExecKillCommand('node', [
        '--eval',
        `process.kill(${process.pid})`,
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks node -e process.kill() even when PID not extractable', async () => {
      const result = await checkExecKillCommand('node', [
        '-e',
        'process.kill(someVar)',
      ]);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/process\.kill/);
    });
  });

  // ── POSIX-only tests ─────────────────────────────────────────────────
  describe.runIf(!isWin)('POSIX kill variants', () => {
    it('blocks kill -9 targeting current process PID', async () => {
      const result = await checkExecKillCommand('kill', [
        '-9',
        String(process.pid),
      ]);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/current WrongStack/i);
    });

    it('blocks kill targeting current process PID (no signal)', async () => {
      const result = await checkExecKillCommand('kill', [
        String(process.pid),
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks kill with negative group PID', async () => {
      const result = await checkExecKillCommand('kill', [
        '--',
        `-${process.pid}`,
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks pkill node', async () => {
      const result = await checkExecKillCommand('pkill', ['node']);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/node/);
    });

    it('blocks killall node', async () => {
      const result = await checkExecKillCommand('killall', ['node']);
      expect(result.blocked).toBe(true);
    });
  });

  // ── Cross-platform: safe command should pass ─────────────────────────
  describe('safe commands', () => {
    it('allows non-kill commands', async () => {
      const result = await checkExecKillCommand('echo', ['hello']);
      expect(result.blocked).toBe(false);
    });

    it('allows taskkill to unknown PID (non-Windows still safe)', async () => {
      const result = await checkExecKillCommand('taskkill', [
        '/F',
        '/PID',
        '99999999',
      ]);
      expect(result.blocked).toBe(false);
    });
  });
});
