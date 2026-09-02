import { describe, expect, it } from 'vitest';
import { execCommand } from '../src/exec-command.js';

const NODE = process.execPath;

describe('execCommand — edge branches', () => {
  it('triggers truncated guard when one stream fills the buffer then the other emits', async () => {
    // The child writes to stdout (fills remaining exactly) then stderr (remaining=0).
    // stdout: 100 bytes, remaining=100 → fits exact → bufferedBytes=maxBufferBytes
    // stderr: 1 byte, remaining=0, chunk.length > remaining, remaining > 0 is false
    //   → skip partial append, truncated=true, treeKill called
    const res = await execCommand({
      command: NODE,
      args: [
        '-e',
        "process.stdout.write(Buffer.alloc(100, 'x')); process.stderr.write('y'); setTimeout(() => {}, 30000);",
      ],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: false,
      maxBufferBytes: 100,
    });
    expect(res.truncated).toBe(true);
    // stdout exactly at cap
    expect(res.stdout.length).toBe(100);
    // stderr may or may not have been captured depending on event ordering;
    // if it fired after truncated=true, it's empty. Accept either.
    expect(res.timedOut).toBe(false);
  });

  it('covers truncated guard when truncated is already true from a prior chunk', async () => {
    // Child writes to stdout first (200 bytes overflows maxBufferBytes=100)
    // then stderr (1 byte). If stdout data fires first, it sets truncated=true.
    // Then stderr data event fires appendCapped with truncated=true → line 111.
    const res = await execCommand({
      command: NODE,
      args: [
        '-e',
        "process.stdout.write(Buffer.alloc(200, 'x')); process.stderr.write('y'); setTimeout(() => {}, 30000);",
      ],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: false,
      maxBufferBytes: 100,
    });
    expect(res.truncated).toBe(true);
    expect(res.stdout.length).toBeLessThanOrEqual(100);
    expect(res.timedOut).toBe(false);
  });
});
