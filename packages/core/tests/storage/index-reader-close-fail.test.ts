// Dedicated test for the readFileRange close() catch callback that can't be
// reached with a real filesystem handle. Uses a module mock to make close()
// reject.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const closeMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn().mockResolvedValue({
      read: vi.fn().mockResolvedValue({ bytesRead: 1 }),
      close: closeMock,
    }),
  };
});

import { readFileRange } from '../../src/storage/session-store/index-reader.js';

describe('readFileRange — close() failure path', () => {
  beforeEach(() => {
    closeMock.mockReset();
    vi.mocked(readFileRange);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('swallows a close() rejection and still returns the parsed result', async () => {
    closeMock.mockRejectedValue(new Error('EBADF'));
    // open returns a handle whose read never advances (bytesRead:1 but offset
    // grows, so the loop ends). The key assertion is that close() rejection
    // does not escape the finally block.
    const result = await readFileRange('fake.jsonl', 0, 100);
    expect(result).not.toBeNull();
    expect(closeMock).toHaveBeenCalled();
  });
});
