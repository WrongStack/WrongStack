/**
 * Regression: PowerShell METHOD INVOCATION on a piped process object.
 *
 * `Get-Process <runtime> | % { $_.Kill() }` (also `ForEach-Object` / `foreach`)
 * terminates every process the pipe carries, including this one, but it names
 * no kill VERB. Both layers therefore found no kill command and allowed it.
 *
 * Both layers are asserted here: the shared pipeline-selector helper is what
 * Layer 2 calls, so a regression in either entry point must fail this file.
 */
import { describe, expect, it } from 'vitest';
import { checkAndBlockKillCommand } from '../src/bash-kill-guard.js';
import { checkExecKillCommand } from '../src/exec-kill-guard.js';

const image = (process.execPath.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');

describe('kill guards: piped process-object method invocation', () => {
  it('blocks % { $_.Kill() } on both layers', async () => {
    const command = `Get-Process ${image} | % { $_.Kill() }`;
    expect((await checkAndBlockKillCommand(command)).blocked).toBe(true);
    expect((await checkExecKillCommand('pwsh', ['-Command', command])).blocked).toBe(true);
  });

  it('blocks ForEach-Object and foreach spellings on both layers', async () => {
    for (const verb of ['ForEach-Object', 'foreach']) {
      const command = `Get-Process ${image} | ${verb} { $_.Kill() }`;
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(true);
      expect((await checkExecKillCommand('pwsh', ['-Command', command])).blocked, command).toBe(
        true,
      );
    }
  });

  it('keeps read-only pipelines and unrelated selectors allowed', async () => {
    for (const command of [
      'Get-Process | Select-Object -First 1',
      `Get-Process -Id ${process.pid}`,
      'taskkill /F /PID 2147483646',
    ]) {
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(false);
      expect((await checkExecKillCommand('pwsh', ['-Command', command])).blocked, command).toBe(
        false,
      );
    }
  });
});
