import { describe, expect, it } from 'vitest';
import { checkAndBlockKillCommand } from '../src/bash-kill-guard.js';
import { checkExecKillCommand } from '../src/exec-kill-guard.js';

/**
 * A kill verb fed by a pipeline takes its targets from the pipe:
 * `Get-Process <runtime> | Stop-Process -Force` terminates every process the
 * selector matched, including this agent, while the verb itself names no PID.
 * The parsers only see the verb, so the target set came back empty and the guard
 * failed open on both layers. Each layer now resolves the upstream selector and
 * maps it onto the existing runtime/protected decision.
 *
 * The runtime image is read from `process.execPath` (not hard-coded): the same
 * suite runs under node and bun, and only the running image is the protected one.
 */
const currentImage = (process.execPath.split(/[\\/]/).pop() ?? '')
  .toLowerCase()
  .replace(/\.exe$/, '');

describe('bash/pwsh layer blocks pipeline-fed kills (Layer 1)', () => {
  it('blocks Stop-Process fed by a selector for this runtime', async () => {
    const result = await checkAndBlockKillCommand(
      `Get-Process ${currentImage} | Stop-Process -Force`,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks a wildcard selector that reaches this runtime', async () => {
    expect((await checkAndBlockKillCommand('Get-Process * | Stop-Process')).blocked).toBe(true);
    expect((await checkAndBlockKillCommand('Get-Process bun*,node* | Stop-Process')).blocked).toBe(
      true,
    );
  });

  it('keeps an unrelated selector allowed and other commands untouched', async () => {
    expect(
      (await checkAndBlockKillCommand('Get-Process notepad | Stop-Process -Force')).blocked,
    ).toBe(false);
    expect((await checkAndBlockKillCommand('echo hello')).blocked).toBe(false);
    // An explicit target on the verb keeps using the existing (PID) path.
    expect(
      (await checkAndBlockKillCommand('Get-Process x | Stop-Process -Id 999999')).blocked,
    ).toBe(false);
  });
});

describe('exec layer blocks pipeline-fed kills (Layer 2)', () => {
  it('blocks a -Command payload whose pipeline selects this runtime', async () => {
    const result = await checkExecKillCommand('pwsh', [
      '-NoProfile',
      '-Command',
      `Get-Process ${currentImage} | Stop-Process -Force`,
    ]);
    expect(result.blocked).toBe(true);
  });

  it('blocks the wildcard selector on the exec path too', async () => {
    const result = await checkExecKillCommand('powershell', [
      '-Command',
      'Get-Process * | Stop-Process',
    ]);
    expect(result.blocked).toBe(true);
  });

  it('keeps an unrelated pipeline selector allowed', async () => {
    const result = await checkExecKillCommand('pwsh', [
      '-Command',
      'Get-Process notepad | Stop-Process -Force',
    ]);
    expect(result.blocked).toBe(false);
  });
});
