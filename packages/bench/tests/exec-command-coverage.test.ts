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

  it('walks back cut index when maxBufferBytes lands on a UTF-8 continuation byte', async () => {
    // 0x78 ('x') + 0xE2 0x82 0xAC ('€'). With maxBufferBytes=2, lands on 0x82.
    // The loop decrements cut back to 1.
    const res = await execCommand({
      command: NODE,
      args: [
        '-e',
        'process.stdout.write(Buffer.from([0x78, 0xe2, 0x82, 0xac])); setTimeout(() => {}, 30000);',
      ],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: false,
      maxBufferBytes: 2,
    });
    expect(res.truncated).toBe(true);
    expect(res.stdout).toBe('x');
  });
});
