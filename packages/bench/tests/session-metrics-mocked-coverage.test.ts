import type { Dirent } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => fsMock);

import { readSessionLogEvents } from '../src/session-metrics.js';

function entry(name: string, kind: 'file' | 'directory'): Dirent {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
  } as Dirent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('session metrics mocked filesystem races', () => {
  it('returns no events when the selected JSONL cannot be read', async () => {
    fsMock.readdir.mockResolvedValue([entry('session.jsonl', 'file')]);
    fsMock.stat.mockResolvedValue({ isFile: () => true, mtimeMs: 10 });
    fsMock.readFile.mockRejectedValue(new Error('unreadable'));

    await expect(readSessionLogEvents({ homeDir: '/home', workdir: '/work' })).resolves.toEqual([]);
  });

  it('skips a shard that becomes unreadable', async () => {
    fsMock.readdir
      .mockResolvedValueOnce([entry('2026-07-24', 'directory')])
      .mockRejectedValueOnce(new Error('gone'));

    await expect(readSessionLogEvents({ homeDir: '/home', workdir: '/work' })).resolves.toEqual([]);
  });

  it('ignores non-JSONL children inside a shard', async () => {
    fsMock.readdir
      .mockResolvedValueOnce([entry('2026-07-24', 'directory')])
      .mockResolvedValueOnce([entry('notes.txt', 'file')]);

    await expect(readSessionLogEvents({ homeDir: '/home', workdir: '/work' })).resolves.toEqual([]);
    expect(fsMock.stat).not.toHaveBeenCalled();
  });
});
