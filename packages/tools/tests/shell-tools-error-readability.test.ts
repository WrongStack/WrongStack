import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodePowerShellClixml } from '../src/_pwsh-clixml.js';
import { normalizeCommandOutput } from '../src/_util.js';
import { execTool } from '../src/exec.js';
import { pwshTool } from '../src/pwsh.js';
import { mkSandbox, type Sandbox } from './fixtures.js';

/** Captured from `pwsh -NonInteractive -EncodedCommand` (7.x) on Windows. */
const PWSH7_ERROR =
  '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
  '<S S="Error">_x001B_[31;1mWrite-Error: _x001B_[31;1mbad &lt;thing&gt;_x001B_[0m_x000D__x000A_</S></Objs>';

/** Windows PowerShell 5.1 adds a progress record before the error. */
const PS51_ERROR =
  '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
  '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN>' +
  '<MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj>' +
  '<S S="Error">boom : bad_x000D__x000A_</S>' +
  '<S S="warning">careful_x000D__x000A_</S></Objs>';

describe('PowerShell CLIXML error streams are decoded to text', () => {
  it('decodes a pwsh 7 error record, escapes and entities', () => {
    expect(normalizeCommandOutput(`hi\n${PWSH7_ERROR}`)).toBe('hi\nWrite-Error: bad <thing>\n');
  });

  it('drops 5.1 progress records and keeps the stream prefix of warnings', () => {
    expect(decodePowerShellClixml(PS51_ERROR)).toBe('boom : bad\r\nWARNING: careful\r\n');
  });

  it('leaves output without the marker untouched', () => {
    const text = '<S S="Error">not clixml</S>';
    expect(decodePowerShellClixml(text)).toBe(text);
  });
});

const hasPwsh =
  process.platform === 'win32' && spawnSync('pwsh.exe', ['-v'], { windowsHide: true }).status === 0;

describe('shell tools name a bad working directory', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('exec refuses a missing cwd instead of reporting the binary as missing', async () => {
    const err = await execTool
      .execute({ command: 'node', args: ['-v'], cwd: 'no-such-dir' }, sb.ctx)
      .then(
        () => undefined,
        (e: Error) => e,
      );
    expect(err?.message).toBe('exec: cwd "no-such-dir" does not exist');
  });

  it.skipIf(!hasPwsh)('pwsh refuses a missing workdir', async () => {
    const run = async () => {
      for await (const _ of pwshTool.executeStream!(
        { command: 'Get-Location', workdir: 'no-such-dir' },
        sb.ctx,
      )) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow('pwsh: workdir "no-such-dir" does not exist');
  });

  it.skipIf(!hasPwsh)('pwsh reports Write-Error as plain text', async () => {
    const out = await pwshTool.execute(
      { command: 'Write-Output hi; Write-Error "bad thing"' },
      sb.ctx,
    );
    const text = JSON.stringify(out);
    expect(text).toContain('bad thing');
    expect(text).not.toContain('CLIXML');
    expect(text).not.toContain('_x001B_');
  });
});
