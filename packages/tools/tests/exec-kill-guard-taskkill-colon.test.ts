import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkExecKillCommand } from '../src/exec-kill-guard.js';

const describeWin = process.platform === 'win32' ? describe : describe.skip;

describeWin('checkExecKillCommand taskkill colon-attached /IM and /FI (F939)', () => {
  const selfImage = path.basename(process.execPath);

  it('blocks colon-attached /IM and -IM targeting the current runtime image', async () => {
    expect((await checkExecKillCommand('taskkill', ['/F', `/IM:${selfImage}`])).blocked).toBe(true);
    expect((await checkExecKillCommand('taskkill', ['/F', `-IM:${selfImage}`])).blocked).toBe(true);
  });

  it('blocks colon-attached /FI PID and IMAGENAME filters targeting protected processes', async () => {
    expect(
      (await checkExecKillCommand('taskkill', ['/F', `/FI:PID eq ${process.pid}`])).blocked,
    ).toBe(true);
    expect(
      (await checkExecKillCommand('taskkill', ['/F', `-FI:IMAGENAME eq ${selfImage}`])).blocked,
    ).toBe(true);
    expect((await checkExecKillCommand('taskkill', ['/F', '/FI:PID ge 1'])).blocked).toBe(true);
  });

  it('keeps benign colon-attached image targets allowed', async () => {
    expect((await checkExecKillCommand('taskkill', ['/F', '/IM:notepad.exe'])).blocked).toBe(false);
  });
});
