/**
 * Regression cover for the scroll-back archive wiring.
 *
 * `onRequestOlderEntries` used to be a stub that dispatched
 * `archiveLoaded` with an empty array, so scrolling past the 150-entry
 * in-memory window silently dead-ended with no error and no entries.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { render } from 'ink-testing-library';
import type React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../src/app-reducer.js';
import { historyArchivePath } from '../src/history-archive.js';
import type { HistoryEntry } from '../src/history-entry.js';
import { useHistoryArchive } from '../src/hooks/use-history-archive.js';
import { Text } from '../src/ink.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-archive-hook-'));
  directories.push(directory);
  return directory;
}

function entriesFrom(first: number, last: number): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (let id = first; id <= last; id++) {
    entries.push({ id, kind: 'info', text: `entry-${id}` } as HistoryEntry);
  }
  return entries;
}

const SESSION_ID = 'session-under-test';

interface HarnessProps {
  entries: HistoryEntry[];
  dispatch: React.Dispatch<Action>;
  sessionsDir: string;
  onReady: (request: () => void) => void;
}

function ArchiveHarness({
  entries,
  dispatch,
  sessionsDir,
  onReady,
}: HarnessProps): React.ReactElement {
  const { onRequestOlderEntries } = useHistoryArchive({
    entries,
    dispatch,
    sessionsDir,
    sessionId: SESSION_ID,
  });
  onReady(onRequestOlderEntries);
  return <Text>archive</Text>;
}

/** Let the async archive open (rm + construct) and any queued writes settle. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 6; pass++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

describe('useHistoryArchive', () => {
  it('serves entries that aged out of the in-memory window', async () => {
    const sessionsDir = await temporaryDirectory();
    const dispatch = vi.fn();
    let request: () => void = () => {};

    // 200 entries pass through the view; the reducer's retention then trims
    // the window to the newest 150, dropping ids 1..50 from memory.
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <ArchiveHarness
          entries={entriesFrom(1, 200)}
          dispatch={dispatch}
          sessionsDir={sessionsDir}
          onReady={(next) => {
            request = next;
          }}
        />,
      );
    });
    await settle();

    act(() => {
      view.rerender(
        <ArchiveHarness
          entries={entriesFrom(51, 200)}
          dispatch={dispatch}
          sessionsDir={sessionsDir}
          onReady={(next) => {
            request = next;
          }}
        />,
      );
    });
    await settle();

    dispatch.mockClear();
    await act(async () => {
      request();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    const loaded = dispatch.mock.calls
      .map(([action]) => action as { type: string; entries?: HistoryEntry[] })
      .find((action) => action.type === 'archiveLoaded');
    expect(loaded?.entries?.length).toBe(50);
    expect(loaded?.entries?.[0]?.id).toBe(1);
    expect(loaded?.entries?.at(-1)?.id).toBe(50);

    act(() => view.unmount());
  });

  it('settles the loading flag without entries once the archive is exhausted', async () => {
    const sessionsDir = await temporaryDirectory();
    const dispatch = vi.fn();
    let request: () => void = () => {};

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <ArchiveHarness
          entries={entriesFrom(1, 5)}
          dispatch={dispatch}
          sessionsDir={sessionsDir}
          onReady={(next) => {
            request = next;
          }}
        />,
      );
    });
    await settle();

    // Everything written is still on screen, so there is nothing older to
    // fetch — the scroll controller still needs the start/loaded pair or it
    // will never fire again.
    dispatch.mockClear();
    await act(async () => {
      request();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    const types = dispatch.mock.calls.map(([action]) => (action as { type: string }).type);
    expect(types).toContain('startArchiveLoad');
    expect(types).toContain('archiveLoaded');

    act(() => view.unmount());
  });

  it('starts each run from a clean archive file', async () => {
    const sessionsDir = await temporaryDirectory();
    const archiveFile = historyArchivePath(path.join(sessionsDir, SESSION_ID));
    await fs.mkdir(path.dirname(archiveFile), { recursive: true });
    // A previous run's lines: ids restart at 1 on resume, so keeping these
    // would collide with live ids and render duplicate rows.
    await fs.writeFile(archiveFile, `${JSON.stringify({ id: 1, kind: 'info', text: 'stale' })}\n`);

    const dispatch = vi.fn();
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <ArchiveHarness
          entries={entriesFrom(1, 3)}
          dispatch={dispatch}
          sessionsDir={sessionsDir}
          onReady={() => {}}
        />,
      );
    });
    await settle();

    const written = await fs.readFile(archiveFile, 'utf8');
    const lines = written.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes('stale'))).toBe(false);

    act(() => view.unmount());
  });
});
