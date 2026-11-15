import { describe, expect, it, vi } from 'vitest';

let mode: 'valid' | 'malformed' = 'valid';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      queueMicrotask(() => {
        if (mode === 'valid') {
          cb(null, '[{"ProcessId":999999,"CommandLine":"node unrelated.js"}]', '');
        } else {
          cb(null, 'WARNING: PowerShell profile\n{broken json', '');
        }
      });
    },
  };
});

import { reapProcessesUnder } from '../src/sandbox-reaper.js';

describe('sandbox-reaper malformed output handling', () => {
  it('returns 0 cleanly when powershell stdout is malformed JSON', async () => {
    mode = 'valid';
    expect(await reapProcessesUnder(['D:/nonexistent-root'])).toBe(0);

    mode = 'malformed';
    await expect(reapProcessesUnder(['D:/nonexistent-root'])).resolves.toBe(0);
  });
});
