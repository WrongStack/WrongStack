import type { Logger } from '@wrongstack/contracts/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ stat: vi.fn(), readFile: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  ...files,
}));

import { DocumentTracker } from '../../src/document-tracker.js';

function setup() {
  const events: string[] = [];
  const openUris = new Set<string>();
  const server = {
    name: 'ts',
    state: 'ready' as const,
    config: { languages: ['typescript'] },
    hasOpenDocument: (uri: string) => openUris.has(uri),
    notifyDidOpen: (doc: { uri: string; version: number; text: string }) => {
      openUris.add(doc.uri);
      events.push(`didOpen:${doc.version}:${doc.text}`);
    },
    notifyDidChange: (doc: { uri: string; version: number }, text: string) => {
      events.push(`didChange:${doc.version}:${text}`);
    },
    notifyDidClose: vi.fn(),
  };
  const tracker = new DocumentTracker(
    () => ({ list: () => [server as never] }),
    { debug: vi.fn() } as unknown as Logger,
    process.cwd(),
  );
  return { tracker, events };
}

beforeEach(() => {
  files.stat.mockReset().mockResolvedValue({ isFile: () => true, size: 1 });
  files.readFile.mockReset();
});

describe('document tracker operation fence', () => {
  it('a re-open with the already-tracked text does not drop an in-flight write read (F1053)', async () => {
    const { tracker, events } = setup();
    expect(await tracker.open('edited.ts', 'before')).toBe(true);

    // tool.executed after an edit: fileWritten reads the new disk content.
    let release!: (text: string) => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    files.readFile.mockImplementationOnce(() => {
      entered();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const written = tracker.fileWritten('edited.ts');
    await reading;

    // An LSP tool re-opens with the tracker's own (still pre-edit) text.
    expect(await tracker.open('edited.ts', tracker.get('edited.ts')!.text)).toBe(true);

    release('after');
    await written;
    expect(tracker.get('edited.ts')?.text).toBe('after');
    expect(events).toEqual(['didOpen:1:before', 'didChange:2:after']);
  });

  it('a re-open with different text still supersedes an older in-flight read', async () => {
    const { tracker, events } = setup();
    expect(await tracker.open('buffer.ts', 'before')).toBe(true);
    let release!: (text: string) => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    files.readFile.mockImplementationOnce(() => {
      entered();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const written = tracker.fileWritten('buffer.ts');
    await reading;
    expect(await tracker.open('buffer.ts', 'unsaved buffer')).toBe(true);
    release('stale disk read');
    await written;
    expect(tracker.get('buffer.ts')?.text).toBe('unsaved buffer');
    expect(events).toEqual(['didOpen:1:before', 'didChange:2:unsaved buffer']);
  });
});
