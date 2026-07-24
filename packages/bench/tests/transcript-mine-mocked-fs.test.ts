import { describe, expect, it, vi } from 'vitest';

const readFile = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile };
});

import { mineTranscript } from '../src/transcript-mine.js';

describe('transcript miner non-Error filesystem failure', () => {
  it('stringifies a non-Error transcript read rejection', async () => {
    readFile.mockRejectedValue('plain failure');

    await expect(
      mineTranscript({ transcriptPath: '/missing.jsonl', outDir: '/output' }),
    ).rejects.toThrow('plain failure');
  });
});
