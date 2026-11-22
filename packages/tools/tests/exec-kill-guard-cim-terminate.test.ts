/**
 * Regression: `Invoke-CimMethod -MethodName Terminate` on a Win32_Process
 * filtered to this PID kills the running WrongStack process.
 *
 * Layer 1 (bash/pwsh raw string) blocked it only through its kill-shaped
 * fallback; Layer 2 (exec argv) modelled taskkill/tskill/Stop-Process/wmic and
 * returned allow, so `exec pwsh -Command '<payload>'` terminated the process —
 * a fail-open on the entry point the guard exists to protect.
 */
import { describe, expect, it } from 'vitest';
import { checkAndBlockKillCommand } from '../src/bash-kill-guard.js';
import { checkExecKillCommand } from '../src/exec-kill-guard.js';

const self = String(process.pid);
const cimTerminate = `Get-CimInstance Win32_Process -Filter "ProcessId=${self}" | Invoke-CimMethod -MethodName Terminate`;

const winOnly = process.platform === 'win32' ? it : it.skip;

describe('kill guards: CIM/WMI process termination', () => {
  winOnly('blocks a CIM terminate targeting this PID through the exec tool', async () => {
    const result = await checkExecKillCommand('pwsh', ['-Command', cimTerminate]);
    expect(result.blocked).toBe(true);
  });

  winOnly('blocks the same command line on both layers', async () => {
    expect((await checkAndBlockKillCommand(cimTerminate)).blocked).toBe(true);
    expect(
      (await checkExecKillCommand('pwsh', ['-NoProfile', '-Command', cimTerminate])).blocked,
    ).toBe(true);
  });

  winOnly('blocks a name-filtered CIM terminate of this runtime image', async () => {
    const payload = `Get-CimInstance Win32_Process -Filter "Name='${process.execPath.split(/[\\/]/).pop()}'" | Invoke-CimMethod -MethodName Terminate`;
    expect((await checkExecKillCommand('pwsh', ['-Command', payload])).blocked).toBe(true);
  });

  winOnly('leaves a read-only CIM query and an unrelated PID alone', async () => {
    expect(
      (await checkExecKillCommand('pwsh', ['-Command', 'Get-CimInstance Win32_Process'])).blocked,
    ).toBe(false);
    expect(
      (
        await checkExecKillCommand('pwsh', [
          '-Command',
          'Get-CimInstance Win32_Process -Filter "ProcessId=2147483646" | Invoke-CimMethod -MethodName Terminate',
        ])
      ).blocked,
    ).toBe(false);
  });
});
